import type { Align, Matrix, OverflowMode, Rect } from '@pdf-toolkit/shared';
import { serializeOperand } from '../content/parser.ts';
import { PdfError } from '../errors.ts';
import { apply, invert, mul, rectFromPoints, translate } from '../math.ts';
import type { BoxInternal } from '../model/group.ts';
import type { RunInternal } from '../model/interpreter.ts';
import type { PathCmd } from '../fonts/program.ts';
import { encodeForFont, type EncodedItem, type EncodeResult } from './coverage.ts';

export type GlyphCounts = { original: number; composed: number; fallback: number; substitute: number };

export type BoxLayout = {
  /** Content-stream operators drawing the new text (q … Q), empty when glyphs are missing. */
  content: string;
  bbox: Rect;
  glyphs: GlyphCounts;
  missing: string[];
  reason?: string;
  warnings: string[];
};

/** How the box text is turned into glyphs, and the font resources the glyph items refer to. */
export type BoxEncoding = {
  encode: (paragraph: string) => EncodeResult;
  /** Resource name per font slot; slot 0 is the first run's own font. */
  fontKeys: string[];
  /** Unicode font for the invisible (3 Tr) text layer over emulated glyphs. */
  layer?: { font: number; glyph: (ch: string) => { bytes: number[]; width: number } | undefined };
};

export function originalEncoding(box: BoxInternal): BoxEncoding {
  const r0 = box.runs[0]!;
  return { encode: (p) => encodeForFont(r0.font, p), fontKeys: [r0.state.fontKey] };
}

/**
 * A glyph position of the original line, in the first run's text space. `virtual` = a space shown
 * as a gap (code -2); code -1 marks a run in another style, which ends position matching.
 */
type OrigGlyph = { code: number; unicode: string; x: number; virtual: boolean };
type OrigLine = { x0: number; x1: number; y: number; glyphs: OrigGlyph[] };
type OutLine = { items: EncodedItem[]; paragraphEnd: boolean };

const fmt = (n: number): string => {
  const s = (Math.abs(n) < 1e-9 ? 0 : n).toFixed(4).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

const sameStyle = (a: RunInternal, b: RunInternal) =>
  a.font === b.font && a.state.size === b.state.size && a.state.hScale === b.state.hScale && a.state.charSpacing === b.state.charSpacing && a.state.wordSpacing === b.state.wordSpacing;

const isSpace = (it: EncodedItem) => it.ch === ' ';

const hex = (bytes: number[]) => '<' + Buffer.from(bytes).toString('hex') + '>';

function utf16Hex(text: string): string {
  const units: number[] = [0xfe, 0xff];
  for (let i = 0; i < text.length; i++) units.push(text.charCodeAt(i) >> 8, text.charCodeAt(i) & 0xff);
  return hex(units);
}

function pathOps(path: PathCmd[]): string {
  return path.map((c) => (c.op === 'Z' ? 'h' : `${c.p.map(fmt).join(' ')} ${c.op === 'M' ? 'm' : c.op === 'L' ? 'l' : 'c'}`)).join(' ');
}

const strokeFromFill = (ops: string[]) => ops.map((o) => o.replace(/ (g|rg|k|cs|sc|scn)$/, (m) => m.toUpperCase()));

/**
 * Lays out replacement text with the box's first run style (font resource, size, Tc/Tw/Tz/Ts/Tr,
 * fill color) in that run's text space. Lines keep the original baselines and start positions;
 * glyphs that match the original line keep their original positions (kerning, TJ gaps).
 */
/** setTextStyle overrides: fill color operators, alignment, baseline distance in multiples of the font size. */
export type LayoutStyle = { fill?: string[]; align?: Align; lineSpacing?: number };

/** `wrapWidth` (user space) replaces the original line width, e.g. after a resize. */
export function layoutBox(box: BoxInternal, text: string, overflow: OverflowMode | undefined, enc: BoxEncoding = originalEncoding(box), wrapWidth?: number, style: LayoutStyle = {}): BoxLayout {
  const r0 = box.runs[0]!;
  const font = r0.font;
  const st = r0.state;
  const fs = st.size;
  const th = st.hScale;
  const frame = mul(r0.tm, r0.ctm);
  const inv = invert(frame);
  if (!inv || fs === 0 || th === 0) throw new PdfError('UNSUPPORTED', `Box ${box.id} has a degenerate text matrix`);
  const local = (r: RunInternal, x: number) => apply(inv, ...apply(mul(r.tm, r.ctm), x, 0));
  const warnings: string[] = [];
  if (box.runs.some((r) => !sameStyle(r, r0))) warnings.push("Mixed fonts or sizes in this box were replaced by the first run's style");

  const advance = (it: EncodedItem): number => {
    const ws = it.kind === 'gap' || (it.kind === 'glyph' && (it.wordSpace ?? it.isWordSpace));
    return ((it.width / 1000) * fs + st.charSpacing + (ws ? st.wordSpacing : 0)) * th;
  };
  // Advance the viewer applies after showing the item (emulated glyphs and gaps show nothing).
  const rendered = (it: EncodedItem) => (it.kind === 'glyph' ? ((it.width / 1000) * fs + st.charSpacing + (it.isWordSpace ? st.wordSpacing : 0)) * th : 0);
  const sameGlyph = (it: EncodedItem, og: OrigGlyph) =>
    og.virtual ? isSpace(it) : it.kind === 'glyph' && it.font === 0 ? it.code === og.code : it.kind !== 'gap' && it.ch === og.unicode;

  const origLines: OrigLine[] = box.lines.map((l) => {
    const glyphs: OrigGlyph[] = [];
    let prevEnd: number | null = null;
    let prevUnicode = '';
    let x1 = -Infinity;
    for (const r of l.runs) {
      x1 = Math.max(x1, local(r, r.advance)[0]);
      if (!sameStyle(r, r0)) {
        glyphs.push({ code: -1, unicode: '', x: 0, virtual: false });
        prevEnd = null;
        continue;
      }
      r.codes.forEach((g, k) => {
        const x = local(r, r.glyphX[k]!)[0];
        // Mirrors the extractor, which inserts a space for large TJ gaps and gaps between runs.
        if (prevEnd !== null && x - prevEnd > 0.2 * fs * th && g.unicode !== ' ' && prevUnicode !== ' ') {
          glyphs.push({ code: -2, unicode: ' ', x: prevEnd, virtual: true });
        }
        glyphs.push({ code: g.code, unicode: g.unicode, x, virtual: false });
        prevEnd = x + ((g.width / 1000) * fs + st.charSpacing + (g.isWordSpace ? st.wordSpacing : 0)) * th;
        prevUnicode = g.unicode;
      });
    }
    return { x0: local(l.runs[0]!, 0)[0], x1, y: local(l.runs[0]!, 0)[1], glyphs };
  });
  const left = Math.min(...origLines.map((l) => l.x0));
  const right = Math.max(...origLines.map((l) => l.x1));
  const boxW = wrapWidth !== undefined ? wrapWidth / Math.hypot(frame[0], frame[1]) : right - left;
  const n0 = origLines.length;
  const origPitch = n0 > 1 ? (origLines[0]!.y - origLines[n0 - 1]!.y) / (n0 - 1) : fs * 1.2;
  const pitch = style.lineSpacing !== undefined ? style.lineSpacing * fs : origPitch;
  const align = style.align ?? box.align;
  // An explicit alignment repositions every line inside the box, including lines that kept their original glyphs.
  const realign = style.align !== undefined;

  const paragraphs = text.split('\n').map((p) => enc.encode(p));
  const missing = [...new Set(paragraphs.flatMap((p) => p.missing))];
  const reason = paragraphs.find((p) => p.reason)?.reason;
  const glyphs: GlyphCounts = { original: 0, composed: 0, fallback: 0, substitute: 0 };
  if (missing.length || reason) return { content: '', bbox: box.bbox, glyphs, missing, reason, warnings };

  const mode = overflow ?? (n0 > 1 || wrapWidth !== undefined ? 'wrap' : 'overflow');
  const lines: OutLine[] = [];
  for (const p of paragraphs) {
    if (mode !== 'wrap') {
      lines.push({ items: p.items, paragraphEnd: true });
      continue;
    }
    let cur: EncodedItem[] = [];
    let curW = 0;
    let word: EncodedItem[] = [];
    const width = (items: EncodedItem[]) => items.reduce((s, it) => s + advance(it), 0);
    const flushWord = () => {
      const w = width(word);
      if (cur.length && curW + w > boxW + 0.01 * fs) {
        while (cur.length && isSpace(cur[cur.length - 1]!)) cur.pop();
        lines.push({ items: cur, paragraphEnd: false });
        const start = word.findIndex((it) => !isSpace(it));
        cur = start < 0 ? [] : word.slice(start);
        curW = width(cur);
      } else {
        cur.push(...word);
        curW += w;
      }
      word = [];
    };
    for (const it of p.items) {
      if (isSpace(it) && word.length && !isSpace(word[word.length - 1]!)) flushWord();
      word.push(it);
    }
    flushWord();
    lines.push({ items: cur, paragraphEnd: true });
  }

  // Per-line glyph offsets from the line start: original positions while the glyphs match the
  // original line, natural advances after the first difference.
  const placed = lines.map((line, k) => {
    const orig = origLines[k];
    const offsets: number[] = [];
    let matched = 0;
    for (let i = 0; i < line.items.length; i++) {
      const it = line.items[i]!;
      const og = orig?.glyphs[i];
      if (matched === i && og && sameGlyph(it, og)) {
        offsets.push(og.x - orig.x0);
        matched++;
      } else offsets.push(i === 0 ? 0 : offsets[i - 1]! + advance(line.items[i - 1]!));
    }
    const last = line.items.length - 1;
    const width = last >= 0 ? offsets[last]! + advance(line.items[last]!) : 0;
    const exact = !!orig && matched === line.items.length && matched === orig.glyphs.length;
    return { ...line, offsets, width, exact };
  });

  let scale = 1;
  let heightLimited = false;
  if (mode === 'shrink') {
    const maxW = Math.max(...placed.map((l) => l.width));
    if (maxW > boxW) scale = boxW / maxW;
    const textH = ((font.ascent - font.descent) / 1000) * fs;
    const avail = (n0 - 1) * origPitch + textH;
    const need = (placed.length - 1) * pitch + textH;
    if (need > avail && avail / need < scale) {
      scale = avail / need;
      heightLimited = true;
    }
    if (scale < 0.25) {
      scale = 0.25;
      warnings.push('Text was shrunk to 25% and still overflows the original box');
    }
  }

  if (align === 'justify' && scale === 1) {
    for (const l of placed) {
      if (l.paragraphEnd || (l.exact && !realign)) continue;
      const spaces = l.items.map((it, i) => (isSpace(it) && i > 0 ? i : -1)).filter((i) => i > 0);
      const extra = boxW - l.width;
      if (!spaces.length || extra <= 0) continue;
      const per = extra / spaces.length;
      let add = 0;
      l.items.forEach((_, i) => {
        l.offsets[i]! += add;
        if (spaces.includes(i)) add += per;
      });
      l.width = boxW;
    }
  }

  const asc = (font.ascent / 1000) * fs;
  const desc = (font.descent / 1000) * fs;
  // Width-only shrinking keeps the first baseline; shrinking for height keeps the top edge.
  const first = heightLimited ? origLines[0]!.y + asc - asc * scale : origLines[0]!.y;
  const baseline = (k: number): number => {
    if (scale === 1 && style.lineSpacing !== undefined) return origLines[0]!.y - k * pitch;
    if (scale === 1) return k < n0 ? origLines[k]!.y : origLines[n0 - 1]!.y - (k - n0 + 1) * pitch;
    return first - k * pitch * scale;
  };
  const sfs = fs * scale;

  const body: string[] = [];
  const paths: string[] = [];
  const corners: [number, number][] = [];
  let curFont = 0;
  const tf = (f: number) => {
    if (f === curFont) return;
    body.push(`${serializeOperand({ t: 'name', v: enc.fontKeys[f]! })} ${fmt(sfs)} Tf`);
    curFont = f;
  };
  const render = st.render % 4;
  if (st.render >= 4) warnings.push('Clipping text render modes are not reproduced for emulated glyphs');
  const fillOps = style.fill ?? (r0.fill.ops.length ? r0.fill.ops : ['0 g']);
  const paint = (stroke: number) =>
    render === 1 ? 'S' : render === 2 ? 'B' : stroke > 0 ? `${strokeFromFill(fillOps).join(' ')} ${fmt(stroke)} w 1 j B` : 'f';
  placed.forEach((l, k) => {
    const w = l.width * scale;
    const orig = scale === 1 && !realign ? origLines[k] : undefined;
    const lx0 = orig?.x0 ?? left;
    const lx1 = orig?.x1 ?? (realign ? left + boxW : right);
    let x = lx0;
    if (!l.exact || realign) {
      if (align === 'right') x = lx1 - w;
      else if (align === 'center') x = (lx0 + lx1) / 2 - w / 2;
    }
    const y = baseline(k);
    corners.push(apply(frame, x, y + desc * scale), apply(frame, x + w, y + asc * scale));
    const at = (off: number, dy = 0): string => `${mul(translate(x + off, y + dy), r0.tm).map(fmt).join(' ')} Tm`;
    // A segment is one TJ in one font; the line's first segment starts at the line origin.
    let seg: { font: number; start: number; pos: number; parts: string[]; pending: number[] } | null = null;
    let first = true;
    const flushPending = () => {
      if (seg?.pending.length) seg.parts.push(hex(seg.pending));
      if (seg) seg.pending = [];
    };
    const flushSeg = () => {
      if (!seg) return;
      flushPending();
      tf(seg.font);
      body.push(`${at(seg.start)} [${seg.parts.join(' ')}] TJ`);
      seg = null;
    };
    l.items.forEach((it, i) => {
      const want = l.offsets[i]! * scale;
      if (it.kind === 'glyph') {
        if (seg && seg.font !== it.font) flushSeg();
        if (!seg) {
          seg = { font: it.font, start: first ? 0 : want, pos: first ? 0 : want, parts: [], pending: [] };
          first = false;
        }
        const diff = want - seg.pos;
        if (Math.abs(diff) > 1e-4) {
          flushPending();
          seg.parts.push(fmt((-diff * 1000) / (sfs * th)));
        }
        seg.pending.push(...it.bytes);
        seg.pos = want + rendered(it) * scale;
        if (it.font === 0) glyphs.original++;
        else glyphs.substitute++;
        return;
      }
      if (it.kind !== 'emulated') return;
      glyphs[it.source]++;
      const g = sfs / 1000;
      const texts = it.parts.filter((p) => p.kind === 'text');
      if (texts.length) {
        // Original glyphs placed as parts of a composed character: ActualText makes them extract as the character.
        flushSeg();
        body.push(`/Span <</ActualText ${utf16Hex(it.ch)}>> BDC`);
        for (const p of texts) {
          tf(p.font);
          body.push(`${at(want + p.dx * g * th, p.dy * g)} ${hex(p.bytes)} Tj`);
        }
        body.push('EMC');
      }
      for (const p of it.parts) {
        if (p.kind !== 'path' || render === 3) continue;
        const m = mul([p.sx * g * th, 0, 0, p.sy * g, p.dx * g * th, p.dy * g + st.rise * scale], mul(translate(x + want, y), r0.tm));
        paths.push(`q ${m.map(fmt).join(' ')} cm ${pathOps(p.path)} ${paint(p.stroke)} Q`);
      }
      if (!texts.length) {
        // Invisible (3 Tr) copy in a Unicode font, stretched to the emulated advance, kept in
        // reading order so extraction and selection see the character where it is drawn.
        const lg = enc.layer?.glyph(it.ch);
        if (lg && lg.width > 0 && enc.layer) {
          flushSeg();
          tf(enc.layer.font);
          body.push(`3 Tr ${fmt((100 * advance(it) * scale) / ((lg.width / 1000) * sfs))} Tz ${at(want)} ${hex(lg.bytes)} Tj ${st.render} Tr ${fmt(th * 100)} Tz`);
        } else if (render !== 3) warnings.push(`Emulated "${it.ch}" has no invisible text layer, so it isn't searchable`);
      }
    });
    flushSeg();
  });

  const stroke = [1, 2, 5, 6].includes(st.render) ? r0.stroke.ops : [];
  const content = [
    'q',
    'BT',
    ...fillOps,
    ...stroke,
    `${serializeOperand({ t: 'name', v: st.fontKey })} ${fmt(sfs)} Tf`,
    `${fmt(st.charSpacing * scale)} Tc ${fmt(st.wordSpacing * scale)} Tw ${fmt(th * 100)} Tz ${fmt(st.rise * scale)} Ts ${st.render} Tr`,
    ...body,
    'ET',
    ...paths,
    'Q',
  ].join('\n');

  if (scale === 1 && placed.length > n0) warnings.push(`Text needs ${placed.length} lines; the original box had ${n0}, so it extends below it`);
  return { content, bbox: corners.length ? rectFromPoints(corners) : box.bbox, glyphs, missing: [], warnings: [...new Set(warnings)] };
}
