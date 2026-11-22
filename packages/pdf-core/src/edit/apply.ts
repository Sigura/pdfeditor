import pdfLibFontkit from '@pdf-lib/fontkit';
import { createHash } from 'node:crypto';
import { PDFArray, PDFDict, PDFName, PDFStream, type PDFDocument, type PDFFont } from 'pdf-lib';
import { cellAnchor, inkFontSize, edgeRole, meshEdges, type BorderStroke, type Color, type EdgeRole, type EditOperation, type Matrix, type PageModel, type PageOverflow, type Rect, type StrategyReport, type Table, type TablePattern, type TextBox } from '@pdf-toolkit/shared';
import { faceCovers, findFallback, findSubstitute, loadFace, parseFontName, type FontRequest, type LoadedFace } from '../fonts/lookup.ts';
import { invert, mul, translate } from '../math.ts';
import type { BoxInternal } from '../model/group.ts';
import { applyPatch, emptyPatch, serializeOp, type StreamPatch } from '../content/parser.ts';
import { PdfError } from '../errors.ts';
import { loadPdf } from '../load.ts';
import { analyzeDocument, type PageAnalysis } from '../model/extract.ts';
import type { ImageItem, PathItem, RunInternal, StreamInfo } from '../model/interpreter.ts';
import type { TableInternal } from '../model/tables.ts';
import { snapshotObjects, writeIncremental } from '../save/incremental.ts';
import { encodeForFont, type EncodedItem } from './coverage.ts';
import { Emulator, fontRequest } from './emulate.ts';
import { layoutBox, originalEncoding, type BoxEncoding, type BoxLayout, type LayoutStyle } from './layout.ts';
import { cellMinSize, tableBounds, tableDefinitions, reduceEdits, reflowBelow, type AddedBox, type TableEdit } from './reduce.ts';
import { rasterTableContent, type RasterGrid, type RasterInput } from './raster.ts';
import { headerRowsOf, roleStrokes, zebraRows } from '../model/tablePattern.ts';
import { writeStoredTables } from '../model/pieceInfo.ts';

export type ApplyResult = {
  bytes: Uint8Array;
  reports: StrategyReport[];
  warnings: string[];
  /** Page models of the original with the edits applied (element IDs stay those of the original). */
  pages: PageModel[];
  /** Pages whose content was pushed past the bottom edge (growing tables, moves), by how many points. */
  overflows: PageOverflow[];
};

/**
 * Replaces a show operator with one that has the same text-space advance and draws nothing, so
 * later text on the line keeps its position and the old glyphs are gone from the stream.
 */
export function removalOp(run: RunInternal): string {
  const k = run.state.size * run.state.hScale;
  const n = k === 0 ? 0 : (-run.advance * 1000) / k;
  const tj = serializeOp('TJ', [{ t: 'arr', v: [{ t: 'num', v: Math.round(n * 1000) / 1000 }] }]);
  const a = run.op.operands;
  if (run.op.op === "'") return `T* ${tj}`;
  if (run.op.op === '"') return `${serializeOp('Tw', a.slice(0, 1))} ${serializeOp('Tc', a.slice(1, 2))} T* ${tj}`;
  return tj;
}

function writeStream(doc: PDFDocument, pageIndex: number, info: StreamInfo, bytes: Uint8Array): void {
  const ctx = doc.context;
  const stream = ctx.flateStream(bytes);
  if (info.ref) {
    const orig = ctx.lookup(info.ref, PDFStream);
    for (const [k, v] of orig.dict.entries()) {
      if (!['Length', 'Filter', 'DecodeParms'].includes(k.decodeText())) stream.dict.set(k, v);
    }
    ctx.assign(info.ref, stream);
  } else {
    doc.getPage(pageIndex).node.set(PDFName.of('Contents'), ctx.register(stream));
  }
}

/** Embeds substitute / text-layer fonts once per document (subset Type0/Identity-H + ToUnicode). */
class FontEmbedder {
  private readonly fonts = new Map<string, PDFFont>();
  private readonly used = new Map<PDFFont, Set<string>>();
  private readonly keys = new Map<string, string>();
  constructor(private readonly doc: PDFDocument) {
    doc.registerFontkit(pdfLibFontkit);
  }

  async embed(face: LoadedFace): Promise<PDFFont> {
    let f = this.fonts.get(face.file);
    if (!f) {
      f = await this.doc.embedFont(face.bytes, { subset: true });
      this.fonts.set(face.file, f);
    }
    return f;
  }

  glyph(font: PDFFont, ch: string): { bytes: number[]; width: number } {
    const used = this.used.get(font) ?? new Set<string>();
    used.add(ch);
    this.used.set(font, used);
    return { bytes: [...font.encodeText(ch).asBytes()], width: font.widthOfTextAtSize(ch, 1000) };
  }

  /**
   * pdf-lib names subsets "Name-1234" with a random suffix. Rename them to the standard
   * "ABCDEF+Name" tag, derived from the glyphs used so the output stays deterministic.
   */
  finalize(): void {
    for (const [, font] of this.fonts) {
      const type0 = this.doc.context.lookup(font.ref, PDFDict);
      const cid = type0.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
      const desc = cid.lookup(PDFName.of('FontDescriptor'), PDFDict);
      const ps = font.name.replace(/-\d+$/, '');
      const digest = createHash('sha256').update(ps).update([...(this.used.get(font) ?? [])].sort().join('')).digest();
      const tag = [...digest.subarray(0, 6)].map((b) => String.fromCharCode(65 + (b % 26))).join('');
      const name = PDFName.of(`${tag}+${ps}`);
      type0.set(PDFName.of('BaseFont'), name);
      cid.set(PDFName.of('BaseFont'), name);
      desc.set(PDFName.of('FontName'), name);
    }
  }

  /** Resource name of `font` in the resources of `info` (added under a free /TKn name). */
  resourceKey(pageIndex: number, info: StreamInfo, font: PDFFont): string {
    const id = `${info.id}|${font.ref.toString()}`;
    const known = this.keys.get(id);
    if (known) return known;
    const ctx = this.doc.context;
    let res = info.resources;
    if (!res) {
      res = ctx.obj({});
      if (info.ref) ctx.lookup(info.ref, PDFStream).dict.set(PDFName.of('Resources'), res);
      else this.doc.getPage(pageIndex).node.set(PDFName.of('Resources'), res);
      info.resources = res;
    }
    let fonts = res.lookup(PDFName.of('Font'));
    if (!(fonts instanceof PDFDict)) {
      fonts = ctx.obj({});
      res.set(PDFName.of('Font'), fonts);
    }
    const dict = fonts as PDFDict;
    let n = 1;
    while (dict.has(PDFName.of(`TK${n}`))) n++;
    dict.set(PDFName.of(`TK${n}`), font.ref);
    this.keys.set(id, `TK${n}`);
    return `TK${n}`;
  }
}

/** Debug/comparison: skip S1 and use only this source (characters it can't draw fall back to S1). */
export type ForceStrategy = 'substitute' | 'outline' | 'compose' | 'fallback';

type Chosen = { layout: BoxLayout; strategy: StrategyReport['strategy']; substituteFont?: string; warnings: string[] };

/** S1 → S2 → S3 for one box (see ARCHITECTURE.md, font-strategy decision flow). */
async function chooseStrategy(a: PageAnalysis, box: BoxInternal, text: string, overflow: Parameters<typeof layoutBox>[2], fonts: FontEmbedder, force?: ForceStrategy, wrapWidth?: number, style?: LayoutStyle): Promise<Chosen> {
  const s1 = layoutBox(box, text, overflow, originalEncoding(box), wrapWidth, style);
  if (!force && !s1.missing.length && !s1.reason) return { layout: s1, strategy: 'original', warnings: [] };
  const r0 = box.runs[0]!;
  const font = r0.font;
  const info = a.interp.streams.get(r0.streamId)!;
  const why = force ? `strategy forced to ${force}` : s1.missing.length ? `characters not in the original font: ${s1.missing.join(' ')}` : `the original font can't be used: ${s1.reason}`;
  if (font.vertical) return { layout: s1, strategy: 'none', warnings: [`Vertical writing is not editable`] };
  const nfc = text.normalize('NFC');
  const req = fontRequest(font);

  if (!font.isType3 && (!force || force === 'substitute')) {
    const hit = findSubstitute(req);
    const face = hit ? loadFace(hit.face) : undefined;
    if (face && faceCovers(face, nfc.replace(/\n/g, ''))) {
      const pdfFont = await fonts.embed(face);
      const key = fonts.resourceKey(a.pageIndex, info, pdfFont);
      const enc: BoxEncoding = {
        fontKeys: [r0.state.fontKey, key],
        encode: (p) => ({
          items: [...p.normalize('NFC')].map((ch): EncodedItem => {
            const g = fonts.glyph(pdfFont, ch);
            return { kind: 'glyph', ch, code: -1, bytes: g.bytes, width: g.width, isWordSpace: false, font: 1, wordSpace: ch === ' ' && !font.isType0 };
          }),
          missing: [],
        }),
      };
      const layout = layoutBox(box, nfc, overflow, enc, wrapWidth, style);
      return { layout, strategy: 'substitute', substituteFont: face.postscriptName, warnings: [`S2: ${why}; substituted ${face.postscriptName} (${hit!.how} match)`] };
    }
  }

  if (force === 'substitute') return { layout: s1, strategy: 'none', warnings: ['No substitute font covers the text'] };
  const emu = new Emulator(font);
  const enc: BoxEncoding = {
    fontKeys: [r0.state.fontKey],
    encode: (p) => {
      if (!force) return encodeForFont(font, p.normalize('NFC'), (ch) => emu.emulate(ch));
      const parts = [...p.normalize('NFC')].map((ch) => (ch === ' ' ? null : emu.forced(ch, force)) ?? encodeForFont(font, ch, (c) => emu.emulate(c)));
      return { items: parts.flatMap((r) => ('items' in r ? r.items : [r])), missing: parts.flatMap((r) => ('missing' in r ? r.missing : [])) };
    },
  };
  const probe = layoutBox(box, nfc, overflow, enc, wrapWidth, style);
  if (probe.missing.length || probe.reason) {
    const w = probe.missing.length ? `NO_GLYPH_SOURCE: no glyph source for ${probe.missing.join(' ')}` : `NO_GLYPH_SOURCE: ${probe.reason}`;
    return { layout: probe, strategy: 'none', warnings: [`${w}; the box was left unchanged`] };
  }
  const layerChars = new Set<string>();
  for (const p of nfc.split('\n')) {
    for (const it of enc.encode(p).items) if (it.kind === 'emulated' && it.parts.every((q) => q.kind === 'path')) layerChars.add(it.ch);
  }
  const warnings = [`S3: ${why}`];
  if (layerChars.size) {
    const layerFace = findFallback(emu.request, [...layerChars].join(''));
    if (layerFace) {
      const pdfFont = await fonts.embed(layerFace);
      enc.fontKeys.push(fonts.resourceKey(a.pageIndex, info, pdfFont));
      enc.layer = { font: 1, glyph: (ch) => fonts.glyph(pdfFont, ch) };
    } else warnings.push('No Unicode font covers the emulated characters, so they have no invisible text layer');
  }
  const layout = layoutBox(box, nfc, overflow, enc, wrapWidth, style);
  const used = [...emu.fallbackFaces];
  return { layout, strategy: 'emulated', substituteFont: used.length ? used.join(', ') : undefined, warnings };
}

const num = (n: number) => String(Number(n.toFixed(4)) || 0);

/** `cm` operator that translates by (dx, dy) in user space when the current CTM is `ctm`. */
function translateIn(ctm: Matrix, dx: number, dy: number): string {
  const inv = invert(ctm);
  if (!inv) throw new PdfError('UNSUPPORTED', 'Degenerate transformation matrix');
  // Full precision: under a scaled CTM (e.g. an image's) the entries are divided by the scale, and 4 decimals would move it off by up to 0.01 pt.
  return `${mul(mul(ctm, translate(dx, dy)), inv).map((n) => String(Number(n.toPrecision(12)) || 0)).join(' ')} cm`;
}

function colorOp(c: Color | undefined, stroke: boolean): string {
  const v = c?.values ?? [0];
  const op = c?.space === 'rgb' ? 'rg' : c?.space === 'cmyk' ? 'k' : 'g';
  if (c?.space === 'other') return stroke ? '0 G' : '0 g';
  return `${v.map(num).join(' ')} ${stroke ? op.toUpperCase() : op}`;
}

const BG_PAD = 1;

/** Fill under text: `bbox` in user space, painted where the CTM is `ctm`. */
function backgroundFill(c: Color, bbox: Rect, ctm: Matrix): string {
  const inv = invert(ctm);
  if (!inv) throw new PdfError('UNSUPPORTED', 'Degenerate transformation matrix');
  const toUser = ctm.every((v, i) => v === [1, 0, 0, 1, 0, 0][i]) ? '' : `${inv.map(num).join(' ')} cm `;
  const r = [bbox.x0 - BG_PAD, bbox.y0 - BG_PAD, bbox.x1 - bbox.x0 + 2 * BG_PAD, bbox.y1 - bbox.y0 + 2 * BG_PAD];
  return `q ${toUser}${colorOp(c, false)} ${r.map(num).join(' ')} re f Q`;
}

const shiftRect = (r: Rect, dx: number, dy: number): Rect => ({ x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy });

function familyRequest(family: string): FontRequest {
  const p = parseFontName(family);
  return { name: family, bold: p.bold, italic: p.italic, serif: /serif|times|roman|georgia|cambria/i.test(family) && !/sans/i.test(family), mono: /mono|courier|consol/i.test(family) };
}

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

const union = (rs: Rect[]): Rect => ({ x0: Math.min(...rs.map((r) => r.x0)), y0: Math.min(...rs.map((r) => r.y0)), x1: Math.max(...rs.map((r) => r.x1)), y1: Math.max(...rs.map((r) => r.y1)) });

function pathBox(p: PathItem): Rect | null {
  const rs = [...p.rects, ...p.segments.map((s) => ({ x0: Math.min(s.x0, s.x1), y0: Math.min(s.y0, s.y1), x1: Math.max(s.x0, s.x1), y1: Math.max(s.y0, s.y1) }))];
  if (!rs.length) return null;
  const half = p.paint === 'fill' ? 0 : p.lineWidth / 2;
  const u = union(rs);
  return { x0: u.x0 - half, y0: u.y0 - half, x1: u.x1 + half, y1: u.y1 + half };
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

/** Applies the full op list to the original bytes and saves the result as an incremental update. */
export async function applyEdits(original: Uint8Array, ops: EditOperation[], opts: { force?: ForceStrategy } = {}): Promise<ApplyResult> {
  const { doc, decrypted } = await loadPdf(original);
  const snapshot = decrypted ? null : snapshotObjects(doc.context);
  const analyses = analyzeDocument(doc, tableDefinitions(ops));
  const pages: PageModel[] = analyses.map((a) => structuredClone(a.model));
  const state = reduceEdits(pages, ops);
  const reports: StrategyReport[] = [];
  const warnings: string[] = [];
  const patches = new Map<string, { info: StreamInfo; patch: StreamPatch; pageIndex: number }>();
  const fonts = new FontEmbedder(doc);
  /** Content appended at the end of a page, in the page's initial graphics state. */
  const tail = new Map<number, string[]>();
  const addTail = (pageIndex: number, content: string) => tail.set(pageIndex, [...(tail.get(pageIndex) ?? []), content]);

  const patchOf = (a: PageAnalysis, streamId: string) => {
    let p = patches.get(streamId);
    if (!p) {
      const info = a.interp.streams.get(streamId)!;
      if (info.uses > 1) warnings.push(`Form XObject ${streamId} is painted ${info.uses} times; the edit changes every copy`);
      p = { info, patch: emptyPatch(), pageIndex: a.pageIndex };
      patches.set(streamId, p);
    }
    return p.patch;
  };
  const remove = (a: PageAnalysis, runs: RunInternal[]) => {
    for (const r of runs) patchOf(a, r.streamId).replace.set(r.opIndex, removalOp(r));
  };

  // Cells are laid out once to measure row growth and again to place them; the strategy is chosen once.
  const chosenCache = new Map<string, Promise<Chosen>>();
  const choose = (a: PageAnalysis, box: BoxInternal, text: string, overflow: Parameters<typeof layoutBox>[2], wrapWidth?: number, style?: LayoutStyle) => {
    const key = JSON.stringify([a.pageIndex, box.id, text, overflow, wrapWidth, style]);
    let c = chosenCache.get(key);
    if (!c) chosenCache.set(key, (c = chooseStrategy(a, box, text, overflow, fonts, opts.force, wrapWidth, style)));
    return c;
  };

  /** Lays out `text` in the style of `box` and inserts it after the box's text object, translated by (dx, dy). */
  const place = async (a: PageAnalysis, box: BoxInternal, text: string, elementId: string, o: { overflow?: Parameters<typeof layoutBox>[2]; wrapWidth?: number; dx: number; dy: number; style?: LayoutStyle; background?: Color | null; onTop?: boolean }) => {
    const r0 = box.runs[0]!;
    const chosen = await choose(a, box, text, o.overflow, o.wrapWidth, o.style);
    const layout = chosen.layout;
    reports.push({
      elementId,
      pageIndex: a.pageIndex,
      strategy: chosen.strategy,
      fontName: r0.font.cleanName,
      ...(chosen.substituteFont ? { substituteFont: chosen.substituteFont } : {}),
      glyphs: layout.glyphs,
      warnings: [...chosen.warnings, ...layout.warnings],
    });
    if (chosen.strategy === 'none') return null;
    const moved = Math.abs(o.dx) > 1e-6 || Math.abs(o.dy) > 1e-6;
    const body = o.background ? `${backgroundFill(o.background, layout.bbox, r0.ctm)}\n${layout.content}` : layout.content;
    const content = moved ? `q ${translateIn(r0.ctm, o.dx, o.dy)}\n${body}\nQ` : body;
    // With a fill, the moved text must sit on top of whatever the page paints at the destination,
    // which may come later in the stream than the original text: draw it at the end of the page.
    if (((moved && o.background) || o.onTop) && r0.streamId === `page:${a.pageIndex}`) {
      addTail(a.pageIndex, `q ${r0.ctm.map(num).join(' ')} cm\n${content}\nQ`);
      return shiftRect(layout.bbox, o.dx, o.dy);
    }
    const p = patchOf(a, r0.streamId);
    const at = r0.etIndex >= 0 ? r0.etIndex : a.interp.streams.get(r0.streamId)!.content.ops.length - 1;
    p.insertAfter.set(at, [...(p.insertAfter.get(at) ?? []), content]);
    return shiftRect(layout.bbox, o.dx, o.dy);
  };

  /**
   * New text (addTextBox, text in tables with no text to copy the style from). A font the page
   * already uses (`fontFamily` = its name) is used as is when it has every glyph (S1); otherwise
   * the family is looked up like an S2 substitute and embedded.
   */
  const placeNew = async (ab: AddedBox, measure = false): Promise<TextBox | null> => {
    const a = analyses[ab.pageIndex]!;
    const pageStream = a.interp.streams.get(`page:${ab.pageIndex}`)!;
    const family = ab.fontFamily ?? 'Helvetica';
    const report: StrategyReport = { elementId: ab.id, pageIndex: ab.pageIndex, strategy: 'none', fontName: family, glyphs: { original: 0, composed: 0, fallback: 0, substitute: 0 }, warnings: [] };
    if (!measure) reports.push(report);
    const paragraphs = ab.text.split('\n');
    const chars = ab.text.replace(/\n/g, '');
    /** Glyph to show (`bytes`) or a space drawn as a displacement (`bytes` null); width in 1/1000 em. */
    type G = { ch: string; bytes: number[] | null; width: number };
    let glyphs: G[][];
    let key: string;
    let ascent: number;
    let descent: number;

    const own = a.interp.runs.find((r) => r.streamId === pageStream.id && r.font.cleanName === family && r.decodable && !r.font.isType3);
    const encoded = own ? paragraphs.map((p) => encodeForFont(own.font, p)) : [];
    if (own && encoded.every((e) => !e.missing.length && !e.reason)) {
      glyphs = encoded.map((e) => e.items.map((it): G => ({ ch: it.ch, bytes: it.kind === 'glyph' ? it.bytes : null, width: it.width })));
      key = own.state.fontKey;
      ascent = own.font.ascent / 1000;
      descent = own.font.descent / 1000;
      report.strategy = 'original';
      report.glyphs.original = [...chars].length;
    } else {
      const req = own ? fontRequest(own.font) : familyRequest(family);
      const hit = findSubstitute(req);
      let face: LoadedFace | undefined = hit ? loadFace(hit.face) : undefined;
      if (face && !faceCovers(face, chars)) face = undefined;
      face ??= findFallback(req, chars);
      if (!face) {
        report.warnings.push(`NO_GLYPH_SOURCE: no font covers the text of ${ab.id}; it was not added`);
        return null;
      }
      if (own) report.warnings.push(`${family} in this file lacks glyphs for: ${[...new Set(encoded.flatMap((e) => e.missing))].join(' ')}`);
      if (!hit || hit.face.file !== face.file) report.warnings.push(`${family} is not available; used ${face.postscriptName}`);
      report.strategy = 'substitute';
      report.substituteFont = face.postscriptName;
      report.glyphs.substitute = [...chars].length;
      const pdfFont = await fonts.embed(face);
      key = fonts.resourceKey(ab.pageIndex, pageStream, pdfFont);
      glyphs = paragraphs.map((p) => [...p].map((ch): G => ({ ch, ...fonts.glyph(pdfFont, ch) })));
      ascent = face.font.ascent / face.font.unitsPerEm;
      descent = face.font.descent / face.font.unitsPerEm;
    }

    const size = ab.fontSize;
    const maxW = ((ab.bbox.x1 - ab.bbox.x0) * 1000) / size;
    const widthOf = (gs: G[]) => gs.reduce((s, g) => s + g.width, 0);
    const lines: G[][] = [];
    const paraEnds = new Set<number>();
    for (const para of glyphs) {
      let cur: G[] = [];
      let word: G[] = [];
      const flush = () => {
        const trimmed = [...cur, ...word];
        while (trimmed.length && trimmed[trimmed.length - 1]!.ch === ' ') trimmed.pop();
        if (cur.length && widthOf(trimmed) > maxW) {
          while (cur.length && cur[cur.length - 1]!.ch === ' ') cur.pop();
          lines.push(cur);
          cur = word;
        } else cur = [...cur, ...word];
        word = [];
      };
      for (const g of para) {
        word.push(g);
        if (g.ch === ' ') flush();
      }
      flush();
      paraEnds.add(lines.length);
      lines.push(cur);
    }
    const lh = size * (ab.lineSpacing ?? 1.2);
    const hex = (bytes: number[]) => '<' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('') + '>';
    /** `extra`: added advance per space (1/1000 em), for justified lines. */
    const tj = (line: G[], extra = 0) =>
      '[' + line.map((g) => (g.ch !== ' ' || !extra ? (g.bytes ? hex(g.bytes) : num(-g.width)) : g.bytes ? `${hex(g.bytes)} ${num(-extra)}` : num(-g.width - extra))).join(' ') + '] TJ';
    const y0 = ab.bbox.y1 - ascent * size;
    const boxW = ab.bbox.x1 - ab.bbox.x0;
    const lineX = (l: G[]) => {
      const w = (widthOf(l) * size) / 1000;
      return ab.align === 'right' ? boxW - w : ab.align === 'center' ? (boxW - w) / 2 : 0;
    };
    // One Tm per line so each line can start at its own x; justified lines widen their spaces with TJ gaps.
    const body = lines
      .map((l, i) => {
        const spaces = l.filter((g) => g.ch === ' ').length;
        const extra = ab.align === 'justify' && !paraEnds.has(i) && spaces ? Math.max(0, (maxW - widthOf(l)) / spaces) : 0;
        return `1 0 0 1 ${num(ab.bbox.x0 + lineX(l))} ${num(y0 - i * lh)} Tm ${tj(l, extra)}`;
      })
      .join('\n');
    const bottom = y0 - (lines.length - 1) * lh + descent * size;
    const bbox = { ...ab.bbox, y0: Math.min(ab.bbox.y0, bottom) };
    if (measure) return { id: ab.id, runs: [], bbox, lineHeight: lh, align: ab.align ?? 'left', text: ab.text };
    const fill = ab.background ? `${backgroundFill(ab.background, bbox, [1, 0, 0, 1, 0, 0])}\n` : '';
    addTail(ab.pageIndex, `${fill}q BT /${key} ${num(size)} Tf ${colorOp(ab.color, false)}\n${body}\nET Q`);
    return { id: ab.id, runs: [], bbox, lineHeight: lh, align: ab.align ?? 'left', text: ab.text };
  };

  /** `q cm … Q` around ops first..last, translating what they paint by (dx, dy) in user space. */
  const shiftOps = (a: PageAnalysis, streamId: string, first: number, last: number, ctm: Matrix, dx: number, dy: number) => {
    const p = patchOf(a, streamId);
    p.insertBefore.set(first, [...(p.insertBefore.get(first) ?? []), `q ${translateIn(ctm, dx, dy)}`]);
    p.insertAfter.set(last, [...(p.insertAfter.get(last) ?? []), 'Q']);
  };

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

  // Rows grow to fit their cells' text (merged cells grow their last row), before anything below moves.
  for (const te of state.tables.values()) {
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

  // Paths and images under a table whose bottom moved follow it, like the text boxes and tables there.
  const shiftedPaths = new Map<PathItem, { pageIndex: number; dy: number }>();
  const shiftedImages = new Map<ImageItem, { pageIndex: number; dy: number }>();
  for (const rf of reflowBelow(pages, state)) {
    const a = analyses[rf.pageIndex]!;
    const tablePaths = new Set(a.tables.flatMap((t) => t.paths));
    const cellImages = new Set(a.tables.flatMap((t) => [...t.cellImages.values()].flat()));
    const below = (r: Rect) => r.y1 <= rf.area.y0 + 1 && r.x1 >= rf.area.x0 && r.x0 <= rf.area.x1;
    for (const p of a.interp.paths) {
      const b = p.paint === 'none' || tablePaths.has(p) ? null : pathBox(p);
      if (b && below(b)) shiftedPaths.set(p, { pageIndex: rf.pageIndex, dy: (shiftedPaths.get(p)?.dy ?? 0) + rf.shift });
    }
    for (const im of a.interp.images) if (!cellImages.has(im) && below(im.bbox)) shiftedImages.set(im, { pageIndex: rf.pageIndex, dy: (shiftedImages.get(im)?.dy ?? 0) + rf.shift });
  }

  for (const edit of state.boxes.values()) {
    const a = analyses[edit.pageIndex]!;
    const box = a.boxes.find((b) => b.id === edit.boxId)!;
    const page = pages[edit.pageIndex]!;
    const modelIdx = page.textBoxes.findIndex((b) => b.id === edit.boxId);
    if (edit.deleted) {
      remove(a, box.runs);
      page.textBoxes.splice(modelIdx, 1);
      continue;
    }
    const text = edit.text ?? box.text;
    const st = edit.style;
    const style: LayoutStyle | undefined = st && { ...(st.color && { fill: [colorOp(st.color, false)] }), align: st.align, lineSpacing: st.lineSpacing };
    const bbox = await place(a, box, text, box.id, { overflow: edit.overflow, wrapWidth: edit.width, dx: edit.dx, dy: edit.dy, style, background: st?.background });
    if (!bbox) continue;
    remove(a, box.runs);
    const prev = page.textBoxes[modelIdx]!;
    const r0 = prev.runs[0]!;
    const lineHeight = st?.lineSpacing !== undefined ? st.lineSpacing * r0.fontSize * Math.hypot(r0.matrix[2], r0.matrix[3]) : prev.lineHeight;
    page.textBoxes[modelIdx] = { ...prev, text, bbox, align: st?.align ?? prev.align, lineHeight };
  }

  for (const ab of state.added.values()) {
    const tb = await placeNew(ab);
    if (tb) pages[ab.pageIndex]!.textBoxes.push(tb);
  }

  /** Resource name of image `im` in the page's own resources (registered under a free /TKImn name when it comes from a form). */
  const pageImageKey = (a: PageAnalysis, im: ImageItem): string | null => {
    const info = a.interp.streams.get(`page:${a.pageIndex}`)!;
    if (im.streamId === info.id && im.name) return im.name;
    if (!im.ref) return null;
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
    const known = [...dict.entries()].find(([, v]) => v === im.ref);
    if (known) return known[0].decodeText();
    let n = 1;
    while (dict.has(PDFName.of(`TKIm${n}`))) n++;
    dict.set(PDFName.of(`TKIm${n}`), im.ref);
    return `TKIm${n}`;
  };
  /** The scan under a raster table (the topmost image covering it) and its grid, or null with a warning. */
  const rasterOf = (a: PageAnalysis, orig: Table): Pick<RasterInput, 'image' | 'orig' | 'look' | 'borderWidth'> | null => {
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
    return { image: { ctm: im.ctm, key, bbox: im.bbox }, orig: grid, look: setup.raster, borderWidth: setup.borderWidth };
  };

  for (const te of state.tables.values()) {
    const a = analyses[te.pageIndex]!;
    const ti = a.tables.find((t) => t.table.id === te.tableId)!;
    const orig = ti.table;
    const page = pages[te.pageIndex]!;
    const tIdx = page.tables.findIndex((t) => t.id === te.tableId);
    const raster = rasterOf(a, orig);
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
    if (raster) {
      const anchors = te.cells.flatMap((row, r) =>
        row.flatMap((cell, c) => {
          const s = cellAnchor({ vertices: [], spans: te.spans }, r, c);
          return s.row === r && s.col === c ? [{ r, c, ...(cell.src && { src: cell.src }), blank: !!cell.edited, ...(cell.background !== undefined && { fill: cell.background }) }] : [];
        }),
      );
      const belowShift = tableBounds(te.ys, te.xs).y0 - orig.bbox.y0;
      addTail(te.pageIndex, rasterTableContent({ ...raster, next: { ys, xs, spans: te.spans, headerRows: te.headerRows }, cells: anchors, belowShift }));
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
    page.tables[tIdx] = {
      ...orig,
      bbox: { x0: xs[0]!, y0: ys[ys.length - 1]!, x1: xs[xs.length - 1]!, y1: ys[0]! },
      rows: ys.slice(0, -1).map((y, i) => ({ index: i, y0: ys[i + 1]!, y1: y })),
      cols: xs.slice(0, -1).map((x, i) => ({ index: i, x0: x, x1: xs[i + 1]! })),
      cells: newCells,
      ...(orig.setup && { setup: { ...orig.setup, vertices: ys.map((y) => xs.map((x) => ({ x, y, snapped: true }))), spans: te.spans, headerRows: te.headerRows } }),
      ...(orig.pattern && { pattern: { ...orig.pattern, zebra: te.zebra } }),
    };
  }

  for (const [p, { pageIndex, dy }] of shiftedPaths) shiftOps(analyses[pageIndex]!, p.streamId, p.opStart, p.opEnd - 1, p.ctm, 0, dy);
  for (const [im, { pageIndex, dy }] of shiftedImages) shiftOps(analyses[pageIndex]!, im.streamId, im.opIndex, im.opIndex, im.ctm, 0, dy);

  // Lowest point of everything that moved or changed, per page, against the page's bottom edge.
  const lowest = new Map<number, number>();
  const low = (pageIndex: number, y: number) => lowest.set(pageIndex, Math.min(lowest.get(pageIndex) ?? Infinity, y));
  for (const te of state.tables.values()) if (!te.deleted) low(te.pageIndex, te.ys[te.ys.length - 1]! + te.dy);
  for (const e of state.boxes.values()) {
    const b = e.deleted ? undefined : pages[e.pageIndex]!.textBoxes.find((x) => x.id === e.boxId);
    if (b) low(e.pageIndex, b.bbox.y0);
  }
  for (const [p, { pageIndex, dy }] of shiftedPaths) low(pageIndex, pathBox(p)!.y0 + dy);
  for (const [im, { pageIndex, dy }] of shiftedImages) low(pageIndex, im.bbox.y0 + dy);
  const overflows: PageOverflow[] = [];
  for (const [pageIndex, y] of lowest) {
    const by = pages[pageIndex]!.view.y0 - y;
    if (by <= 0.05) continue;
    overflows.push({ pageIndex, by: Math.round(by * 10) / 10 });
    warnings.push(`Content on page ${pageIndex + 1} extends ${by.toFixed(1)} pt past the bottom edge`);
  }

  for (const a of analyses) {
    const list = pages[a.pageIndex]!.tables.flatMap((t) => (t.setup ? [{ tableId: t.id, bbox: t.bbox, setup: t.setup, ...(t.pattern && { pattern: t.pattern }) }] : []));
    if (JSON.stringify(list) !== JSON.stringify(a.stored)) writeStoredTables(doc, doc.getPage(a.pageIndex), list);
  }

  for (const [pageIndex, contents] of tail) {
    const a = analyses[pageIndex]!;
    const p = patchOf(a, `page:${pageIndex}`);
    const last = a.interp.streams.get(`page:${pageIndex}`)!.content.ops.length - 1;
    if (last < 0) {
      p.insertAfter.set(-1, contents);
      continue;
    }
    // The original content may leave the CTM or clipping changed, so it is wrapped in q … Q.
    p.insertAfter.set(-1, ['q', ...(p.insertAfter.get(-1) ?? [])]);
    p.insertAfter.set(last, [...(p.insertAfter.get(last) ?? []), 'Q', ...contents]);
  }

  for (const [, { info, patch, pageIndex }] of patches) writeStream(doc, pageIndex, info, applyPatch(info.content, patch));
  await doc.flush();
  fonts.finalize();
  const bytes = snapshot ? writeIncremental(original, doc.context, snapshot) : await doc.save({ useObjectStreams: false });
  return { bytes, reports, warnings, pages, overflows };
}
