import { Encodings } from '@pdf-lib/standard-fonts';

const ASCII_NAMES =
  'space exclam quotedbl numbersign dollar percent ampersand quoteright parenleft parenright asterisk plus comma hyphen period slash ' +
  'zero one two three four five six seven eight nine colon semicolon less equal greater question at ' +
  'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore quoteleft ' +
  'a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde';

const STANDARD_HIGH: Record<number, string> = {
  161: 'exclamdown', 162: 'cent', 163: 'sterling', 164: 'fraction', 165: 'yen', 166: 'florin', 167: 'section', 168: 'currency',
  169: 'quotesingle', 170: 'quotedblleft', 171: 'guillemotleft', 172: 'guilsinglleft', 173: 'guilsinglright', 174: 'fi', 175: 'fl',
  177: 'endash', 178: 'dagger', 179: 'daggerdbl', 180: 'periodcentered', 182: 'paragraph', 183: 'bullet', 184: 'quotesinglbase',
  185: 'quotedblbase', 186: 'quotedblright', 187: 'guillemotright', 188: 'ellipsis', 189: 'perthousand', 191: 'questiondown',
  193: 'grave', 194: 'acute', 195: 'circumflex', 196: 'tilde', 197: 'macron', 198: 'breve', 199: 'dotaccent', 200: 'dieresis',
  202: 'ring', 203: 'cedilla', 205: 'hungarumlaut', 206: 'ogonek', 207: 'caron', 208: 'emdash', 225: 'AE', 227: 'ordfeminine',
  232: 'Lslash', 233: 'Oslash', 234: 'OE', 235: 'ordmasculine', 241: 'ae', 245: 'dotlessi', 248: 'lslash', 249: 'oslash',
  250: 'oe', 251: 'germandbls',
};

// Glyph names for U+0100..U+017F in order (Adobe Glyph List).
const LATIN_EXT_A =
  'Amacron amacron Abreve abreve Aogonek aogonek Cacute cacute Ccircumflex ccircumflex Cdotaccent cdotaccent Ccaron ccaron Dcaron dcaron ' +
  'Dcroat dcroat Emacron emacron Ebreve ebreve Edotaccent edotaccent Eogonek eogonek Ecaron ecaron Gcircumflex gcircumflex Gbreve gbreve ' +
  'Gdotaccent gdotaccent Gcommaaccent gcommaaccent Hcircumflex hcircumflex Hbar hbar Itilde itilde Imacron imacron Ibreve ibreve ' +
  'Iogonek iogonek Idotaccent dotlessi IJ ij Jcircumflex jcircumflex Kcommaaccent kcommaaccent kgreenlandic Lacute lacute Lcommaaccent ' +
  'lcommaaccent Lcaron lcaron Ldot ldot Lslash lslash Nacute nacute Ncommaaccent ncommaaccent Ncaron ncaron napostrophe Eng eng ' +
  'Omacron omacron Obreve obreve Ohungarumlaut ohungarumlaut OE oe Racute racute Rcommaaccent rcommaaccent Rcaron rcaron Sacute sacute ' +
  'Scircumflex scircumflex Scedilla scedilla Scaron scaron Tcommaaccent tcommaaccent Tcaron tcaron Tbar tbar Utilde utilde Umacron umacron ' +
  'Ubreve ubreve Uring uring Uhungarumlaut uhungarumlaut Uogonek uogonek Wcircumflex wcircumflex Ycircumflex ycircumflex Ydieresis ' +
  'Zacute zacute Zdotaccent zdotaccent Zcaron zcaron longs';

const EXTRA_NAMES: Record<string, number> = {
  circumflex: 0x2c6, caron: 0x2c7, breve: 0x2d8, dotaccent: 0x2d9, ring: 0x2da, ogonek: 0x2db, tilde: 0x2dc, hungarumlaut: 0x2dd,
  fraction: 0x2044, fi: 0xfb01, fl: 0xfb02, ff: 0xfb00, ffi: 0xfb03, ffl: 0xfb04, dotlessj: 0x237, minus: 0x2212, Euro: 0x20ac,
  nbspace: 0xa0, sfthyphen: 0xad, Scommaaccent: 0x218, scommaaccent: 0x219, Tcedilla: 0x162, tcedilla: 0x163, Delta: 0x394,
  Omega: 0x3a9, mu: 0xb5, pi: 0x3c0, uni00A0: 0xa0, afii61289: 0x2113, afii00208: 0x2015, afii61352: 0x2116, commaaccent: 0x326,
  dotlessi: 0x131, Idot: 0x130, periodcentered: 0xb7, middot: 0xb7, ellipsis: 0x2026, emdash: 0x2014, endash: 0x2013,
  quotesingle: 0x27, grave: 0x60, quoteleft: 0x2018, quoteright: 0x2019, bullet: 0x2022, florin: 0x192, perthousand: 0x2030,
};

export const NAME_TO_UNICODE = new Map<string, string>();
export const UNICODE_TO_NAME = new Map<string, string>();

function addName(name: string, cp: number) {
  const ch = String.fromCodePoint(cp);
  if (!NAME_TO_UNICODE.has(name)) NAME_TO_UNICODE.set(name, ch);
  if (!UNICODE_TO_NAME.has(ch)) UNICODE_TO_NAME.set(ch, name);
}

ASCII_NAMES.split(' ').forEach((n, i) => addName(n, 0x20 + i));
NAME_TO_UNICODE.set('quoteright', '’');
NAME_TO_UNICODE.set('quoteleft', '‘');
UNICODE_TO_NAME.set("'", 'quotesingle');
UNICODE_TO_NAME.set('`', 'grave');
UNICODE_TO_NAME.set('’', 'quoteright');
UNICODE_TO_NAME.set('‘', 'quoteleft');
for (const enc of [Encodings.WinAnsi, Encodings.Symbol, Encodings.ZapfDingbats]) {
  for (const cp of enc.supportedCodePoints) {
    const { name } = enc.encodeUnicodeCodePoint(cp);
    addName(name, cp);
  }
}
LATIN_EXT_A.split(' ').forEach((n, i) => addName(n, 0x100 + i));
for (const [n, cp] of Object.entries(EXTRA_NAMES)) addName(n, cp);
// AGL Cyrillic: afii10017..afii10049 = А..Я with Ё at afii10023; afii10065..afii10097 lowercase.
{
  const upper = [0x410, 0x411, 0x412, 0x413, 0x414, 0x415, 0x401];
  for (let cp = 0x416; cp <= 0x42f; cp++) upper.push(cp);
  upper.forEach((cp, i) => addName(`afii${10017 + i}`, cp));
  const lower = [0x430, 0x431, 0x432, 0x433, 0x434, 0x435, 0x451];
  for (let cp = 0x436; cp <= 0x44f; cp++) lower.push(cp);
  lower.forEach((cp, i) => addName(`afii${10065 + i}`, cp));
}

/** Glyph name → Unicode, following the AGL specification rules for uniXXXX / uXXXX[XX] / suffixes. */
export function glyphNameToUnicode(name: string): string | undefined {
  const direct = NAME_TO_UNICODE.get(name);
  if (direct) return direct;
  const base = name.split('.')[0]!;
  if (base !== name) return glyphNameToUnicode(base);
  if (base.includes('_')) {
    const parts = base.split('_').map(glyphNameToUnicode);
    return parts.every((p) => p !== undefined) ? parts.join('') : undefined;
  }
  let m = /^uni((?:[0-9A-F]{4})+)$/.exec(base);
  if (m) {
    const hex = m[1]!;
    let s = '';
    for (let i = 0; i < hex.length; i += 4) s += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-F]{4,6})$/.exec(base);
  if (m) {
    const cp = Number.parseInt(m[1]!, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : undefined;
  }
  return undefined;
}

export function unicodeToGlyphName(ch: string): string {
  const n = UNICODE_TO_NAME.get(ch);
  if (n) return n;
  const cp = ch.codePointAt(0) ?? 0;
  return cp > 0xffff ? `u${cp.toString(16).toUpperCase()}` : `uni${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

export type BaseEncodingName = 'StandardEncoding' | 'WinAnsiEncoding' | 'MacRomanEncoding' | 'MacExpertEncoding' | 'SymbolEncoding' | 'ZapfDingbatsEncoding';

function tableFromUnicode(decoder: (code: number) => string | undefined): (string | undefined)[] {
  const t: (string | undefined)[] = [];
  for (let code = 0; code < 256; code++) {
    const ch = decoder(code);
    t.push(ch && ch !== '�' ? UNICODE_TO_NAME.get(ch) : undefined);
  }
  return t;
}

const standard: (string | undefined)[] = [];
for (let c = 0; c < 256; c++) standard.push(c >= 32 && c <= 126 ? ASCII_NAMES.split(' ')[c - 32] : STANDARD_HIGH[c]);

const winAnsi = tableFromUnicode((code) => {
  if (code < 32) return undefined;
  const cp1252 = new TextDecoder('windows-1252').decode(Uint8Array.of(code));
  return cp1252;
});
// PDF WinAnsi maps 0x27 to quotesingle and 0x60 to grave (unlike StandardEncoding).
winAnsi[0x27] = 'quotesingle';
winAnsi[0x60] = 'grave';
winAnsi[0xad] = 'hyphen';
winAnsi[0xa0] = 'space';

const macRoman = tableFromUnicode((code) => (code < 32 ? undefined : new TextDecoder('macintosh').decode(Uint8Array.of(code))));
macRoman[0x27] = 'quotesingle';
macRoman[0x60] = 'grave';

const fromStdFontEncoding = (enc: typeof Encodings.Symbol): (string | undefined)[] => {
  const t: (string | undefined)[] = new Array(256).fill(undefined);
  for (const cp of enc.supportedCodePoints) {
    const { code, name } = enc.encodeUnicodeCodePoint(cp);
    t[code] ??= name;
  }
  return t;
};

export const BASE_ENCODINGS: Record<BaseEncodingName, (string | undefined)[]> = {
  StandardEncoding: standard,
  WinAnsiEncoding: winAnsi,
  MacRomanEncoding: macRoman,
  MacExpertEncoding: standard,
  SymbolEncoding: fromStdFontEncoding(Encodings.Symbol),
  ZapfDingbatsEncoding: fromStdFontEncoding(Encodings.ZapfDingbats),
};
