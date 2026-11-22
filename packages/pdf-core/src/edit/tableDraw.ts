import { cellAnchor, inkFontSize, edgeRole, meshEdges, type BorderStroke, type Color, type EdgeRole, type Matrix, type PageModel, type Rect, type StrategyReport, type Table, type TablePattern, type TextBox } from '@pdf-toolkit/shared';
import { PDFDict, PDFName, type PDFDocument, type PDFRef } from 'pdf-lib';
import { invert } from '../math.ts';
import type { BoxInternal } from '../model/group.ts';
import type { StreamPatch } from '../content/parser.ts';
import type { PageAnalysis } from '../model/extract.ts';
import type { ImageItem, RunInternal } from '../model/interpreter.ts';
import type { TableInternal } from '../model/tables.ts';
import { headerRowsOf, roleStrokes, zebraRows } from '../model/tablePattern.ts';
import { layoutBox, originalEncoding, type BoxLayout, type LayoutStyle } from './layout.ts';
import { cellMinSize, tableBounds, type AddedBox, type TableEdit } from './reduce.ts';
import { imageCropper } from './imageCrop.ts';
import { rasterCellFill, rasterTableContent, type RasterCell, type RasterGrid, type RasterInput } from './raster.ts';
import { colorOp, num, shiftRect, union } from './ops.ts';

type Overflow = Parameters<typeof layoutBox>[2];

/** What table drawing needs from the page being edited (see applyEdits). */
export type TableDrawContext = {
  doc: PDFDocument;
  analyses: PageAnalysis[];
  pages: PageModel[];
  warnings: string[];
  patchOf: (a: PageAnalysis, streamId: string) => StreamPatch;
  remove: (a: PageAnalysis, runs: RunInternal[]) => void;
  addTail: (pageIndex: number, content: string) => void;
  choose: (a: PageAnalysis, box: BoxInternal, text: string, overflow: Overflow, wrapWidth?: number, style?: LayoutStyle) => Promise<{ layout: BoxLayout; strategy: StrategyReport['strategy'] }>;
  place: (a: PageAnalysis, box: BoxInternal, text: string, elementId: string, o: { overflow?: Overflow; wrapWidth?: number; dx: number; dy: number; style?: LayoutStyle; background?: Color | null; onTop?: boolean }) => Promise<Rect | null>;
  placeNew: (ab: AddedBox, measure?: boolean) => Promise<TextBox | null>;
  shiftOps: (a: PageAnalysis, streamId: string, first: number, last: number, ctm: Matrix, dx: number, dy: number) => void;
};


/** Fill of every cell: zebra rows take the pattern's fill by their place among the repeating rows, other cells keep their own. */
function cellFills(te: TableEdit): (Color | null)[][] {
  const fills = te.cells.map((row) => row.map((c) => c.fill));
  if (te.zebra?.length) zebraRows(te.cells.length, te.headerRows, te.spans).forEach((r, k) => (fills[r] = [...te.zebra![k % te.zebra!.length]!]));
  te.cells.forEach((row, r) => row.forEach((c, k) => c.background !== undefined && (fills[r]![k] = c.background)));
  return fills;
}

/**
 * Regenerated table drawing from the model and the border pattern: cell fills (merged cells as one
 * rectangle), and every grid line as runs of drawn edges with the stroke set of its role.
 */
function patternContent(ys: number[], xs: number[], te: TableEdit, pattern: TablePattern): { fills: string; borders: string } {
  const out: string[] = ['q'];
  const rows = ys.length - 1;
  const cols = xs.length - 1;
  const mesh = { vertices: ys.map((y) => xs.map((x) => ({ x, y, snapped: true }))), spans: te.spans };
  const fills = cellFills(te);
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      const a = cellAnchor(mesh, r, c);
      if (a.row !== r || a.col !== c) {
        c++;
        continue;
      }
      const fill = fills[r]![c]!;
      let e = c + a.colSpan;
      // Neighbouring plain cells with the same fill are painted as one rectangle.
      while (a.rowSpan === 1 && a.colSpan === 1 && e < cols && JSON.stringify(fills[r]![e]) === JSON.stringify(fill) && cellAnchor(mesh, r, e).rowSpan === 1 && cellAnchor(mesh, r, e).colSpan === 1) e++;
      if (fill) out.push(`${colorOp(fill, false)} ${num(xs[c]!)} ${num(ys[r + a.rowSpan]!)} ${num(xs[e]! - xs[c]!)} ${num(ys[r]! - ys[r + a.rowSpan]!)} re f`);
      c = e;
    }
  }
  const fillOps = out.splice(1);
  const role = (dir: 'h' | 'v', line: number) => edgeRole(dir, line, dir === 'h' ? rows : cols, te.headerRows);
  const strokes = (dir: 'h' | 'v', line: number) => roleStrokes(pattern, role(dir, line));
  const reach = (list: BorderStroke[]) => Math.max(0, ...list.map((s) => Math.abs(s.offset) + s.width / 2));
  const drawn = new Set(meshEdges(mesh).map((e) => `${e.dir}${e.row},${e.col}`));
  // Inner lines first, the header separator next, the outer border on top, as tables are usually drawn.
  const rank = (r: EdgeRole) => (r === 'bodyRow' || r === 'innerVertical' ? 0 : r === 'headerSeparator' ? 1 : 2);
  const runs: { rank: number; ops: string[] }[] = [];
  const paint = (r: EdgeRole, list: BorderStroke[], seg: (off: number) => string) => runs.push({ rank: rank(r), ops: list.map((s) => `${num(s.width)} w ${colorOp(s.color, true)} ${seg(s.offset)} S`) });
  // A run ending at a corner reaches over it by the other edge's half-thickness (a square corner); at a
  // tee it stops at the crossing line's centre, which the crossing line covers.
  const hEnd = (r: number, k: number) => {
    const up = r > 0 && drawn.has(`v${r - 1},${k}`);
    const down = r < rows && drawn.has(`v${r},${k}`);
    return up !== down ? reach(strokes('v', k)) : 0;
  };
  const vEnd = (c: number, k: number) => {
    const left = c > 0 && drawn.has(`h${k},${c - 1}`);
    const right = c < cols && drawn.has(`h${k},${c}`);
    return left !== right ? reach(strokes('h', k)) : 0;
  };
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c < cols; ) {
      if (!drawn.has(`h${r},${c}`)) {
        c++;
        continue;
      }
      let e = c;
      while (e < cols && drawn.has(`h${r},${e}`)) e++;
      const [x0, x1] = [xs[c]! - hEnd(r, c), xs[e]! + hEnd(r, e)];
      paint(role('h', r), strokes('h', r), (o) => `${num(x0)} ${num(ys[r]! + o)} m ${num(x1)} ${num(ys[r]! + o)} l`);
      c = e;
    }
  }
  for (let c = 0; c <= cols; c++) {
    for (let r = 0; r < rows; ) {
      if (!drawn.has(`v${r},${c}`)) {
        r++;
        continue;
      }
      let e = r;
      while (e < rows && drawn.has(`v${e},${c}`)) e++;
      const [y0, y1] = [ys[r]! + vEnd(c, r), ys[e]! - vEnd(c, e)];
      paint(role('v', c), strokes('v', c), (o) => `${num(xs[c]! + o)} ${num(y0)} m ${num(xs[c]! + o)} ${num(y1)} l`);
      r = e;
    }
  }
  for (const run of runs.sort((a, b) => a.rank - b.rank)) out.push(...run.ops);
  out.push('Q');
  return { fills: fillOps.length ? ['q', ...fillOps, 'Q'].join('\n') : '', borders: out.join('\n') };
}

type HAlign = 'left' | 'center' | 'right';
type VAlign = 'top' | 'middle' | 'bottom';
/**
 * How a cell's text sits in its cell on the original page: `ob` the cell, `pad` the horizontal
 * padding kept on both sides when wrapping, `h0` the laid-out text height, `leftU` the left end of
 * its lines (user space).
 */
type CellLook = { ob: Rect; h: HAlign; v: VAlign; pad: number; h0: number; leftU: number };

function hAlignOf(cell: Rect, x0: number, x1: number): HAlign {
  const l = x0 - cell.x0;
  const r = cell.x1 - x1;
  if (Math.abs(l - r) <= 1) return 'center';
  return r < l ? 'right' : 'left';
}

function vAlignOf(cell: Rect, content: Rect): VAlign {
  const top = cell.y1 - content.y1;
  const bottom = content.y0 - cell.y0;
  if (Math.abs(top - bottom) <= Math.max(1, 0.15 * (cell.y1 - cell.y0))) return 'middle';
  return top < bottom ? 'top' : 'bottom';
}

/** Translation that keeps content aligned in cell `nb` the way it sat in `ob`; `dh` = growth of the content height. */
function alignShift(h: HAlign, v: VAlign, ob: Rect, nb: Rect, dh = 0): { dx: number; dy: number } {
  const dx = h === 'left' ? nb.x0 - ob.x0 : h === 'right' ? nb.x1 - ob.x1 : (nb.x0 + nb.x1 - ob.x0 - ob.x1) / 2;
  const dy = v === 'top' ? nb.y1 - ob.y1 : v === 'bottom' ? nb.y0 - ob.y0 + dh : (nb.y0 + nb.y1 - ob.y0 - ob.y1) / 2 + dh / 2;
  return { dx, dy };
}


const lineExtent = (b: BoxInternal): [number, number] => [Math.min(...b.runs.map((r) => r.origin[0])), Math.max(...b.runs.map((r) => r.end[0]))];

/**
 * Padding, alignment and text height of a cell's original text. Horizontal alignment comes from the
 * cells of the same column (header and body apart) when their text lines up, else from the padding.
 */
function measureCell(ti: TableInternal, key: string): CellLook {
  const box = ti.cellBoxes.get(key)!;
  const [row, col] = key.split(',').map(Number) as [number, number];
  const cell = ti.table.cells.find((c) => c.row === row && c.col === col)!;
  const ob = cell.bbox;
  const l0 = layoutBox(box, box.text, undefined, originalEncoding(box));
  const content = l0.missing.length || l0.reason ? box.bbox : l0.bbox;
  const [x0, x1] = lineExtent(box);
  const hr = headerRowsOf(ti.table);
  const single = (c: Table['cells'][number]) => !c.covered && (c.colSpan ?? 1) === 1;
  let h: HAlign | undefined;
  if (single(cell)) {
    const peers = ti.table.cells.filter((c) => c.col === col && single(c) && c.row < hr === row < hr && ti.cellBoxes.has(`${c.row},${c.col}`));
    if (peers.length >= 2) {
      const offs = peers.map((c) => {
        const [a, b] = lineExtent(ti.cellBoxes.get(`${c.row},${c.col}`)!);
        return [a - c.bbox.x0, c.bbox.x1 - b, (a + b - c.bbox.x0 - c.bbox.x1) / 2];
      });
      const spread = (k: number) => Math.max(...offs.map((o) => o[k]!)) - Math.min(...offs.map((o) => o[k]!));
      h = spread(0) <= 1 ? 'left' : spread(1) <= 1 ? 'right' : spread(2) <= 1 ? 'center' : undefined;
    }
  }
  h ??= box.lines.length > 1 ? (box.align === 'justify' ? 'left' : box.align) : hAlignOf(ob, x0, x1);
  const pad = Math.max(0, h === 'left' ? x0 - ob.x0 : h === 'right' ? ob.x1 - x1 : Math.min(x0 - ob.x0, ob.x1 - x1));
  return { ob, h, v: vAlignOf(ob, content), pad, h0: content.y1 - content.y0, leftU: x0 };
}

/** One anchor cell of a table edit: where its text style comes from and whether its text is laid out again. */
type CellPlan = {
  r: number;
  c: number;
  text: string;
  /** Original cell the content came from (`row,col`). */
  srcKey?: string;
  /** Box whose style the text uses: the cell's own, or a template cell's for inserted cells. */
  box?: BoxInternal;
  look?: CellLook;
  /** Own text, same width: the original glyphs are kept (moved when the cell moves). */
  keep: boolean;
  relayout: boolean;
  wrap?: number;
  style?: LayoutStyle;
  /** Height of the laid-out text, when it was laid out again. */
  hNew?: number;
  /** Height the cell needs for its laid-out text, padding included. */
  need?: number;
  /** New text without a style box to copy, or in a font or size set with setCellText: drawn like addTextBox, `textH` high, centred in the cell. */
  fresh?: { ab: Pick<AddedBox, 'text' | 'fontSize' | 'fontFamily' | 'color' | 'align'>; padH: number; padV: number; textH: number; v: VAlign };
};

/** Font size for new text in a scanned cell: the largest estimated from the ink lines of its column (on its side of the header), else of the table. */
function scanTextSize(orig: Table, te: TableEdit, r: number, c: number): number | undefined {
  const inks = orig.setup?.origin === 'raster' ? orig.setup.raster?.inkBoxes : undefined;
  if (!inks) return undefined;
  const header = r < te.headerRows;
  const col = te.cells.flatMap((row, rr) => {
    const s = row[c]?.src;
    const b = s && rr < te.headerRows === header ? inks[s.row]?.[s.col] : undefined;
    return b ? [inkFontSize(b)] : [];
  });
  const all = inks.flat().flatMap((b) => (b ? [inkFontSize(b)] : []));
  return col.length ? Math.max(...col) : all.length ? Math.max(...all) : undefined;
}

/** Cell whose text style an inserted cell uses: nearest with text in the same column (body rows for body cells), else in the same row, else any. */
function templateKey(ti: TableInternal, te: TableEdit, r: number, c: number): string | undefined {
  const withBox = (rr: number, cc: number) => {
    const s = te.cells[rr]?.[cc]?.src;
    return s && ti.cellBoxes.has(`${s.row},${s.col}`) ? `${s.row},${s.col}` : undefined;
  };
  const byDistance = (list: { k: string; d: number }[]) => list.sort((p, q) => p.d - q.d)[0]?.k;
  const header = r < te.headerRows;
  const inCol = te.cells.flatMap((_, rr) => {
    const k = withBox(rr, c);
    return k && rr < te.headerRows === header ? [{ k, d: Math.abs(rr - r) }] : [];
  });
  const inRow = te.cells[r]!.flatMap((_, cc) => {
    const k = withBox(r, cc);
    return k ? [{ k, d: Math.abs(cc - c) }] : [];
  });
  return byDistance(inCol) ?? byDistance(inRow) ?? [...ti.cellBoxes.keys()][0];
}

/** Table emission: rows grow to fit their text (`growRows`, before the reflow), then each table is redrawn (`draw`). */
export function tableDrawer(ctx: TableDrawContext) {
  const { doc, analyses, pages, warnings, patchOf, remove, addTail, choose, place, placeNew, shiftOps } = ctx;
  const looks = new Map<string, CellLook>();
  const lookOf = (ti: TableInternal, key: string) => {
    const id = `${ti.table.id}|${key}`;
    let l = looks.get(id);
    if (!l) looks.set(id, (l = measureCell(ti, key)));
    return l;
  };
  const plans = new Map<string, CellPlan[]>();
  const planTable = async (te: TableEdit): Promise<CellPlan[]> => {
    const known = plans.get(te.tableId);
    if (known) return known;
    const a = analyses[te.pageIndex]!;
    const ti = a.tables.find((t) => t.table.id === te.tableId)!;
    const mesh = { vertices: [], spans: te.spans };
    const out: CellPlan[] = [];
    for (let r = 0; r < te.cells.length; r++) {
      for (let c = 0; c < te.xs.length - 1; c++) {
        const span = cellAnchor(mesh, r, c);
        if (span.row !== r || span.col !== c) continue;
        const cell = te.cells[r]![c]!;
        const nbW = te.xs[c + span.colSpan]! - te.xs[c]!;
        const srcKey = cell.src && `${cell.src.row},${cell.src.col}`;
        const own = srcKey ? ti.cellBoxes.get(srcKey) : undefined;
        const styleKey = own ? srcKey : cell.text ? templateKey(ti, te, r, c) : undefined;
        const box = styleKey ? ti.cellBoxes.get(styleKey) : undefined;
        const look = box ? lookOf(ti, styleKey!) : undefined;
        const st = cell.style;
        const widthChanged = !!look && Math.abs(nbW - (look.ob.x1 - look.ob.x0)) > 0.01;
        const keep = !!own && cell.text === own.text && !widthChanged && !st;
        const fresh = !!cell.text && (!box || !!st?.fontFamily || !!st?.fontSize);
        const plan: CellPlan = { r, c, text: cell.text, srcKey, box, look, keep, relayout: !!box && !!cell.text && !keep && !fresh };
        // Font size never changes: the text wraps in the cell width (minus its padding) and the row grows.
        if (plan.relayout) {
          plan.wrap = Math.max(1, nbW - 2 * look!.pad);
          const style: LayoutStyle = { ...(look!.h !== 'left' && { align: look!.h }), ...(st?.color && { fill: [colorOp(st.color, false)] }) };
          plan.style = Object.keys(style).length ? style : undefined;
          const chosen = await choose(a, box!, cell.text, undefined, plan.wrap, plan.style);
          if (chosen.strategy !== 'none') {
            plan.hNew = chosen.layout.bbox.y1 - chosen.layout.bbox.y0;
            plan.need = look!.ob.y1 - look!.ob.y0 - look!.h0 + plan.hNew;
          }
        } else if (fresh) {
          const run0 = box?.runs[0];
          const ab = {
            text: cell.text,
            fontFamily: st?.fontFamily ?? run0?.font.cleanName,
            fontSize: st?.fontSize ?? run0?.userSize ?? scanTextSize(ti.table, te, r, c) ?? Math.min(11, (te.ys[r]! - te.ys[r + span.rowSpan]!) * 0.6),
            color: st?.color ?? (run0 ? { space: run0.fill.space, values: run0.fill.values } : ti.table.setup?.raster?.ink),
            align: look?.h ?? 'left',
          };
          const padH = look?.pad ?? 3;
          const padV = look ? Math.max(1, (look.ob.y1 - look.ob.y0 - look.h0) / 2) : 3;
          const m = await placeNew({ ...ab, id: `${te.tableId}:${r},${c}`, pageIndex: te.pageIndex, bbox: { x0: 0, x1: Math.max(1, nbW - 2 * padH), y0: 0, y1: 0 } }, true);
          const textH = m ? -m.bbox.y0 : 0;
          plan.fresh = { ab, padH, padV, textH, v: look?.v ?? 'middle' };
          if (m) plan.need = textH + 2 * padV;
        }
        out.push(plan);
      }
    }
    plans.set(te.tableId, out);
    return out;
  };

  /** Rows grow to fit their cells' text (merged cells grow their last row), before anything below moves. */
  const growRows = async (tables: Iterable<TableEdit>) => {
    for (const te of tables) {
      if (te.deleted) continue;
      const plan = await planTable(te);
      const hs = te.ys.slice(0, -1).map((y, i) => y - te.ys[i + 1]!);
      const mesh = { vertices: [], spans: te.spans };
      for (const multi of [false, true]) {
        for (const p of plan) {
          if (p.need === undefined) continue;
          const { rowSpan } = cellAnchor(mesh, p.r, p.c);
          if (rowSpan > 1 !== multi) continue;
          const need = p.need;
          const total = hs.slice(p.r, p.r + rowSpan).reduce((x, y) => x + y, 0);
          if (need > total + 0.01) hs[p.r + rowSpan - 1]! += need - total;
        }
      }
      te.ys = hs.reduce((ys, h) => [...ys, ys[ys.length - 1]! - h], [te.ys[0]!]);
    }
  };

  /** Resource name of image `im` in the page's own resources (registered under a free /TKImn name when it comes from a form). */
  const pageImageKey = (a: PageAnalysis, im: ImageItem): string | null => {
    const info = a.interp.streams.get(`page:${a.pageIndex}`)!;
    if (im.streamId === info.id && im.name) return im.name;
    return im.ref ? pageXObjectKey(a, im.ref) : null;
  };
  const pageXObjectKey = (a: PageAnalysis, ref: PDFRef): string => {
    const info = a.interp.streams.get(`page:${a.pageIndex}`)!;
    const ctx = doc.context;
    if (!info.resources) {
      info.resources = ctx.obj({});
      doc.getPage(a.pageIndex).node.set(PDFName.of('Resources'), info.resources);
    }
    let xo = info.resources.lookup(PDFName.of('XObject'));
    if (!(xo instanceof PDFDict)) {
      xo = ctx.obj({});
      info.resources.set(PDFName.of('XObject'), xo);
    }
    const dict = xo as PDFDict;
    const known = [...dict.entries()].find(([, v]) => v === ref);
    if (known) return known[0].decodeText();
    let n = 1;
    while (dict.has(PDFName.of(`TKIm${n}`))) n++;
    dict.set(PDFName.of(`TKIm${n}`), ref);
    return `TKIm${n}`;
  };
  /** The scan under a raster table (the topmost image covering it) and its grid, or null with a warning. */
  const rasterOf = async (a: PageAnalysis, orig: Table): Promise<Pick<RasterInput, 'image' | 'orig' | 'look' | 'borderWidth'> | null> => {
    const setup = orig.setup;
    if (setup?.origin !== 'raster') return null;
    const b = orig.bbox;
    const im = a.interp.images.filter((i) => i.bbox.x0 <= b.x0 + 1 && i.bbox.x1 >= b.x1 - 1 && i.bbox.y0 <= b.y0 + 1 && i.bbox.y1 >= b.y1 - 1).sort((p, q) => q.seq - p.seq)[0];
    const key = im && pageImageKey(a, im);
    if (!im || !key || !setup.raster) {
      warnings.push(`Table ${orig.id} is set up as scanned, but ${!setup.raster ? 'its paper colour was not measured' : 'no scanned image covers it'}; it is drawn without the scan`);
      return null;
    }
    const grid: RasterGrid = {
      ys: [orig.rows[0]!.y1, ...orig.rows.map((r) => r.y0)],
      xs: [orig.cols[0]!.x0, ...orig.cols.map((c) => c.x1)],
      spans: setup.spans,
      headerRows: setup.headerRows,
      snapped: setup.vertices.map((row) => row.map((v) => v.snapped)),
    };
    const cropper = im.ref && (await imageCropper(doc.context, im.ref, im.ctm));
    const crop = cropper
      ? (src: Rect) => {
          const piece = cropper(src);
          return piece && { key: pageXObjectKey(a, piece.ref), ctm: piece.ctm };
        }
      : undefined;
    return { image: { ctm: im.ctm, key, bbox: im.bbox, ...(crop && { crop }) }, orig: grid, look: setup.raster, borderWidth: setup.borderWidth };
  };

  const draw = async (tables: Iterable<TableEdit>) => {
    for (const te of tables) {
      const a = analyses[te.pageIndex]!;
      const ti = a.tables.find((t) => t.table.id === te.tableId)!;
      const orig = ti.table;
      const page = pages[te.pageIndex]!;
      const tIdx = page.tables.findIndex((t) => t.id === te.tableId);
      const raster = await rasterOf(a, orig);
      // Painting operators become `n`, so the ruling lines and fills disappear but the graphics state stays as it was.
      for (const p of ti.paths) patchOf(a, p.streamId).replace.set(p.opEnd - 1, 'n');
      const dropImage = (im: ImageItem) => patchOf(a, im.streamId).replace.set(im.opIndex, '');
      if (te.deleted) {
        if (raster) addTail(te.pageIndex, rasterTableContent({ ...raster, next: null, cells: [], belowShift: 0 }));
        remove(a, ti.runs);
        for (const list of ti.cellImages.values()) list.forEach(dropImage);
        page.tables.splice(tIdx, 1);
        continue;
      }
      const ys = te.ys.map((y) => y + te.dy);
      const xs = te.xs.map((x) => x + te.dx);
      if (ti.paths.length && orig.pattern) {
        const { fills, borders } = patternContent(ys, xs, te, orig.pattern);
        // Fills go where the table was painted, under the cell text that follows it in the stream; on top they would hide it.
        const first = ti.paths.reduce((p, q) => (q.seq < p.seq ? q : p));
        const inv = invert(first.ctm);
        if (fills && inv) {
          const pp = patchOf(a, first.streamId);
          pp.insertBefore.set(first.opStart, [...(pp.insertBefore.get(first.opStart) ?? []), `q ${inv.map((n) => String(Number(n.toPrecision(12)) || 0)).join(' ')} cm\n${fills}\nQ`]);
        } else if (fills) addTail(te.pageIndex, fills);
        addTail(te.pageIndex, borders);
      }
      const nextGrid: RasterGrid = { ys, xs, spans: te.spans, headerRows: te.headerRows };
      const anchors: RasterCell[] = te.cells.flatMap((row, r) =>
        row.flatMap((cell, c) => {
          const s = cellAnchor({ vertices: [], spans: te.spans }, r, c);
          return s.row === r && s.col === c ? [{ r, c, ...(cell.src && { src: cell.src }), blank: !!cell.edited, ...(cell.background !== undefined && { fill: cell.background }) }] : [];
        }),
      );
      if (raster) {
        const belowShift = tableBounds(te.ys, te.xs).y0 - orig.bbox.y0;
        addTail(te.pageIndex, rasterTableContent({ ...raster, next: nextGrid, cells: anchors, belowShift }));
      }
      const origCell = (key: string) => orig.cells.find((c) => `${c.row},${c.col}` === key)!;
      const cellRect = (r: number, c: number): Rect => ({ x0: xs[c]!, y0: ys[r + 1]!, x1: xs[c + 1]!, y1: ys[r]! });
      const newCells: Table['cells'] = [];
      const placedKeys = new Set<string>();
      const spanMesh = { vertices: [], spans: te.spans };
      const fills = cellFills(te);
      const plan = new Map((await planTable(te)).map((p) => [`${p.r},${p.c}`, p]));

      for (let r = 0; r < te.cells.length; r++) {
        for (let c = 0; c < xs.length - 1; c++) {
          const span = cellAnchor(spanMesh, r, c);
          if (span.row !== r || span.col !== c) {
            newCells.push({ row: r, col: c, bbox: cellRect(r, c), text: '', runIds: [], fill: null, covered: true });
            continue;
          }
          const p = plan.get(`${r},${c}`)!;
          const merged = span.rowSpan > 1 || span.colSpan > 1;
          const nb: Rect = { x0: xs[c]!, y0: ys[r + span.rowSpan]!, x1: xs[c + span.colSpan]!, y1: ys[r]! };
          const id = `${te.tableId}:${r},${c}`;
          let runIds: string[] = [];
          const own = p.srcKey ? ti.cellBoxes.get(p.srcKey) : undefined;
          if (p.srcKey) placedKeys.add(p.srcKey);
          const bg = te.cells[r]![c]!.background;
          // Without a regenerated drawing, a set fill is painted at the end of the page, so the text goes on top of it.
          const onTop = bg !== undefined && !raster && !(ti.paths.length && orig.pattern);
          if (bg && onTop) addTail(te.pageIndex, `q ${colorOp(bg, false)} ${num(nb.x0)} ${num(nb.y0)} ${num(nb.x1 - nb.x0)} ${num(nb.y1 - nb.y0)} re f Q`);
          if (p.fresh) {
            const f = p.fresh;
            const h = nb.y1 - nb.y0;
            const top = f.v === 'top' ? nb.y1 - f.padV : f.v === 'bottom' ? nb.y0 + f.padV + f.textH : nb.y1 - Math.max(f.padV, (h - f.textH) / 2);
            await placeNew({ ...f.ab, id, pageIndex: te.pageIndex, bbox: { x0: nb.x0 + f.padH, x1: nb.x1 - f.padH, y1: top, y0: nb.y0 } });
            if (own) remove(a, own.runs);
          } else if (p.box && p.look && p.text) {
            const L = p.look;
            let { dx, dy } = alignShift(L.h, L.v, L.ob, nb, p.hNew !== undefined ? p.hNew - L.h0 : 0);
            // Re-laid-out centred / right-aligned lines are placed in [leftU, leftU + wrap]; move that frame into the new cell.
            if (p.relayout && L.h !== 'left') dx = L.h === 'center' ? (nb.x0 + nb.x1) / 2 - (L.leftU + p.wrap! / 2) : nb.x1 - L.pad - (L.leftU + p.wrap!);
            if (p.keep && !onTop && Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) runIds = own!.runs.map((x) => x.id);
            else if ((await place(a, p.box, p.text, id, { dx, dy, onTop, ...(p.relayout && { wrapWidth: p.wrap, style: p.style }) })) && own) remove(a, own.runs);
          } else if (own) remove(a, own.runs);
          // Images keep their size and move with their cell by its original alignment (a translation only).
          const imgs = p.srcKey ? ti.cellImages.get(p.srcKey) : undefined;
          let imageInfo: Pick<Table['cells'][number], 'images' | 'minSize'> = {};
          if (imgs) {
            const src = origCell(p.srcKey!);
            const u = union(imgs.map((im) => im.bbox));
            const sh = alignShift(hAlignOf(src.bbox, u.x0, u.x1), vAlignOf(src.bbox, u), src.bbox, nb);
            if (Math.abs(sh.dx) > 1e-6 || Math.abs(sh.dy) > 1e-6) for (const im of imgs) shiftOps(a, im.streamId, im.opIndex, im.opIndex, im.ctm, sh.dx, sh.dy);
            imageInfo = { images: imgs.map((im) => shiftRect(im.bbox, sh.dx, sh.dy)), ...(src.minSize && { minSize: src.minSize }) };
          } else {
            const m = cellMinSize(te.cells[r]![c]!, orig);
            if (m) imageInfo = { minSize: m.min };
          }
          newCells.push({ row: r, col: c, bbox: nb, text: p.text, runIds, fill: fills[r]![c]!, ...imageInfo, ...(merged && { rowSpan: span.rowSpan, colSpan: span.colSpan }) });
        }
      }
      for (const [key, box] of ti.cellBoxes) if (!placedKeys.has(key)) remove(a, box.runs);
      for (const [key, list] of ti.cellImages) if (!placedKeys.has(key)) list.forEach(dropImage);
      // Ink boxes follow their cells into the new grid (crops are top-left anchored); rewritten and new cells have none.
      const look = orig.setup?.origin === 'raster' ? orig.setup.raster : undefined;
      const inkBoxes = look?.inkBoxes && te.cells.map((row, r) =>
        row.map((cell, c) => {
          const b = cell.src && !cell.edited ? look.inkBoxes![cell.src.row]?.[cell.src.col] : undefined;
          const nb = newCells.find((n) => n.row === r && n.col === c)!.bbox;
          const ob = b && origCell(`${cell.src!.row},${cell.src!.col}`).bbox;
          return b && ob ? { ...b, ...shiftRect(b, nb.x0 - ob.x0, nb.y1 - ob.y1) } : null;
        }),
      );
      // Fills as drawn, indexed by the new grid (covered cells take their anchor's).
      const rasterFills = look && te.cells.map((row, r) =>
        row.map((_, c) => {
          const s = cellAnchor({ vertices: [], spans: te.spans }, r, c);
          return rasterCellFill(look, anchors, nextGrid, anchors.find((k) => k.r === s.row && k.c === s.col)!);
        }),
      );
      page.tables[tIdx] = {
        ...orig,
        bbox: { x0: xs[0]!, y0: ys[ys.length - 1]!, x1: xs[xs.length - 1]!, y1: ys[0]! },
        rows: ys.slice(0, -1).map((y, i) => ({ index: i, y0: ys[i + 1]!, y1: y })),
        cols: xs.slice(0, -1).map((x, i) => ({ index: i, x0: x, x1: xs[i + 1]! })),
        cells: newCells,
        ...(orig.setup && { setup: { ...orig.setup, vertices: ys.map((y) => xs.map((x) => ({ x, y, snapped: true }))), spans: te.spans, headerRows: te.headerRows, ...(look && { raster: { ...look, fills: rasterFills!, ...(inkBoxes && { inkBoxes }) } }) } }),
        ...(orig.pattern && { pattern: { ...orig.pattern, zebra: te.zebra } }),
      };
    }
  };

  return { growRows, draw };
}
