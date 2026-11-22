import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, type PDFDocument } from 'pdf-lib';
import type { Color, Matrix, PageModel, Rect, Table } from '@pdf-toolkit/shared';
import { applyPatch, emptyPatch, type ParsedContent } from '../content/parser.ts';
import { pageContentBytes } from '../model/extract.ts';
import { FontCache, interpretPage, type ImageItem, type RunInternal } from '../model/interpreter.ts';
import { apply, mul, rectFromPoints } from '../math.ts';
import { headerRowsOf, roleStrokes } from '../model/tablePattern.ts';
import { removalOp } from './apply.ts';
import { fillOp } from './raster.ts';

type Span = { y0: number; y1: number };
/**
 * A painted element of a page: `y0`/`y1` where the edited page draws it, `orig` where it was before
 * the reflow under tables (absent: new content). `pushed`: moved by a table's growth (or a table row
 * that did), the only content that may leave its page. `tableId`/`row`: a table row (or merged cell).
 * `pageNumber`: a text box that reads like a page number, with its horizontal extent.
 */
export type FlowUnit = Span & { orig?: Span; table?: boolean; pushed?: boolean; tableId?: string; row?: number; pageNumber?: { text: string; x0: number; x1: number } };
export type FlowPage = {
  view: Rect;
  units: FlowUnit[];
  /** Header-row bands of the page's tables (those with header rows and body rows under them). */
  headers?: Record<string, Span>;
  /** Top edge of the page's tables (see tableTop). */
  tops?: Record<string, TableTop>;
  /** Scanned page with a measured layout: uncovered areas get the paper colour. */
  paper?: Color;
};
/**
 * The edited page `src`, clipped to its band `y0..y1` and translated by `dy`. `repeat`: the header rows
 * of that table, repeated over its continued part. `omit`: areas whose text is left out (page numbers).
 * `edge`: that table's top edge (only its width), drawn over the top of a continued part without a header.
 */
export type FlowDraw = Span & { src: number; dy: number; repeat?: string; omit?: Rect[]; edge?: { tableId: string; x0: number; x1: number } };
export type PagePlan = {
  draws: FlowDraw[];
  /** Areas (in this page's coordinates) holding content of earlier pages. */
  flowIn: Rect[];
  paper?: Color;
};
export type FlowPlan = {
  /** One per page, original pages first; undefined = the page stays as it is. */
  pages: (PagePlan | undefined)[];
  /** Original page whose header/footer bands the added pages copy (or undefined for empty pages). */
  template?: number;
  added: number;
  /**
   * Content left past the body bottom of the last page (no new pages allowed, or a block taller than
   * the body); `pageNumber`: page-number text in the last page's header/footer, which a copy page repeats.
   */
  overflow?: { pageIndex: number; by: number; pageNumber?: string };
  /** Tables cut by the flow: `pageIndex` is the first page of the continued part. */
  splits: { tableId: string; pageIndex: number }[];
};

export type FlowOptions = {
  /** Tables whose header rows are repeated over every continued part. */
  repeat?: Set<string>;
  /** Page-number texts of the copied header/footer bands on added pages. */
  pageNumbers?: 'keep' | 'omit';
};

const HEADER_ZONE = 0.12;
const BAND_GAP = 12;
const MAX_MARGIN = 72;
const MAX_GAP = 24;
const EPS = 0.5;

type TableRef = { tableId?: string; row?: number };

/**
 * A table's top edge line at `y`, painted within `ext` of it (the border, or the thicker row line, with
 * room for antialiasing or a scan's blur), across `x0..x1`.
 */
export type TableTop = { y: number; ext: number; x0: number; x1: number };

export function tableTop(t: Table): TableTop | undefined {
  const bw = t.setup?.borderWidth ?? 0;
  const strokes = t.pattern && (['outerTop', 'bodyRow', 'headerSeparator'] as const).flatMap((r) => roleStrokes(t.pattern!, r));
  const ext = t.setup?.origin === 'raster' ? bw / 2 + Math.max(1, bw / 2) : strokes ? Math.max(0, ...strokes.map((s) => Math.abs(s.offset) + s.width / 2)) + 0.5 : undefined;
  if (ext === undefined || !t.rows.length) return undefined;
  return { y: t.rows[0]!.y1, ext, x0: t.bbox.x0 - ext, x1: t.bbox.x1 + ext };
}
const clusters = (spans: (Span & TableRef & { table?: boolean; pushed?: boolean })[]) => {
  const out: (Span & TableRef & { table: boolean; pushed: boolean })[] = [];
  for (const s of [...spans].sort((a, b) => b.y1 - a.y1)) {
    const last = out.at(-1);
    if (last && s.y1 > last.y0 + EPS) {
      last.y0 = Math.min(last.y0, s.y0);
      last.table ||= !!s.table;
      last.pushed ||= !!s.pushed;
      if (s.tableId !== undefined && (last.tableId === undefined || s.row! < last.row!)) [last.tableId, last.row] = [s.tableId, s.row];
    } else out.push({ y0: s.y0, y1: s.y1, table: !!s.table, pushed: !!s.pushed, ...(s.tableId !== undefined && { tableId: s.tableId, row: s.row }) });
  }
  return out;
};

/**
 * Header and footer bands from the original positions: the clusters above (below) the widest gap of
 * at least BAND_GAP that lies in the top (bottom) HEADER_ZONE of the page. Tables are never bands.
 */
export function pageBands(view: Rect, units: FlowUnit[]): { header?: Span; footer?: Span } {
  const cs = clusters(units.flatMap((u) => (u.orig ? [{ ...u.orig, table: u.table }] : [])));
  const zone = (view.y1 - view.y0) * HEADER_ZONE;
  const pick = (list: typeof cs, inZone: (c: Span) => boolean, gapAfter: (i: number) => number) => {
    let best = -1;
    let bestGap = BAND_GAP;
    for (let i = 0; i < list.length - 1 && inZone(list[i]!) && !list[i]!.table; i++) {
      if (gapAfter(i) >= bestGap) [best, bestGap] = [i, gapAfter(i)];
    }
    return best < 0 ? undefined : { y0: Math.min(...list.slice(0, best + 1).map((c) => c.y0)), y1: Math.max(...list.slice(0, best + 1).map((c) => c.y1)) };
  };
  const header = pick(cs, (c) => c.y0 >= view.y1 - zone, (i) => cs[i]!.y0 - cs[i + 1]!.y1);
  const up = [...cs].reverse();
  const footer = pick(up, (c) => c.y1 <= view.y0 + zone, (i) => up[i + 1]!.y0 - up[i]!.y1);
  return { ...(header && { header }), ...(footer && { footer }) };
}

/** `repeat`: a copy of a table's header rows over its continued part (not content of its own). */
/** `edge`: the first row of a continued part without a header, which gets its table's top edge. */
type Cluster = Span & TableRef & { src: number; table: boolean; pushed: boolean; gapAbove: number; repeat?: string; edge?: TableTop };

/**
 * Lays the body content of every page out again: content pushed past a page's body bottom continues
 * at the top of the next page's body, whose own body moves down by as much and overflows in turn.
 * Past the last page, `newPages` decides whether pages are added. Cuts fall between clusters of
 * overlapping elements (table rows are separate clusters), so nothing is split. A table cut this way
 * repeats its header rows at the top of the continued part when `opts.repeat` has it.
 */
export function planFlow(pages: FlowPage[], newPages: 'copy' | 'empty' | undefined, opts: FlowOptions = {}): FlowPlan {
  const info = pages.map((p) => {
    const { header, footer } = pageBands(p.view, p.units);
    const kind = (u: FlowUnit) => (u.orig && !u.table && header && u.orig.y0 >= header.y0 - EPS ? 'header' : u.orig && !u.table && footer && u.orig.y1 <= footer.y1 + EPS ? 'footer' : 'body');
    const body = p.units.filter((u) => kind(u) === 'body');
    const fixed = p.units.flatMap((u) => (kind(u) === 'body' ? [] : [{ ...u, band: kind(u) }]));
    const own = clusters(body).map((c, i, list) => ({ ...c, gapAbove: i ? list[i - 1]!.y0 - c.y1 : 0 }));
    const origBody = body.flatMap((u) => (u.orig ? [u.orig] : []));
    return { p, header, footer, fixed, own, origTop: Math.max(...origBody.map((s) => s.y1)), origBottom: Math.min(...origBody.map((s) => s.y0)) };
  });
  const margin = (f: (i: (typeof info)[number]) => number) => Math.max(0, Math.min(MAX_MARGIN, ...info.map(f).filter(Number.isFinite)));
  const topMargin = Math.max(0, Math.min(...info.map((i) => i.p.view.y1 - i.origTop).filter(Number.isFinite)));
  const bottomMargin = margin((i) => i.origBottom - i.p.view.y0);
  const limits = (i: (typeof info)[number] | undefined, view: Rect) => ({
    top: Number.isFinite(i?.origTop) ? i!.origTop : i?.header ? i.header.y0 - BAND_GAP : view.y1 - topMargin,
    bottom: Math.min(i?.footer ? i.footer.y1 + BAND_GAP : view.y0 + bottomMargin, i?.origBottom ?? Infinity),
  });

  const plans: (PagePlan | undefined)[] = [];
  let queue: Cluster[] = [];
  let carryGap = 0;
  let overflow: FlowPlan['overflow'];
  const splits: FlowPlan['splits'] = [];
  const last = info.length - 1;
  for (let k = 0; k < info.length || (queue.length && newPages); k++) {
    const added = k > last;
    const i = added ? undefined : info[k]!;
    const view = (i ?? info[last]!).p.view;
    // An added copy page starts its body where the last page's did.
    const lim = limits(i ?? (newPages === 'copy' ? { ...info[last]!, origBottom: Infinity } : undefined), view);
    const items: Cluster[] = [...queue, ...(i?.own.map((c) => ({ ...c, src: k })) ?? [])];
    const incoming = queue.length;
    const placed: (Cluster & { dy: number })[] = [];
    const out: Cluster[] = [];
    let cursor = Infinity;
    items.forEach((c, n) => {
      if (out.length) return void out.push(c);
      const gap = n === 0 ? 0 : n === incoming ? carryGap : c.gapAbove;
      const top = n < incoming ? (n === 0 ? lim.top : cursor - gap) : Math.min(c.y1, cursor - gap);
      const dy = top - c.y1;
      // Only pushed content leaves (not what the user placed low); a block that doesn't fit an empty body stays.
      const mobile = n < incoming || c.pushed || Math.abs(dy) > 0.01;
      if (mobile && c.y0 + dy < lim.bottom - 0.05 && placed.length && !(k === last && !newPages)) {
        out.push({ ...c, pushed: true });
        return;
      }
      placed.push({ ...c, dy });
      cursor = c.y0 + dy;
    });
    const cutTable = out[0]?.tableId;
    if (cutTable !== undefined && !out[0]!.repeat) {
      // Header rows (the table's own or a repeated copy) with no row of their table under them go along with the rows.
      const isHeader = (c: Cluster) => {
        const h = pages[c.src]!.headers?.[cutTable];
        return c.tableId === cutTable && (c.repeat === cutTable || (!!h && c.y0 >= h.y0 - EPS && c.y1 <= h.y1 + EPS));
      };
      while (placed.length > 1 && isHeader(placed.at(-1)!)) {
        const { dy: _, ...c } = placed.pop()!;
        out.unshift({ ...c, pushed: true });
      }
      if (placed.some((c) => c.tableId === cutTable && !c.repeat) && !splits.some((s) => s.tableId === cutTable)) splits.push({ tableId: cutTable, pageIndex: k + 1 });
    }
    const lowest = Math.min(...placed.filter((c) => c.src !== k || c.pushed || Math.abs(c.dy) > 0.01).map((c) => c.y0 + c.dy));
    if (k === last && !newPages && lowest < lim.bottom - 0.05) {
      const pageNumber = info[last]!.fixed.find((u) => u.pageNumber)?.pageNumber?.text;
      overflow = { pageIndex: k, by: Math.round((lim.bottom - lowest) * 10) / 10, ...(pageNumber && { pageNumber }) };
    }
    const moved = placed.filter((c) => c.src !== k || Math.abs(c.dy) > 0.01);
    const fixedMoved = i?.fixed.some((u) => Math.abs(u.orig!.y1 - u.y1) > 0.01) ?? false;
    if (!added && !moved.length && !out.length && !fixedMoved) {
      plans.push(undefined);
    } else {
      plans.push(pagePlan(k, i, placed, out, added && newPages === 'copy' ? info[last]! : undefined, last, opts));
    }
    carryGap = out.length ? Math.min(MAX_GAP, Math.max(0, out[0]!.gapAbove)) : 0;
    const head = out[0];
    const band = head?.tableId !== undefined && !head.repeat && opts.repeat?.has(head.tableId) ? pages[head.src]!.headers?.[head.tableId] : undefined;
    if (band && head!.y1 <= band.y0 + EPS) out.unshift({ ...band, src: head!.src, table: true, pushed: true, gapAbove: 0, repeat: head!.tableId });
    else if (head?.tableId !== undefined && !head.repeat) {
      // Without a header, the continued part starts with its table's top edge instead of the row line it had.
      const top = pages[head.src]!.tops?.[head.tableId];
      if (top && head.y1 < top.y - EPS) out[0] = { ...head, edge: top };
    }
    queue = out.map((c, n) => (n === 0 ? { ...c, gapAbove: 0 } : c));
  }
  return { pages: plans, ...(newPages === 'copy' && plans.length > info.length && { template: last }), added: Math.max(0, plans.length - info.length), ...(overflow && { overflow }), splits };
}

type Info = { p: FlowPage; fixed: (FlowUnit & { band: string })[] };

function pagePlan(k: number, i: Info | undefined, placed: (Cluster & { dy: number })[], out: Cluster[], template: Info | undefined, last: number, opts: FlowOptions): PagePlan {
  const draws: FlowDraw[] = [];
  const push = (d: FlowDraw) => {
    const prev = draws.at(-1);
    // Consecutive clusters of one source with one shift: the gap between them holds nothing else of that source.
    if (prev && !prev.repeat && !d.repeat && !prev.edge && prev.src === d.src && Math.abs(prev.dy - d.dy) < 1e-6 && prev.y0 >= d.y0) prev.y0 = Math.min(prev.y0, d.y0);
    else draws.push(d);
  };
  const all = [...placed, ...out];
  const pad = (c: Cluster, idx: number) => {
    // Table rows share their border line with the next row, so both sides draw it.
    if (c.table) return 1.5;
    const nb = [all[idx - 1], all[idx + 1]].filter((x): x is Cluster => !!x && x.src === c.src);
    const gaps = nb.map((x) => (x.y0 > c.y1 ? x.y0 - c.y1 : c.y0 - x.y1));
    return Math.max(0, Math.min(2, ...gaps.map((g) => g / 2)));
  };
  const firstMoved = placed.findIndex((c) => c.src !== k || Math.abs(c.dy) > 0.01);
  const cut = firstMoved >= 0 ? placed[firstMoved]! : out[0];
  // Edits keep a box's top, so a band unit moved by a reflow is told apart by its top edge.
  const shifted = (u: FlowUnit) => Math.abs(u.orig!.y1 - u.y1) > 0.01;
  // Everything above the first moved block stays where it is, whitespace and backgrounds included.
  // Without one, only footer bands moved by the reflow below a table go back to their place.
  let stTop: number | undefined;
  if (i && !cut) stTop = Math.max(-1e5, ...i.fixed.filter(shifted).map((u) => u.y1 + 1));
  else if (i && cut!.src === k) stTop = cut!.y1 + pad(cut!, all.indexOf(cut!));
  if (stTop !== undefined) draws.push({ src: k, y0: stTop, y1: 1e5, dy: 0 });
  const flowIn: Rect[] = [];
  const view = (i ?? template)?.p.view;
  placed.forEach((c, idx) => {
    if (c.src === k && Math.abs(c.dy) < 0.01 && stTop !== undefined && c.y0 >= stTop - 2) return;
    const p = pad(c, idx);
    if (c.edge) {
      const e = c.edge;
      push({ src: c.src, y0: c.y0 - p, y1: c.y1 - e.ext, dy: c.dy });
      draws.push({ src: c.src, y0: e.y - e.ext, y1: e.y + e.ext, dy: c.y1 + c.dy - e.y, edge: { tableId: c.tableId!, x0: e.x0, x1: e.x1 } });
    } else push({ src: c.src, y0: c.y0 - p, y1: c.y1 + p, dy: c.dy, ...(c.repeat && { repeat: c.repeat }) });
    if (c.src !== k && view) flowIn.push({ x0: view.x0, x1: view.x1, y0: c.y0 + c.dy, y1: c.y1 + c.dy });
  });
  const fixedSrc = template ? last : k;
  // Header and footer are drawn as whole bands (one per band and shift); nothing else lies inside them.
  const bands = new Map<string, FlowDraw>();
  const omit: Rect[] = [];
  for (const u of (template ?? i)?.fixed ?? []) {
    if (!template && stTop !== undefined && !shifted(u) && u.y0 >= stTop - EPS) continue;
    if (template && u.pageNumber && opts.pageNumbers === 'omit') {
      omit.push({ x0: u.pageNumber.x0, x1: u.pageNumber.x1, y0: u.y0, y1: u.y1 });
      continue;
    }
    const dy = u.orig!.y1 - u.y1;
    const key = `${u.band}|${dy.toFixed(3)}`;
    const b = bands.get(key);
    if (b) [b.y0, b.y1] = [Math.min(b.y0, u.y0 - 1), Math.max(b.y1, u.y1 + 1)];
    else bands.set(key, { src: fixedSrc, y0: u.y0 - 1, y1: u.y1 + 1, dy });
  }
  draws.push(...[...bands.values()].map((b) => (omit.length ? { ...b, omit } : b)));
  const mergedIn = flowIn.length ? [{ ...flowIn[0]!, y0: Math.min(...flowIn.map((r) => r.y0)), y1: Math.max(...flowIn.map((r) => r.y1)) }] : [];
  const paper = (i ?? template)?.p.paper;
  return { draws, flowIn: mergedIn, ...(paper && { paper }) };
}

const n = (v: number) => String(Math.round(v * 1000) / 1000);

/** Area each image draw of a stream can paint: its box within the clipping rectangles set before it (op index → rect). */
function paintedImages(content: ParsedContent, images: ImageItem[]): Map<number, Rect> {
  const boxes = new Map(images.map((im) => [im.opIndex, im.bbox]));
  const out = new Map<number, Rect>();
  type State = { ctm: Matrix; clip: Rect | null };
  let st: State = { ctm: [1, 0, 0, 1, 0, 0], clip: null };
  const stack: State[] = [];
  let pending: Rect | null = null;
  let clipNext = false;
  content.ops.forEach((op, i) => {
    const nums = op.operands.map((o) => (o.t === 'num' ? o.v : NaN));
    switch (op.op) {
      case 'q':
        stack.push(st);
        break;
      case 'Q':
        st = stack.pop() ?? st;
        break;
      case 'cm':
        if (nums.length === 6 && nums.every(Number.isFinite)) st = { ...st, ctm: mul(nums as Matrix, st.ctm) };
        break;
      case 're': {
        const [x, y, w, h] = nums as [number, number, number, number];
        pending = rectFromPoints([apply(st.ctm, x, y), apply(st.ctm, x + w, y), apply(st.ctm, x, y + h), apply(st.ctm, x + w, y + h)]);
        break;
      }
      case 'W':
      case 'W*':
        clipNext = true;
        break;
      case 'n':
      case 'f':
      case 'f*':
      case 'S':
      case 'B':
      case 'B*':
        if (clipNext && pending) st = { ...st, clip: st.clip ? intersectRect(st.clip, pending) : pending };
        clipNext = false;
        pending = null;
        break;
      case 'Do': {
        const b = boxes.get(i);
        if (b) out.set(i, st.clip ? intersectRect(st.clip, b) : b);
        break;
      }
    }
  });
  return out;
}

const intersectRect = (a: Rect, b: Rect): Rect => {
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return r.x0 > r.x1 || r.y0 > r.y1 ? { x0: r.x0, x1: r.x0, y0: r.y0, y1: r.y0 } : r;
};

/**
 * Writes the plan: each page that takes part becomes a Form XObject of its edited content, and the
 * pages draw clipped, translated bands of those forms. Added pages go after the last page, with the
 * last page's size and rotation.
 */
export function writeFlow(doc: PDFDocument, plan: FlowPlan): void {
  const ctx = doc.context;
  const srcPages = doc.getPages();
  const fonts = new FontCache();
  const parsed = new Map<number, { bytes: Uint8Array; content: ParsedContent; runs: RunInternal[]; images: Map<number, Rect> }>();
  const forms = new Map<string, PDFRef>();
  // One form per drawn band: text outside the band is removed (clipping hides it, but text extraction
  // would still find it); its advances stay, so the rest of the line keeps its place.
  const formOf = (src: number, y0: number, y1: number, omit: Rect[] = [], xs?: { x0: number; x1: number }) => {
    const key = `${src}|${y0}|${y1}|${JSON.stringify(omit)}|${xs ? `${xs.x0},${xs.x1}` : ''}`;
    let ref = forms.get(key);
    if (ref) return ref;
    const page = srcPages[src]!;
    let p = parsed.get(src);
    if (!p) {
      const bytes = pageContentBytes(page);
      const interp = interpretPage(ctx, src, bytes, page.node.Resources(), fonts);
      const content = interp.streams.get(`page:${src}`)!.content;
      p = { bytes, content, runs: interp.runs.filter((r) => r.streamId === `page:${src}`), images: paintedImages(content, interp.images.filter((im) => im.streamId === `page:${src}`)) };
      parsed.set(src, p);
    }
    const patch = emptyPatch();
    for (const r of p.runs) {
      const mid = (r.bbox.y0 + r.bbox.y1) / 2;
      const cx = (r.bbox.x0 + r.bbox.x1) / 2;
      if (mid < y0 || mid > y1 || (xs && (cx < xs.x0 || cx > xs.x1)) || omit.some((o) => cx >= o.x0 && cx <= o.x1 && mid >= o.y0 && mid <= o.y1)) patch.replace.set(r.opIndex, removalOp(r));
    }
    // Scans are redrawn as many image draws; drawing those outside the band too slows rendering.
    for (const [i, b] of p.images) if (b.y1 < y0 || b.y0 > y1) patch.replace.set(i, '');
    const mb = page.getMediaBox();
    // Content pushed below the page (virtual positions) must stay inside the form's clip.
    const dict = { Type: 'XObject', Subtype: 'Form', BBox: [mb.x - 1e4, mb.y - 1e5, mb.x + mb.width + 1e4, mb.y + mb.height + 1e4] };
    const stream = ctx.flateStream(patch.replace.size ? applyPatch(p.content, patch) : p.bytes, dict);
    const res = page.node.Resources();
    if (res) stream.dict.set(PDFName.of('Resources'), res);
    ref = ctx.register(stream);
    forms.set(key, ref);
    return ref;
  };
  const lastPage = srcPages[srcPages.length - 1]!;
  // Every source is read before any page is rewritten.
  for (const pp of plan.pages) for (const d of pp?.draws ?? []) formOf(d.src, d.y0, d.y1, d.omit, d.edge);
  plan.pages.forEach((pp, k) => {
    if (!pp) return;
    const page = k < srcPages.length ? srcPages[k]! : null;
    const xobjects = ctx.obj({}) as PDFDict;
    const parts: string[] = [];
    const target = page ?? lastPage;
    const mb = target.getMediaBox();
    const [x0, x1] = [mb.x - 10, mb.x + mb.width + 10];
    if (pp.paper) parts.push(`q ${fillOp(pp.paper)} ${n(mb.x)} ${n(mb.y)} ${n(mb.width)} ${n(mb.height)} re f Q`);
    pp.draws.forEach((d, i) => {
      const name = `PTF${i}`;
      xobjects.set(PDFName.of(name), formOf(d.src, d.y0, d.y1, d.omit, d.edge));
      const y0 = Math.max(d.y0, -1e4) + d.dy;
      const y1 = Math.min(d.y1, 1e4) + d.dy;
      const [cx0, cx1] = d.edge ? [d.edge.x0, d.edge.x1] : [x0, x1];
      parts.push(`q ${n(cx0)} ${n(y0)} ${n(cx1 - cx0)} ${n(y1 - y0)} re W n 1 0 0 1 0 ${n(d.dy)} cm /${name} Do Q`);
    });
    const contents = ctx.register(ctx.flateStream(new TextEncoder().encode(parts.join('\n'))));
    const resources = ctx.obj({}) as PDFDict;
    resources.set(PDFName.of('XObject'), xobjects);
    if (page) {
      page.node.set(PDFName.of('Contents'), contents);
      page.node.set(PDFName.of('Resources'), resources);
    } else {
      const added = doc.addPage([mb.width, mb.height]);
      added.setMediaBox(mb.x, mb.y, mb.width, mb.height);
      const crop = lastPage.node.CropBox();
      if (crop instanceof PDFArray) added.node.set(PDFName.of('CropBox'), crop);
      const rot = lastPage.getRotation().angle;
      if (rot) added.node.set(PDFName.of('Rotate'), PDFNumber.of(rot));
      added.node.set(PDFName.of('Contents'), contents);
      added.node.set(PDFName.of('Resources'), resources);
    }
  });
}

/** Shifts every rectangle (x0/y0/x1/y1) and point (x/y) in a model value by `dy`. */
function shiftDeep<T>(v: T, dy: number): T {
  if (Array.isArray(v)) return v.map((x) => shiftDeep(x, dy)) as T;
  if (!v || typeof v !== 'object') return v;
  const o = { ...(v as Record<string, unknown>) };
  const rect = 'y0' in o && 'y1' in o;
  for (const [key, x] of Object.entries(o)) {
    if (key === 'pattern') continue;
    if (typeof x === 'number' && ((rect && (key === 'y0' || key === 'y1')) || (!rect && key === 'y' && 'x' in o))) o[key] = x + dy;
    else if (x && typeof x === 'object') o[key] = shiftDeep(x, dy);
  }
  return o as T;
}

/**
 * Page models after the flow: every text box and table row goes where its band is drawn, keeping its
 * id (a table cut by the flow appears on both pages with its rows split, plus repeated header rows
 * on the continued part). Added pages get new models.
 */
export function flowModels(models: PageModel[], plan: FlowPlan): PageModel[] {
  const out: PageModel[] = models.map((m) => ({ ...m, textBoxes: [...m.textBoxes], tables: [...m.tables] }));
  const lastModel = models[models.length - 1]!;
  for (let k = models.length; k < plan.pages.length; k++) {
    out.push({ ...structuredClone(lastModel), pageIndex: k, textBoxes: [], tables: [], backgrounds: [], rulings: [], junctions: [], warnings: [], added: true });
  }
  // Where each source page's content ends up: (band, destination page, dy), own fixed draws excluded.
  const dest = new Map<number, { y0: number; y1: number; page: number; dy: number }[]>();
  plan.pages.forEach((pp, k) => {
    for (const d of pp?.draws ?? []) if (!d.repeat && !d.edge) dest.set(d.src, [...(dest.get(d.src) ?? []), { y0: d.y0, y1: d.y1, page: k, dy: d.dy }]);
  });
  const whereIs = (src: number, s: Span) => {
    const mid = (s.y0 + s.y1) / 2;
    const list = (dest.get(src) ?? []).filter((d) => mid >= d.y0 && mid <= d.y1);
    // The fixed copies on added pages repeat the source bands; the source page's own draw wins.
    return list.find((d) => d.page === src) ?? list.find((d) => d.page < models.length) ?? list[0];
  };
  plan.pages.forEach((pp, src) => {
    if (!pp || src >= models.length) return;
    const m = models[src]!;
    out[src]!.textBoxes = out[src]!.textBoxes.filter((b) => !m.textBoxes.includes(b));
    out[src]!.tables = out[src]!.tables.filter((t) => !m.tables.includes(t));
    for (const b of m.textBoxes) {
      const w = whereIs(src, b.bbox);
      if (!w) continue;
      out[w.page]!.textBoxes.push(shiftDeep(b, w.dy));
    }
    for (const t of m.tables) {
      const parts = new Map<number, { dy: number; rows: Table['rows'] }>();
      for (const r of t.rows) {
        const w = whereIs(src, r);
        if (!w) continue;
        const part = parts.get(w.page) ?? { dy: w.dy, rows: [] };
        part.rows.push(r);
        parts.set(w.page, part);
      }
      for (const [page, { dy, rows }] of parts) {
        const keep = new Set(rows.map((r) => r.index));
        const whole = keep.size === t.rows.length;
        const piece: Table = {
          ...t,
          rows,
          cells: t.cells.filter((c) => keep.has(c.row)),
          bbox: { ...t.bbox, y1: Math.max(...rows.map((r) => r.y1)), y0: Math.min(...rows.map((r) => r.y0)) },
        };
        if (!whole && page !== src) delete piece.setup;
        const moved = shiftDeep(piece, dy);
        const hr = headerRowsOf(t);
        const rep = plan.pages[page]?.draws.find((d) => d.repeat === t.id);
        if (rep && !keep.has(0)) {
          const head = shiftDeep({ rows: t.rows.filter((r) => r.index < hr), cells: t.cells.filter((c) => c.row < hr) }, rep.dy);
          moved.rows = [...head.rows, ...moved.rows];
          moved.cells = [...head.cells, ...moved.cells];
          moved.bbox = { ...moved.bbox, y1: Math.max(moved.bbox.y1, ...head.rows.map((r) => r.y1)) };
        }
        out[page]!.tables.push(moved);
      }
    }
  });
  plan.pages.forEach((pp, k) => {
    if (pp?.flowIn.length) out[k]!.flowIn = pp.flowIn;
  });
  return out;
}
