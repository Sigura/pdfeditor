import { PDFDict, PDFName, PDFRef, PDFStream, type PDFContext } from 'pdf-lib';
import type { Color, Matrix, Rect } from '@pdf-toolkit/shared';
import { parseContent, serializeOp, type ContentOp, type Operand, type ParsedContent } from '../content/parser.ts';
import { PdfFont } from '../fonts/pdfFont.ts';
import { IDENTITY, apply, mul, rectFromPoints, translate } from '../math.ts';
import { getDict, getName, numbers, getArray, streamBytes } from '../pdf/util.ts';

export type ColorState = Color & { ops: string[] };

export type TextState = {
  font: PdfFont | null;
  fontKey: string;
  size: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  render: number;
};

type GState = {
  ctm: Matrix;
  fill: ColorState;
  stroke: ColorState;
  lineWidth: number;
  text: TextState;
};

export type StreamInfo = {
  id: string;
  content: ParsedContent;
  resources: PDFDict | undefined;
  /** The pdf-lib object holding this stream (form XObject ref), undefined for page contents. */
  ref?: PDFRef;
  /** Number of times this form is painted on the page (shared forms make edits global). */
  uses: number;
};

export type RunInternal = {
  id: string;
  streamId: string;
  opIndex: number;
  op: ContentOp;
  btIndex: number;
  etIndex: number;
  text: string;
  codes: { code: number; len: number; unicode: string; width: number; isWordSpace: boolean }[];
  /** Offsets (text space, along x) of each glyph start, after TJ adjustments. */
  glyphX: number[];
  /** Total advance in text space units (along x). */
  advance: number;
  decodable: boolean;
  font: PdfFont;
  state: TextState;
  tm: Matrix;
  tlm: Matrix;
  ctm: Matrix;
  fill: ColorState;
  stroke: ColorState;
  bbox: Rect;
  /** Baseline start/end in user space. */
  origin: [number, number];
  end: [number, number];
  /** Font size in user space (vertical scale of Tm×CTM × Tfs). */
  userSize: number;
  /** Baseline direction angle in radians. */
  angle: number;
};

export type Segment = { x0: number; y0: number; x1: number; y1: number };

export type PathItem = {
  streamId: string;
  opStart: number;
  opEnd: number;
  segments: Segment[];
  rects: Rect[];
  curves: boolean;
  paint: 'stroke' | 'fill' | 'fillStroke' | 'none';
  fill: ColorState;
  stroke: ColorState;
  /** Line width in user space. */
  lineWidth: number;
  ctm: Matrix;
  /** Paint order among paths and images. */
  seq: number;
};

/** `name`: resource name in its stream (absent for an inline image); `ref`: the image XObject (absent for a direct object). */
export type ImageItem = { streamId: string; opIndex: number; bbox: Rect; ctm: Matrix; seq: number; name?: string; ref?: PDFRef };

export type InterpretResult = {
  streams: Map<string, StreamInfo>;
  runs: RunInternal[];
  paths: PathItem[];
  images: ImageItem[];
  warnings: string[];
};

const BLACK = (space: 'gray' | 'rgb' | 'cmyk' = 'gray'): ColorState => ({ space, values: space === 'cmyk' ? [0, 0, 0, 1] : space === 'rgb' ? [0, 0, 0] : [0], ops: [] });

export class FontCache {
  private readonly cache = new Map<PDFDict, PdfFont>();
  get(dict: PDFDict, ref?: PDFRef): PdfFont {
    let f = this.cache.get(dict);
    if (!f) {
      f = new PdfFont(dict, ref);
      this.cache.set(dict, f);
    }
    return f;
  }
}

const numOf = (o: Operand | undefined): number => (o?.t === 'num' ? o.v : 0);

export function interpretPage(
  ctx: PDFContext,
  pageIndex: number,
  contentBytes: Uint8Array,
  resources: PDFDict | undefined,
  fonts: FontCache,
): InterpretResult {
  const result: InterpretResult = { streams: new Map(), runs: [], paths: [], images: [], warnings: [] };
  const pageStream: StreamInfo = { id: `page:${pageIndex}`, content: parseContent(contentBytes), resources, uses: 1 };
  result.streams.set(pageStream.id, pageStream);
  const initial: GState = {
    ctm: IDENTITY,
    fill: BLACK(),
    stroke: BLACK(),
    lineWidth: 1,
    text: { font: null, fontKey: '', size: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0, render: 0 },
  };
  runStream(ctx, pageIndex, pageStream, initial, fonts, result, 0, new Set());
  return result;
}

function runStream(
  ctx: PDFContext,
  pageIndex: number,
  stream: StreamInfo,
  start: GState,
  fonts: FontCache,
  out: InterpretResult,
  depth: number,
  active: Set<string>,
): void {
  const ops = stream.content.ops;
  let gs: GState = { ...start, text: { ...start.text } };
  const stack: GState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let btIndex = -1;
  let openRuns: RunInternal[] = [];
  let pathSegs: Segment[] = [];
  let pathRects: Rect[] = [];
  let pathCurves = false;
  let pathStart = -1;
  let cur: [number, number] = [0, 0];
  let subStart: [number, number] = [0, 0];

  const fontFromResources = (key: string): PdfFont | null => {
    const fontDict = getDict(stream.resources, 'Font');
    const raw = fontDict?.get(PDFName.of(key));
    const ref = raw instanceof PDFRef ? raw : undefined;
    const d = fontDict?.lookup(PDFName.of(key));
    if (!(d instanceof PDFDict)) return null;
    return fonts.get(d, ref);
  };

  const setColor = (target: 'fill' | 'stroke', op: ContentOp, space?: 'gray' | 'rgb' | 'cmyk' | 'other') => {
    const prev = gs[target];
    const values = op.operands.filter((o) => o.t === 'num').map((o) => (o as { v: number }).v);
    let sp = space ?? prev.space;
    if (!space && (op.op === 'sc' || op.op === 'scn' || op.op === 'SC' || op.op === 'SCN')) {
      if (op.operands.some((o) => o.t === 'name')) sp = 'other';
    }
    const opText = serializeOp(op.op, op.operands);
    const ops = op.op === 'cs' || op.op === 'CS' ? [opText] : op.op.toLowerCase() === 'sc' || op.op.toLowerCase() === 'scn' ? [...prev.ops.filter((o) => / (cs|CS)$/.test(o)), opText] : [opText];
    gs[target] = { space: sp, values, ops };
  };

  const csSpace = (n: string): 'gray' | 'rgb' | 'cmyk' | 'other' =>
    n === 'DeviceGray' || n === 'G' ? 'gray' : n === 'DeviceRGB' || n === 'RGB' ? 'rgb' : n === 'DeviceCMYK' || n === 'CMYK' ? 'cmyk' : 'other';

  const flushPath = (i: number, paint: PathItem['paint']) => {
    if (pathSegs.length || pathRects.length) {
      const scale = Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) || 1;
      out.paths.push({
        streamId: stream.id,
        opStart: pathStart < 0 ? i : pathStart,
        opEnd: i + 1,
        segments: pathSegs,
        rects: pathRects,
        curves: pathCurves,
        paint,
        fill: gs.fill,
        stroke: gs.stroke,
        lineWidth: Math.max(gs.lineWidth, 0) * scale,
        ctm: gs.ctm,
        seq: out.paths.length + out.images.length,
      });
    }
    pathSegs = [];
    pathRects = [];
    pathCurves = false;
    pathStart = -1;
  };

  const show = (i: number, op: ContentOp, items: Operand[]) => {
    const st = gs.text;
    const font = st.font;
    if (!font) {
      out.warnings.push(`Text shown without a font at ${stream.id} op ${i}`);
      return;
    }
    const startTm = tm;
    const codes: RunInternal['codes'] = [];
    const glyphX: number[] = [];
    let text = '';
    let x = 0;
    const fs = st.size;
    const th = st.hScale;
    for (const item of items) {
      if (item.t === 'num') {
        const adj = (-item.v / 1000) * fs * th;
        x += adj;
        if (item.v < -200 && text && !text.endsWith(' ')) text += ' ';
        continue;
      }
      if (item.t !== 'str') continue;
      for (const g of font.decode(item.v)) {
        glyphX.push(x);
        codes.push(g);
        text += g.unicode;
        x += ((g.width / 1000) * fs + st.charSpacing + (g.isWordSpace ? st.wordSpacing : 0)) * th;
      }
    }
    tm = mul(translate(x, 0), tm);
    const trm = mul(startTm, gs.ctm);
    const desc = (font.descent / 1000) * fs + st.rise;
    const asc = (font.ascent / 1000) * fs + st.rise;
    const corners: [number, number][] = [apply(trm, 0, desc), apply(trm, x, desc), apply(trm, 0, asc), apply(trm, x, asc)];
    const origin = apply(trm, 0, st.rise);
    const end = apply(trm, x, st.rise);
    const userSize = Math.hypot(trm[2], trm[3]) * fs;
    const run: RunInternal = {
      id: `p${pageIndex}-${stream.id.replace(':', '')}-o${i}`,
      streamId: stream.id,
      opIndex: i,
      op,
      btIndex,
      etIndex: -1,
      text,
      codes,
      glyphX,
      advance: x,
      decodable: !text.includes('�') && !font.vertical && codes.length > 0,
      font,
      state: { ...st },
      tm: startTm,
      tlm,
      ctm: gs.ctm,
      fill: gs.fill,
      stroke: gs.stroke,
      bbox: rectFromPoints(corners),
      origin,
      end,
      userSize,
      angle: Math.atan2(trm[1], trm[0]),
    };
    out.runs.push(run);
    openRuns.push(run);
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const a = op.operands;
    switch (op.op) {
      case 'q':
        stack.push({ ...gs, text: { ...gs.text } });
        break;
      case 'Q':
        if (stack.length) gs = stack.pop()!;
        break;
      case 'cm':
        gs.ctm = mul([numOf(a[0]), numOf(a[1]), numOf(a[2]), numOf(a[3]), numOf(a[4]), numOf(a[5])], gs.ctm);
        break;
      case 'w':
        gs.lineWidth = numOf(a[0]);
        break;
      case 'gs': {
        const ext = getDict(getDict(stream.resources, 'ExtGState'), a[0]?.t === 'name' ? a[0].v : '');
        if (ext) {
          const lw = ext.lookup(PDFName.of('LW'));
          if (lw) gs.lineWidth = Number(lw.toString()) || gs.lineWidth;
        }
        break;
      }
      case 'g': setColor('fill', op, 'gray'); break;
      case 'G': setColor('stroke', op, 'gray'); break;
      case 'rg': setColor('fill', op, 'rgb'); break;
      case 'RG': setColor('stroke', op, 'rgb'); break;
      case 'k': setColor('fill', op, 'cmyk'); break;
      case 'K': setColor('stroke', op, 'cmyk'); break;
      case 'cs': setColor('fill', op, csSpace(a[0]?.t === 'name' ? a[0].v : '')); gs.fill.values = gs.fill.space === 'cmyk' ? [0, 0, 0, 1] : gs.fill.space === 'rgb' ? [0, 0, 0] : [0]; break;
      case 'CS': setColor('stroke', op, csSpace(a[0]?.t === 'name' ? a[0].v : '')); break;
      case 'sc': case 'scn': setColor('fill', op); break;
      case 'SC': case 'SCN': setColor('stroke', op); break;

      case 'm':
        if (pathStart < 0) pathStart = i;
        cur = apply(gs.ctm, numOf(a[0]), numOf(a[1]));
        subStart = cur;
        break;
      case 'l': {
        if (pathStart < 0) pathStart = i;
        const p = apply(gs.ctm, numOf(a[0]), numOf(a[1]));
        pathSegs.push({ x0: cur[0], y0: cur[1], x1: p[0], y1: p[1] });
        cur = p;
        break;
      }
      case 'c': case 'v': case 'y': {
        if (pathStart < 0) pathStart = i;
        const n = op.op === 'c' ? 4 : 2;
        cur = apply(gs.ctm, numOf(a[n]), numOf(a[n + 1]));
        pathCurves = true;
        break;
      }
      case 'h':
        if (cur[0] !== subStart[0] || cur[1] !== subStart[1]) pathSegs.push({ x0: cur[0], y0: cur[1], x1: subStart[0], y1: subStart[1] });
        cur = subStart;
        break;
      case 're': {
        if (pathStart < 0) pathStart = i;
        const [x, y, w, h] = [numOf(a[0]), numOf(a[1]), numOf(a[2]), numOf(a[3])];
        const pts: [number, number][] = [apply(gs.ctm, x, y), apply(gs.ctm, x + w, y), apply(gs.ctm, x + w, y + h), apply(gs.ctm, x, y + h)];
        pathRects.push(rectFromPoints(pts));
        for (let k = 0; k < 4; k++) {
          const p = pts[k]!;
          const q = pts[(k + 1) % 4]!;
          pathSegs.push({ x0: p[0], y0: p[1], x1: q[0], y1: q[1] });
        }
        cur = pts[0]!;
        subStart = cur;
        break;
      }
      case 'S': case 's': flushPath(i, 'stroke'); break;
      case 'f': case 'F': case 'f*': flushPath(i, 'fill'); break;
      case 'B': case 'B*': case 'b': case 'b*': flushPath(i, 'fillStroke'); break;
      case 'n': flushPath(i, 'none'); break;
      case 'W': case 'W*': break;

      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        btIndex = i;
        openRuns = [];
        break;
      case 'ET':
        for (const r of openRuns) r.etIndex = i;
        openRuns = [];
        btIndex = -1;
        break;
      case 'Tc': gs.text.charSpacing = numOf(a[0]); break;
      case 'Tw': gs.text.wordSpacing = numOf(a[0]); break;
      case 'Tz': gs.text.hScale = numOf(a[0]) / 100; break;
      case 'TL': gs.text.leading = numOf(a[0]); break;
      case 'Ts': gs.text.rise = numOf(a[0]); break;
      case 'Tr': gs.text.render = numOf(a[0]); break;
      case 'Tf': {
        const key = a[0]?.t === 'name' ? a[0].v : '';
        gs.text.fontKey = key;
        gs.text.size = numOf(a[1]);
        gs.text.font = fontFromResources(key);
        if (!gs.text.font) out.warnings.push(`Font /${key} not found in resources (${stream.id})`);
        break;
      }
      case 'Td':
        tlm = mul(translate(numOf(a[0]), numOf(a[1])), tlm);
        tm = tlm;
        break;
      case 'TD':
        gs.text.leading = -numOf(a[1]);
        tlm = mul(translate(numOf(a[0]), numOf(a[1])), tlm);
        tm = tlm;
        break;
      case 'Tm':
        tlm = [numOf(a[0]), numOf(a[1]), numOf(a[2]), numOf(a[3]), numOf(a[4]), numOf(a[5])];
        tm = tlm;
        break;
      case 'T*':
        tlm = mul(translate(0, -gs.text.leading), tlm);
        tm = tlm;
        break;
      case 'Tj':
        show(i, op, a.slice(0, 1));
        break;
      case 'TJ':
        show(i, op, a[0]?.t === 'arr' ? a[0].v : []);
        break;
      case "'":
        tlm = mul(translate(0, -gs.text.leading), tlm);
        tm = tlm;
        show(i, op, a.slice(0, 1));
        break;
      case '"':
        gs.text.wordSpacing = numOf(a[0]);
        gs.text.charSpacing = numOf(a[1]);
        tlm = mul(translate(0, -gs.text.leading), tlm);
        tm = tlm;
        show(i, op, a.slice(2, 3));
        break;

      case 'Do': {
        const key = a[0]?.t === 'name' ? a[0].v : '';
        const xobjects = getDict(stream.resources, 'XObject');
        const raw = xobjects?.get(PDFName.of(key));
        const xo = xobjects?.lookup(PDFName.of(key));
        if (!(xo instanceof PDFStream)) break;
        const sub = getName(xo.dict, 'Subtype');
        if (sub === 'Image') {
          const pts: [number, number][] = [apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 0, 1), apply(gs.ctm, 1, 1)];
          out.images.push({ streamId: stream.id, opIndex: i, bbox: rectFromPoints(pts), ctm: gs.ctm, seq: out.paths.length + out.images.length, name: key, ...(raw instanceof PDFRef && { ref: raw }) });
        } else if (sub === 'Form' && raw instanceof PDFRef) {
          const id = `xobj:${raw.objectNumber}-${raw.generationNumber}`;
          if (active.has(id) || depth > 12) {
            out.warnings.push(`Recursive or too deeply nested form XObject ${id} skipped`);
            break;
          }
          let info = out.streams.get(id);
          if (info) info.uses++;
          else {
            info = { id, content: parseContent(streamBytes(xo)), resources: getDict(xo.dict, 'Resources') ?? stream.resources, ref: raw, uses: 1 };
            out.streams.set(id, info);
          }
          const fm = numbers(getArray(xo.dict, 'Matrix'));
          const formMatrix: Matrix = fm.length === 6 ? (fm as Matrix) : IDENTITY;
          const inner: GState = { ...gs, ctm: mul(formMatrix, gs.ctm), text: { ...gs.text } };
          active.add(id);
          // Each painting of a shared form produces runs again; only the first use is extracted to
          // keep one model element per operator.
          if (info.uses === 1) runStream(ctx, pageIndex, info, inner, fonts, out, depth + 1, active);
          active.delete(id);
        }
        break;
      }
      case 'BI': {
        const pts: [number, number][] = [apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 0, 1), apply(gs.ctm, 1, 1)];
        out.images.push({ streamId: stream.id, opIndex: i, bbox: rectFromPoints(pts), ctm: gs.ctm, seq: out.paths.length + out.images.length });
        break;
      }
    }
  }
  if (openRuns.length) out.warnings.push(`Unterminated text object in ${stream.id}`);
}
