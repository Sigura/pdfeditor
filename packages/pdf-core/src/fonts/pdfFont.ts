import { Font as StdFont, FontNames } from '@pdf-lib/standard-fonts';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } from 'pdf-lib';
import { CMap, parseCMap } from './cmap.ts';
import { BASE_ENCODINGS, type BaseEncodingName, glyphNameToUnicode } from './encodings.ts';
import { type GlyphProgram, loadGlyphProgram } from './program.ts';
import { getArray, getDict, getName, getNum, getStream, numbers, streamBytes } from '../pdf/util.ts';

export type DecodedGlyph = {
  code: number;
  /** Number of bytes of the code in the string. */
  len: number;
  unicode: string;
  /** Horizontal advance in text space units × 1000 (i.e. glyph space for non-Type3 fonts). */
  width: number;
  /** Word spacing applies (single-byte code 32). */
  isWordSpace: boolean;
};

export type FontProgramKind = 'TrueType' | 'CFF' | 'OpenType' | 'Type1' | 'none';

const STD14_ALIASES: Record<string, string> = {
  Arial: 'Helvetica',
  ArialMT: 'Helvetica',
  'Arial-BoldMT': 'Helvetica-Bold',
  'Arial-ItalicMT': 'Helvetica-Oblique',
  'Arial-BoldItalicMT': 'Helvetica-BoldOblique',
  TimesNewRoman: 'Times-Roman',
  TimesNewRomanPSMT: 'Times-Roman',
  'TimesNewRomanPS-BoldMT': 'Times-Bold',
  'TimesNewRomanPS-ItalicMT': 'Times-Italic',
  'TimesNewRomanPS-BoldItalicMT': 'Times-BoldItalic',
  CourierNew: 'Courier',
  CourierNewPSMT: 'Courier',
  'CourierNewPS-BoldMT': 'Courier-Bold',
  Symbol: 'Symbol',
  ZapfDingbats: 'ZapfDingbats',
};

const STD14 = new Set<string>(Object.values(FontNames));

export function stripSubsetPrefix(name: string): string {
  return /^[A-Z]{6}\+/.test(name) ? name.slice(7) : name;
}

/** Maps a base font name to a standard-14 name, if it is one (or a common alias). */
export function standard14Name(baseName: string): string | undefined {
  const clean = stripSubsetPrefix(baseName);
  if (STD14.has(clean)) return clean;
  const [family, style] = clean.split(',');
  const alias = STD14_ALIASES[clean] ?? (family ? STD14_ALIASES[family] : undefined);
  if (!alias) return undefined;
  if (!style || alias === 'Symbol' || alias === 'ZapfDingbats') return alias;
  const bold = /bold/i.test(style);
  const italic = /italic|oblique/i.test(style);
  const base = alias.split('-')[0]!;
  const suffix = base === 'Times-Roman' || base === 'Times' ? (bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Roman') : bold && italic ? 'BoldOblique' : bold ? 'Bold' : italic ? 'Oblique' : '';
  const famBase = base === 'Times' || base === 'Times-Roman' ? 'Times' : base;
  return suffix ? `${famBase}-${suffix}` : famBase;
}

export class PdfFont {
  readonly dict: PDFDict;
  readonly ref: PDFRef | undefined;
  readonly subtype: string;
  readonly baseName: string;
  readonly isType0: boolean;
  readonly isType3: boolean;
  readonly descriptor: PDFDict | undefined;
  readonly cidFont: PDFDict | undefined;
  readonly encodingCMap: CMap | null;
  readonly toUnicode: CMap | null;
  /** code → glyph name for simple fonts (after Differences). */
  readonly glyphNames: (string | undefined)[] = [];
  readonly hasExplicitEncoding: boolean;
  readonly std14: string | undefined;
  readonly fontMatrix: number[];
  readonly vertical: boolean;
  readonly warnings: string[] = [];
  private readonly widths = new Map<number, number>();
  private readonly defaultWidth: number;
  private stdMetrics: ReturnType<typeof StdFont.load> | undefined;
  private gidMap: Uint8Array | null | undefined;
  private loaded: { program: GlyphProgram | null; error?: string } | undefined;

  constructor(dict: PDFDict, ref?: PDFRef) {
    this.dict = dict;
    this.ref = ref;
    this.subtype = getName(dict, 'Subtype') ?? 'Type1';
    this.baseName = getName(dict, 'BaseFont') ?? (this.subtype === 'Type3' ? 'Type3' : 'Unknown');
    this.isType0 = this.subtype === 'Type0';
    this.isType3 = this.subtype === 'Type3';
    const descendants = getArray(dict, 'DescendantFonts');
    const cid = descendants?.lookup(0);
    this.cidFont = cid instanceof PDFDict ? cid : undefined;
    this.descriptor = getDict(this.cidFont ?? dict, 'FontDescriptor');
    this.fontMatrix = this.isType3 ? numbers(getArray(dict, 'FontMatrix')) : [0.001, 0, 0, 0.001, 0, 0];
    if (this.fontMatrix.length !== 6) this.fontMatrix = [0.001, 0, 0, 0.001, 0, 0];

    const tu = getStream(dict, 'ToUnicode');
    this.toUnicode = tu ? safeCMap(tu, this.warnings, 'ToUnicode') : null;

    if (this.isType0) {
      const enc = dict.lookup(PDFName.of('Encoding'));
      if (enc instanceof PDFName) {
        const n = enc.decodeText();
        if (n === 'Identity-H' || n === 'Identity-V') this.encodingCMap = CMap.identity(n === 'Identity-V');
        else {
          // Predefined CMaps: UCS2/UTF16 ones carry Unicode directly; others are not bundled.
          const c = CMap.identity(n.endsWith('-V'));
          c.name = n;
          c.identity = false;
          this.encodingCMap = c;
        }
      } else if (enc instanceof PDFStream) {
        this.encodingCMap = safeCMap(enc, this.warnings, 'Encoding') ?? CMap.identity(false);
      } else this.encodingCMap = CMap.identity(false);
      this.vertical = this.encodingCMap.vertical;
      this.defaultWidth = getNum(this.cidFont, 'DW', 1000);
      this.readCidWidths();
      this.hasExplicitEncoding = true;
      this.std14 = undefined;
    } else {
      this.encodingCMap = null;
      this.vertical = false;
      this.std14 = this.descriptor && hasEmbeddedProgram(this.descriptor) ? undefined : standard14Name(this.baseName);
      this.hasExplicitEncoding = dict.has(PDFName.of('Encoding'));
      this.buildSimpleEncoding();
      const first = getNum(dict, 'FirstChar', 0);
      const w = getArray(dict, 'Widths');
      if (w) numbers(w).forEach((v, i) => this.widths.set(first + i, v));
      this.defaultWidth = getNum(this.descriptor, 'MissingWidth', 0);
      if (this.std14) this.stdMetrics = StdFont.load(this.std14 as FontNames);
    }
  }

  get cleanName(): string {
    return stripSubsetPrefix(this.baseName);
  }

  get isSubset(): boolean {
    return /^[A-Z]{6}\+/.test(this.baseName);
  }

  get flags(): number {
    return getNum(this.descriptor, 'Flags', 0);
  }

  get isSymbolic(): boolean {
    return (this.flags & 4) !== 0 && (this.flags & 32) === 0;
  }

  /** Ascent / descent in glyph space units (1/1000 em). */
  get ascent(): number {
    if (this.isType3) return this.type3Box()[3];
    const a = getNum(this.descriptor, 'Ascent', 0);
    if (a > 0) return a;
    return this.stdMetrics?.Ascender ?? 800;
  }

  get descent(): number {
    if (this.isType3) return this.type3Box()[1];
    const d = getNum(this.descriptor, 'Descent', 0);
    if (d < 0) return d;
    return this.stdMetrics?.Descender ?? -200;
  }

  get capHeight(): number {
    return getNum(this.descriptor, 'CapHeight', 0) || this.stdMetrics?.CapHeight || 700;
  }

  get xHeight(): number {
    return getNum(this.descriptor, 'XHeight', 0) || this.stdMetrics?.XHeight || 0;
  }

  get italicAngle(): number {
    return getNum(this.descriptor, 'ItalicAngle', 0) || this.stdMetrics?.ItalicAngle || 0;
  }

  get stemV(): number {
    return getNum(this.descriptor, 'StemV', 0) || this.stdMetrics?.StdVW || 0;
  }

  get fontWeight(): number {
    const fw = getNum(this.descriptor, 'FontWeight', 0);
    if (fw) return fw;
    return /bold|black|heavy|semibold|demi/i.test(this.cleanName) ? 700 : 400;
  }

  get isItalic(): boolean {
    return (this.flags & 64) !== 0 || this.italicAngle !== 0 || /italic|oblique/i.test(this.cleanName);
  }

  get isSerif(): boolean {
    if (this.flags & 2) return true;
    return /times|serif|georgia|garamond|roman|cambria|book|minion/i.test(this.cleanName) && !/sans/i.test(this.cleanName);
  }

  get isFixedPitch(): boolean {
    return (this.flags & 1) !== 0 || /courier|mono|consol/i.test(this.cleanName);
  }

  programKind(): FontProgramKind {
    const d = this.descriptor;
    if (!d) return 'none';
    if (d.has(PDFName.of('FontFile2'))) return 'TrueType';
    if (d.has(PDFName.of('FontFile'))) return 'Type1';
    const ff3 = getStream(d, 'FontFile3');
    if (ff3) return getName(ff3.dict, 'Subtype') === 'OpenType' ? 'OpenType' : 'CFF';
    return 'none';
  }

  programBytes(): Uint8Array | null {
    const d = this.descriptor;
    const s = getStream(d, 'FontFile2') ?? getStream(d, 'FontFile3') ?? getStream(d, 'FontFile');
    return s ? streamBytes(s) : null;
  }

  /** Type1 FontFile needs Length1/Length2 to split clear and encrypted parts. */
  type1Lengths(): { length1: number; length2: number } | null {
    const s = getStream(this.descriptor, 'FontFile');
    if (!s) return null;
    return { length1: getNum(s.dict, 'Length1', 0), length2: getNum(s.dict, 'Length2', 0) };
  }

  /** The embedded program, or null with the reason when there is none or it can't be parsed. */
  program(): { program: GlyphProgram | null; error?: string } {
    if (this.loaded) return this.loaded;
    const kind = this.programKind();
    const bytes = kind === 'none' ? null : this.programBytes();
    if (kind === 'none' || !bytes?.length) this.loaded = { program: null, error: kind === 'none' ? 'not embedded' : 'embedded font program is empty' };
    else {
      try {
        this.loaded = { program: loadGlyphProgram({ kind, bytes, length1: this.type1Lengths()?.length1 }) };
      } catch (e) {
        this.loaded = { program: null, error: `embedded ${kind} program could not be parsed: ${(e as Error).message}` };
        this.warnings.push(this.loaded.error!);
      }
    }
    return this.loaded;
  }

  private type3Box(): [number, number, number, number] {
    const bbox = numbers(getArray(this.dict, 'FontBBox'));
    const m = this.fontMatrix;
    if (bbox.length !== 4) return [0, -200, 1000, 800];
    return [bbox[0]! * m[0]! * 1000, bbox[1]! * m[3]! * 1000, bbox[2]! * m[0]! * 1000, bbox[3]! * m[3]! * 1000];
  }

  private readCidWidths(): void {
    const w = getArray(this.cidFont, 'W');
    if (!w) return;
    let i = 0;
    while (i < w.size()) {
      const first = w.lookup(i);
      const next = w.lookup(i + 1);
      if (!(first instanceof PDFNumber)) break;
      if (next instanceof PDFArray) {
        numbers(next).forEach((v, k) => this.widths.set(first.asNumber() + k, v));
        i += 2;
      } else {
        const last = next instanceof PDFNumber ? next.asNumber() : first.asNumber();
        const wv = w.lookup(i + 2);
        const width = wv instanceof PDFNumber ? wv.asNumber() : this.defaultWidth;
        for (let c = first.asNumber(); c <= last && c - first.asNumber() < 65536; c++) this.widths.set(c, width);
        i += 3;
      }
    }
  }

  private buildSimpleEncoding(): void {
    const enc = this.dict.lookup(PDFName.of('Encoding'));
    let base: BaseEncodingName | undefined;
    let diffs: PDFArray | undefined;
    if (enc instanceof PDFName) base = enc.decodeText() as BaseEncodingName;
    else if (enc instanceof PDFDict) {
      const b = getName(enc, 'BaseEncoding');
      if (b) base = b as BaseEncodingName;
      diffs = getArray(enc, 'Differences');
    }
    let table = base ? BASE_ENCODINGS[base] : undefined;
    const kind = this.programKind();
    if (!table && (kind === 'Type1' || kind === 'CFF')) {
      // Embedded Type1/CFF without a base encoding: the program's built-in encoding applies.
      const prog = this.program().program;
      if (prog?.builtinEncoding?.size) {
        const names: (string | undefined)[] = new Array(256).fill(undefined);
        for (const [code, gid] of prog.builtinEncoding) if (code < 256) names[code] = prog.nameOf(gid);
        table = names;
      }
    }
    if (!table) {
      if (this.std14 === 'Symbol') table = BASE_ENCODINGS.SymbolEncoding;
      else if (this.std14 === 'ZapfDingbats') table = BASE_ENCODINGS.ZapfDingbatsEncoding;
      else if (this.isType3 || this.subtype === 'TrueType' && this.isSymbolic) table = undefined;
      else table = BASE_ENCODINGS.StandardEncoding;
    }
    for (let c = 0; c < 256; c++) this.glyphNames[c] = table?.[c];
    if (diffs) {
      let code = 0;
      for (let i = 0; i < diffs.size(); i++) {
        const v = diffs.lookup(i);
        if (v instanceof PDFNumber) code = v.asNumber();
        else if (v instanceof PDFName) this.glyphNames[code++] = v.decodeText();
      }
    }
  }

  /** Width (glyph space, 1/1000) by code. */
  widthOf(code: number): number {
    if (this.isType0) {
      const cid = this.encodingCMap!.cid(code);
      return this.widths.get(cid) ?? this.defaultWidth;
    }
    const w = this.widths.get(code);
    if (w !== undefined) return this.isType3 ? w * this.fontMatrix[0]! * 1000 : w;
    if (this.stdMetrics) {
      const name = this.glyphNames[code];
      if (name) return this.stdMetrics.getWidthOfGlyph(name) ?? this.defaultWidth;
    }
    return this.defaultWidth;
  }

  /** True when the code has an explicit width (Widths/W/DW for embedded fonts, AFM metrics for standard-14). */
  hasWidth(code: number): boolean {
    if (this.isType0) return true;
    if (this.widths.has(code)) return true;
    const name = this.glyphNames[code];
    return !!(this.stdMetrics && name && this.stdMetrics.getWidthOfGlyph(name) !== undefined);
  }

  /** CID → glyph index of the embedded CIDFontType2 program (CIDToGIDMap). */
  cidToGid(cid: number): number {
    if (this.gidMap === undefined) {
      const map = this.cidFont?.lookup(PDFName.of('CIDToGIDMap'));
      this.gidMap = map instanceof PDFStream ? streamBytes(map) : null;
    }
    const b = this.gidMap;
    if (!b) return cid;
    return 2 * cid + 1 < b.length ? (b[2 * cid]! << 8) | b[2 * cid + 1]! : 0;
  }

  unicodeOf(code: number): string | undefined {
    const tu = this.toUnicode?.toUnicode.get(code);
    if (tu !== undefined) return tu;
    if (this.isType0) {
      const n = this.encodingCMap?.name ?? '';
      if (/^Uni.*(UCS2|UTF16)/.test(n)) return String.fromCharCode(code);
      return undefined;
    }
    const name = this.glyphNames[code];
    if (name) {
      const u = glyphNameToUnicode(name);
      if (u) return u;
    }
    if (this.subtype === 'TrueType' && this.isSymbolic && !this.hasExplicitEncoding) {
      // Symbolic TrueType without encoding: codes are often Unicode or F0xx-shifted Latin-1.
      return code >= 32 ? String.fromCharCode(code) : undefined;
    }
    return undefined;
  }

  decode(bytes: Uint8Array): DecodedGlyph[] {
    const codes = this.isType0 ? this.encodingCMap!.split(bytes) : Array.from(bytes, (code) => ({ code, len: 1 }));
    return codes.map(({ code, len }) => ({
      code,
      len,
      unicode: this.unicodeOf(code) ?? '�',
      width: this.widthOf(code),
      isWordSpace: len === 1 && code === 32,
    }));
  }

  /** Encodes a code as the bytes of a PDF string for this font. */
  codeBytes(code: number): number[] {
    if (!this.isType0) return [code & 0xff];
    const len = this.encodingCMap!.codeLength(code);
    const out: number[] = [];
    for (let k = len - 1; k >= 0; k--) out.push((code >> (8 * k)) & 0xff);
    return out;
  }
}

function hasEmbeddedProgram(desc: PDFDict): boolean {
  return ['FontFile', 'FontFile2', 'FontFile3'].some((k) => desc.has(PDFName.of(k)));
}

// A broken ToUnicode/encoding CMap is treated like a missing one and recorded in font.warnings;
// runs then decode as U+FFFD and are flagged non-editable instead of failing the whole page.
function safeCMap(s: PDFStream, warnings: string[], what: string): CMap | null {
  try {
    return parseCMap(streamBytes(s));
  } catch (e) {
    warnings.push(`${what} CMap could not be parsed: ${(e as Error).message}`);
    return null;
  }
}
