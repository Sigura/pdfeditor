import { findFallback, parseFontName, type FontRequest, type LoadedFace } from '../fonts/lookup.ts';
import type { PdfFont } from '../fonts/pdfFont.ts';
import { convertFontkitPath, type GlyphBox, type PathCmd } from '../fonts/program.ts';
import { encodeForFont, glyphUsable, programGid, type EncodedItem, type GlyphPart } from './coverage.ts';

type Mark = { spacing: string[]; below?: boolean; right?: boolean; under?: boolean };

/** Combining marks → spacing glyphs that can stand in for them. */
const MARKS: Record<string, Mark> = {
  '̀': { spacing: ['`', 'ˋ'] },
  '́': { spacing: ['´', 'ˊ'] },
  '̂': { spacing: ['ˆ', '^'] },
  '̃': { spacing: ['˜', '~'] },
  '̄': { spacing: ['¯', 'ˉ'] },
  '̆': { spacing: ['˘'] },
  '̇': { spacing: ['˙'] },
  '̈': { spacing: ['¨'] },
  '̊': { spacing: ['˚'] },
  '̋': { spacing: ['˝'] },
  '̌': { spacing: ['ˇ'] },
  '̧': { spacing: ['¸'], below: true },
  '̨': { spacing: ['˛'], below: true, right: true },
  '̦': { spacing: [','], below: true, under: true },
  '̣': { spacing: ['.'], below: true, under: true },
};

/** A glyph of the original font: an outline from its program, or a code to show (no program). */
type Own = { width: number; box: GlyphBox | null; part: GlyphPart };

export function fontRequest(font: PdfFont): FontRequest {
  const parsed = parseFontName(font.cleanName);
  return { name: font.cleanName, bold: parsed.bold || font.fontWeight >= 600, italic: parsed.italic || font.isItalic, serif: font.isSerif, mono: font.isFixedPitch };
}

const identity = (path: PathCmd[]): GlyphPart => ({ kind: 'path', path, dx: 0, dy: 0, sx: 1, sy: 1, stroke: 0 });

/**
 * S3 glyph sources for characters the original font has no code for, in order: (a) outline in
 * the embedded program, (b) NFD composition from the font's own glyphs, (c) a scaled fallback
 * font outline. Returns null for (d), so the caller reports NO_GLYPH_SOURCE.
 */
export class Emulator {
  readonly fallbackFaces = new Set<string>();
  private readonly req: FontRequest;
  private readonly ownCache = new Map<string, Own | null>();
  private readonly ratios = new Map<string, number>();

  constructor(private readonly font: PdfFont) {
    this.req = fontRequest(font);
  }

  get request(): FontRequest {
    return this.req;
  }

  private program() {
    return this.font.std14 || this.font.isType3 ? null : this.font.program().program;
  }

  own(ch: string): Own | null {
    if (this.ownCache.has(ch)) return this.ownCache.get(ch)!;
    const font = this.font;
    const prog = this.program();
    let res: Own | null = null;
    const r = encodeForFont(font, ch);
    const it = r.items.length === 1 && r.items[0]!.kind === 'glyph' ? r.items[0] : null;
    if (it && it.kind === 'glyph') {
      const gid = prog ? programGid(font, prog, it.code) : undefined;
      if (prog && glyphUsable(prog, gid, ch)) res = { width: it.width, box: prog.bbox(gid), part: identity(prog.path(gid)) };
      else if (!font.isType3) res = { width: it.width, box: null, part: { kind: 'text', font: 0, bytes: it.bytes, dx: 0, dy: 0 } };
    } else if (prog) {
      const gid = prog.gidForUnicode(ch);
      if (glyphUsable(prog, gid, ch)) res = { width: prog.advance(gid), box: prog.bbox(gid), part: identity(prog.path(gid)) };
    }
    this.ownCache.set(ch, res);
    return res;
  }

  emulate(ch: string): EncodedItem | null {
    const a = this.own(ch);
    if (a?.part.kind === 'path') return { kind: 'emulated', ch, width: a.width, parts: [a.part], source: 'original' };
    return this.compose(ch) ?? this.fallback(ch);
  }

  /** One S3 source only, also for characters S1 could draw (strategy comparison/debugging). */
  forced(ch: string, mode: 'outline' | 'compose' | 'fallback'): EncodedItem | null {
    if (mode === 'compose') return this.compose(ch);
    if (mode === 'fallback') return this.fallback(ch);
    const a = this.own(ch);
    return a?.part.kind === 'path' ? { kind: 'emulated', ch, width: a.width, parts: [a.part], source: 'original' } : null;
  }

  private xHeight(): number {
    return this.font.xHeight || this.own('x')?.box?.y1 || this.font.capHeight * 0.7;
  }

  /** Box of an original glyph; fonts without outlines (standard 14) get one from the font metrics. */
  private boxOf(ch: string, own: Own, mark?: Mark): GlyphBox {
    if (own.box) return own.box;
    const xh = this.xHeight();
    if (mark) return mark.below ? { x0: 0, y0: -200, x1: own.width, y1: 0 } : { x0: 0, y0: xh + 40, x1: own.width, y1: xh + 220 };
    const tall = /[\p{Lu}\p{N}bdfhklt]/u.test(ch);
    return { x0: 0, y0: 0, x1: own.width, y1: tall ? this.font.capHeight : xh };
  }

  private compose(ch: string): EncodedItem | null {
    if (this.font.isType3) return null;
    const nfd = [...ch.normalize('NFD')];
    if (nfd.length < 2) return null;
    const marks = nfd.slice(1).map((m) => MARKS[m]);
    if (marks.some((m) => !m)) return null;
    let baseCh = nfd[0]!;
    if (marks.some((m) => !m!.below) && (baseCh === 'i' || baseCh === 'j')) {
      const dotless = baseCh === 'i' ? 'ı' : 'ȷ';
      if (this.own(dotless)) baseCh = dotless;
    }
    const base = this.own(baseCh);
    if (!base) return null;
    const bb = this.boxOf(baseCh, base);
    const parts: GlyphPart[] = [base.part];
    const slant = -Math.tan((this.font.italicAngle * Math.PI) / 180);
    let top: number | null = null;
    for (const m of marks as Mark[]) {
      let src: Own | null = null;
      let srcCh = '';
      for (const s of m.spacing) {
        src = this.own(s);
        srcCh = s;
        if (src) break;
      }
      if (!src) return null;
      const mb = this.boxOf(srcCh, src, m);
      let dx = m.right ? bb.x1 - mb.x1 : (bb.x0 + bb.x1) / 2 - (mb.x0 + mb.x1) / 2;
      let dy = 0;
      if (!m.below) {
        // Spacing accents are drawn for lowercase: raise them by how far the base exceeds the x-height.
        dy = top === null ? Math.max(0, bb.y1 - this.xHeight()) : top + 40 - mb.y0;
        top = mb.y1 + dy;
      } else if (m.under) dy = Math.min(0, bb.y0) - 40 - mb.y1;
      dx += slant * dy;
      parts.push({ ...src.part, dx, dy });
    }
    return { kind: 'emulated', ch, width: base.width, parts, source: 'composed' };
  }

  /** Average-width ratio original/fallback over Latin letters both fonts have (1 when unknown). */
  private widthRatio(face: LoadedFace, sy: number): number {
    const key = face.file;
    const cached = this.ratios.get(key);
    if (cached !== undefined) return cached;
    const k = 1000 / face.font.unitsPerEm;
    let so = 0;
    let sf = 0;
    let n = 0;
    for (const c of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const r = encodeForFont(this.font, c);
      const it = r.items[0];
      if (r.items.length !== 1 || it?.kind !== 'glyph' || !face.font.hasGlyphForCodePoint(c.codePointAt(0)!)) continue;
      so += it.width;
      sf += face.font.glyphForCodePoint(c.codePointAt(0)!).advanceWidth * k * sy;
      n++;
    }
    const ratio = n >= 5 && sf > 0 ? Math.min(1.25, Math.max(0.8, so / sf)) : 1;
    this.ratios.set(key, ratio);
    return ratio;
  }

  private fallback(ch: string): EncodedItem | null {
    const face = findFallback(this.req, ch);
    if (!face) return null;
    const fk = face.font;
    const k = 1000 / fk.unitsPerEm;
    const g = fk.glyphForCodePoint(ch.codePointAt(0)!);
    const path = convertFontkitPath(g.path.commands as { command: string; args: number[] }[], k);
    const fx = fk.xHeight * k;
    const fc = fk.capHeight * k;
    const ox = this.xHeight();
    const oc = this.font.capHeight;
    const sy = /\p{Ll}/u.test(ch) && fx > 0 && ox > 0 ? ox / fx : fc > 0 && oc > 0 ? oc / fc : 1;
    // When the original font knows this character's advance, fit the glyph to that cell so it keeps
    // its side bearings at the original positions; otherwise use the average width ratio.
    const own = encodeForFont(this.font, ch).items;
    const ow = own.length === 1 && own[0]!.kind === 'glyph' ? own[0]!.width : 0;
    const fw = g.advanceWidth * k;
    const sx = ow > 0 && fw > 0 ? Math.min(1.3 * sy, Math.max(0.7 * sy, ow / fw)) : sy * this.widthRatio(face, sy);
    // A stroke of width w thickens stems by w; regular stems are ~85 units.
    const stroke = this.req.bold && !face.bold ? Math.min(80, Math.max(20, this.font.stemV ? this.font.stemV - 85 : 50)) : 0;
    this.fallbackFaces.add(face.postscriptName || face.family);
    return { kind: 'emulated', ch, width: fw * sx, parts: [{ kind: 'path', path, dx: 0, dy: 0, sx, sy, stroke: stroke / sx }], source: 'fallback' };
  }
}
