import { PDFDict, PDFName } from 'pdf-lib';
import type { PdfFont } from '../fonts/pdfFont.ts';
import type { GlyphProgram, PathCmd } from '../fonts/program.ts';
import { getDict } from '../pdf/util.ts';

/** Piece of an emulated glyph; offsets in glyph space (1/1000 em) from the glyph origin. */
export type GlyphPart =
  | { kind: 'text'; font: number; bytes: number[]; dx: number; dy: number }
  | { kind: 'path'; path: PathCmd[]; dx: number; dy: number; sx: number; sy: number; stroke: number };

export type EncodedItem =
  /**
   * A glyph shown with font slot `font` (0 = the run's own font). `isWordSpace`: the viewer applies
   * Tw to it; `wordSpace` overrides whether the layout should add Tw (substitute fonts).
   */
  | { kind: 'glyph'; ch: string; code: number; bytes: number[]; width: number; isWordSpace: boolean; font: number; wordSpace?: boolean }
  /** A space the font has no glyph for, drawn as a TJ displacement instead. */
  | { kind: 'gap'; ch: string; width: number }
  /** S3: a glyph drawn from parts (outline paths or positioned original glyphs). */
  | { kind: 'emulated'; ch: string; width: number; parts: GlyphPart[]; source: 'original' | 'composed' | 'fallback' };

export type EncodeResult = { items: EncodedItem[]; missing: string[]; reason?: string };

type FontInfo = {
  inverse: Map<string, number[]>;
  maxKeyLen: number;
  program: GlyphProgram | null;
  /** Why glyph presence can't be checked (no S1 then). */
  uninspectable?: string;
};

const infoCache = new WeakMap<PdfFont, FontInfo>();

function loadProgram(font: PdfFont): { program: GlyphProgram | null; uninspectable?: string } {
  if (font.isType3) return { program: null };
  if (font.std14) return { program: null };
  const { program, error } = font.program();
  if (!program) return { program: null, uninspectable: font.programKind() === 'none' ? `font ${font.cleanName} is not embedded and not a standard-14 font` : error };
  return { program };
}

/** Glyph index of a code in the font's embedded program. */
export function programGid(font: PdfFont, program: GlyphProgram, code: number): number | undefined {
  if (font.isType0) {
    const cid = font.encodingCMap!.cid(code);
    return program.kind === 'TrueType' ? font.cidToGid(cid) : program.gidForCid(cid);
  }
  if (program.kind === 'Type1' || program.kind === 'CFF') {
    const name = font.glyphNames[code];
    return (name ? program.gidForName(name) : undefined) ?? program.builtinEncoding?.get(code);
  }
  // Simple TrueType/OpenType: symbolic fonts map codes through the (3,0) cmap, which fontkit
  // exposes as code points U+F0xx; non-symbolic ones map the glyph's Unicode value.
  const candidates = font.isSymbolic ? [code, 0xf000 + code].map((c) => String.fromCharCode(c)) : [...(font.unicodeOf(code) ?? '')];
  for (const ch of candidates) {
    const g = program.gidForUnicode(ch);
    if (g !== undefined) return g;
  }
  const name = font.glyphNames[code];
  return name ? program.gidForName(name) : undefined;
}

export function glyphUsable(program: GlyphProgram, gid: number | undefined, ch: string): gid is number {
  if (gid === undefined || gid <= 0 || gid >= program.numGlyphs) return false;
  if (/^\s$/u.test(ch)) return true;
  return program.hasOutline(gid);
}

function fontInfo(font: PdfFont): FontInfo {
  let info = infoCache.get(font);
  if (info) return info;
  const inverse = new Map<string, number[]>();
  const add = (u: string, code: number) => {
    const list = inverse.get(u);
    if (list) list.push(code);
    else inverse.set(u, [code]);
  };
  if (font.isType0) {
    for (const [code, u] of font.toUnicode?.toUnicode ?? []) add(u, code);
  } else {
    for (let c = 0; c < 256; c++) {
      const u = font.unicodeOf(c);
      if (u !== undefined) add(u, c);
    }
  }
  const maxKeyLen = Math.max(1, ...[...inverse.keys()].map((k) => k.length));
  info = { inverse, maxKeyLen, ...loadProgram(font) };
  infoCache.set(font, info);
  return info;
}

/** S1 check for one code: the glyph exists in the font the viewer will use, and the code has a width. */
function hasGlyph(font: PdfFont, info: FontInfo, code: number, ch: string): boolean {
  if (!font.hasWidth(code)) return false;
  if (font.isType3) {
    const name = font.glyphNames[code];
    const procs = getDict(font.dict, 'CharProcs');
    return !!(name && procs instanceof PDFDict && procs.has(PDFName.of(name)));
  }
  if (font.std14) return font.glyphNames[code] !== undefined;
  const p = info.program;
  if (!p) return false;
  return glyphUsable(p, programGid(font, p, code), ch);
}

/**
 * Maps text to codes of `font` for strategy S1, or lists the characters it can't draw.
 * `onMissing` may supply an item for a character the font has no code for (S3).
 */
export function encodeForFont(font: PdfFont, text: string, onMissing?: (ch: string) => EncodedItem | null): EncodeResult {
  const info = fontInfo(font);
  if (font.vertical) return { items: [], missing: [...new Set(text)], reason: 'vertical writing is not editable' };
  if (info.uninspectable && !onMissing) return { items: [], missing: [...new Set(text)], reason: info.uninspectable };
  const items: EncodedItem[] = [];
  const missing = new Set<string>();
  const chars = [...text];
  for (let i = 0; i < chars.length; ) {
    let done = false;
    for (let len = info.uninspectable ? 0 : Math.min(info.maxKeyLen, chars.length - i); len >= 1 && !done; len--) {
      const key = chars.slice(i, i + len).join('');
      const code = info.inverse.get(key)?.find((c) => hasGlyph(font, info, c, key));
      if (code === undefined) continue;
      const bytes = font.codeBytes(code);
      items.push({ kind: 'glyph', ch: key, code, bytes, width: font.widthOf(code), isWordSpace: bytes.length === 1 && code === 32, font: 0 });
      i += len;
      done = true;
    }
    if (done) continue;
    const ch = chars[i]!;
    const alt = ch === ' ' ? null : onMissing?.(ch);
    if (ch === ' ') items.push({ kind: 'gap', ch, width: font.hasWidth(32) && !font.isType0 ? font.widthOf(32) || 250 : 250 });
    else if (alt) items.push(alt);
    else missing.add(ch);
    i++;
  }
  return { items, missing: [...missing] };
}
