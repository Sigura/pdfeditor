import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import * as fontkit from 'fontkit';

/** `id` is an SPDX-like name for free licences, else 'proprietary' (licence text that isn't a known free one) or 'unknown'. */
export type FontLicense = { id: string; free: boolean; url?: string };

export type FontFace = {
  file: string;
  /** Face number inside a .ttc/.otc collection. */
  face?: number;
  postscriptName: string;
  family: string;
  /** Typographic family and style (name IDs 16/17, e.g. "Inter" + "Thin Italic"), for display. */
  typoFamily: string;
  style: string;
  source: 'local' | 'bundled' | 'system';
  license: FontLicense;
  /** OS/2 fsType: restricted-licence and bitmap-only fonts may not be embedded, no-subsetting ones only whole. */
  embeddable: boolean;
  subset: boolean;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  /** cmap coverage as sorted [first, last] code point pairs, so fallback search needn't load faces. */
  coverage: Uint32Array;
};

export type LoadedFace = FontFace & { bytes: Uint8Array; font: fontkit.Font };

export type FontRequest = { name: string; bold: boolean; italic: boolean; serif: boolean; mono: boolean };

/** Groups of metric-compatible families (same advance widths), keyed by normalized family. */
const METRIC_GROUPS = [
  ['arial', 'helvetica', 'liberationsans', 'arimo', 'nimbussans', 'nimbussansl', 'texgyreheros'],
  ['timesnewroman', 'times', 'timesroman', 'liberationserif', 'tinos', 'nimbusroman', 'nimbusromanno9l', 'texgyretermes'],
  ['couriernew', 'courier', 'liberationmono', 'cousine', 'nimbusmono', 'nimbusmonops', 'texgyrecursor'],
  ['arialnarrow', 'helveticanarrow', 'liberationsansnarrow'],
  ['calibri', 'carlito'],
  ['cambria', 'caladea'],
  ['georgia', 'gelasio'],
];

const SYSTEM_DIRS = [
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  path.join(homedir(), '.fonts'),
  path.join(homedir(), '.local/share/fonts'),
  '/Library/Fonts',
  '/System/Library/Fonts',
  path.join(homedir(), 'Library/Fonts'),
  'C:\\Windows\\Fonts',
];

type Config = { dirs: string[]; bundled: string[]; system: boolean };
let config: Config = { dirs: process.env.PDF_FONTS_DIR ? [process.env.PDF_FONTS_DIR] : [], bundled: [], system: true };
let index: { faces: FontFace[]; errors: string[] } | null = null;
const loadedCache = new Map<string, LoadedFace>();

/** Sets the local font directories, then the bundled ones (both searched before system fonts), and resets the index. */
export function configureFonts(opts: { dirs: string[]; bundled?: string[]; system?: boolean }): void {
  config = { dirs: opts.dirs, bundled: opts.bundled ?? [], system: opts.system ?? true };
  index = null;
  loadedCache.clear();
}

export function normalizeFamily(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s_-]/g, '')
    .replace(/(psmt|mt|ps)$/, '');
}

/** Splits a PostScript-style font name ("TimesNewRomanPS-BoldItalicMT", "Arial,Bold") into family and style. */
export function parseFontName(name: string): { family: string; bold: boolean; italic: boolean } {
  const m = /^(.*?)[,-]([^,-]*)$/.exec(name);
  const fam = m ? m[1]! : name;
  const style = m ? m[2]! : '';
  return {
    family: normalizeFamily(fam),
    bold: /bold|black|heavy|semibold|demi/i.test(style),
    italic: /italic|oblique|kursiv/i.test(style),
  };
}

const isMissing = (e: unknown) => ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '');

const FONT_FILE = /\.(ttf|otf|ttc|otc|woff2?)$/i;

/** Font files fontconfig knows about (it also covers directories outside SYSTEM_DIRS); none where fc-list isn't installed. */
function fontconfigFiles(): string[] {
  try {
    return execFileSync('fc-list', ['--format', '%{file}\n'], { encoding: 'utf8', maxBuffer: 64 << 20 })
      .split('\n')
      .filter((f) => FONT_FILE.test(f));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

const FREE_LICENSES: [string, RegExp][] = [
  ['OFL-1.1', /open font licen[cs]e|scripts\.sil\.org\/OFL|openfontlicense\.org|\bOFL\b/i],
  ['Apache-2.0', /apache licen[cs]e|apache\.org\/licenses/i],
  // Bitstream Vera's text is MIT-like, so it is matched first.
  ['Bitstream-Vera', /bitstream vera|dejavu/i],
  ['MIT', /\bMIT licen[cs]e|opensource\.org\/licenses\/MIT|permission is hereby granted, free of charge/i],
  ['UFL-1.0', /ubuntu font licen[cs]e/i],
  ['GPL-2.0-with-font-exception', /liberation ?fonts? ?licen[cs]e|GNU General Public Licen[cs]e|gnu\.org\/licenses\/gpl/i],
  ['GUST', /GUST font licen[cs]e/i],
  ['LPPL', /LaTeX Project Public Licen[cs]e/i],
  ['public-domain', /public domain/i],
];

const nameRecord = (f: fontkit.Font, key: string): string | undefined => {
  const r = (f as unknown as { name?: { records?: Record<string, Record<string, string>> } }).name?.records?.[key];
  return r ? (r.en ?? Object.values(r)[0]) : undefined;
};

/** A licence file shipped next to the font (or one directory up), e.g. LICENSE_FONT in @expo-google-fonts packages. */
function licenseFile(file: string): string | undefined {
  for (const dir of [path.dirname(file), path.dirname(path.dirname(file))])
    for (const name of ['LICENSE_FONT', 'OFL.txt', 'OFL-1.1.txt']) {
      const p = path.join(dir, name);
      if (existsSync(p)) return readFileSync(p, 'utf8').slice(0, 4000);
    }
  return undefined;
}

/** Name-table licence description and URL (IDs 13/14), else a shipped licence file, else the copyright notice. */
export function fontLicense(f: fontkit.Font, file: string): FontLicense {
  const url = nameRecord(f, 'licenseURL');
  const sources = [[nameRecord(f, 'license'), url].filter(Boolean).join(' '), licenseFile(file) ?? '', nameRecord(f, 'copyright') ?? ''];
  for (const text of sources) {
    const hit = text && FREE_LICENSES.find(([, re]) => re.test(text));
    if (hit) return { id: hit[0], free: true, ...(url && { url }) };
  }
  return { id: sources[0] ? 'proprietary' : 'unknown', free: false, ...(url && { url }) };
}

function listFontFiles(dir: string, out: string[], depth = 0): string[] {
  if (depth > 6) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if (isMissing(e)) return out; // e.g. macOS font paths on Linux
    throw e;
  }
  for (const e of entries) {
    const p = path.join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch (err) {
      if (isMissing(err)) continue; // dangling symlink
      throw err;
    }
    if (st.isDirectory()) listFontFiles(p, out, depth + 1);
    else if (FONT_FILE.test(e)) out.push(p);
  }
  return out;
}

function classify(f: fontkit.Font): { serif: boolean; mono: boolean } {
  const os2 = (f as unknown as { 'OS/2'?: { panose?: number[]; sFamilyClass?: number } })['OS/2'];
  const post = (f as unknown as { post?: { isFixedPitch?: number } }).post;
  const name = `${f.familyName} ${f.postscriptName}`;
  const mono = !!post?.isFixedPitch || /mono|courier|code/i.test(name);
  const panose = os2?.panose;
  let serif: boolean | undefined;
  if (panose && panose[0] === 2 && panose[1]! >= 2) serif = panose[1]! < 11;
  if (/sans/i.test(name)) serif = false;
  else if (/serif|roman|times/i.test(name)) serif = true;
  if (serif === undefined) {
    const cls = (os2?.sFamilyClass ?? 0) >> 8;
    serif = cls >= 1 && cls <= 7 && cls !== 6;
  }
  return { serif, mono };
}

type Os2 = {
  usWeightClass?: number;
  fsSelection?: { italic?: boolean; bold?: boolean };
  fsType?: { noEmbedding?: boolean; noSubsetting?: boolean; bitmapOnly?: boolean };
};

function codeRanges(codePoints: number[]): Uint32Array {
  const cps = [...new Set(codePoints)].sort((a, b) => a - b);
  const out: number[] = [];
  for (const cp of cps) {
    if (out.length && out[out.length - 1] === cp - 1) out[out.length - 1] = cp;
    else out.push(cp, cp);
  }
  return Uint32Array.from(out);
}

function describe(f: fontkit.Font, file: string, source: FontFace['source'], face?: number): FontFace {
  const os2 = (f as unknown as { 'OS/2'?: Os2 })['OS/2'];
  const sub = f.subfamilyName ?? '';
  return {
    file,
    ...(face !== undefined && { face }),
    postscriptName: f.postscriptName ?? '',
    family: f.familyName ?? '',
    typoFamily: nameRecord(f, 'preferredFamily') ?? f.familyName ?? '',
    style: nameRecord(f, 'preferredSubfamily') ?? sub,
    source,
    license: fontLicense(f, file),
    embeddable: !os2?.fsType?.noEmbedding && !os2?.fsType?.bitmapOnly,
    subset: !os2?.fsType?.noSubsetting,
    bold: (os2?.usWeightClass ?? 400) >= 600 || !!os2?.fsSelection?.bold || /bold|black|heavy/i.test(sub),
    italic: !!os2?.fsSelection?.italic || f.italicAngle !== 0 || /italic|oblique/i.test(sub),
    ...classify(f),
    coverage: codeRanges(f.characterSet),
  };
}

function buildIndex(): { faces: FontFace[]; errors: string[] } {
  const files = new Map<string, FontFace['source']>();
  const add = (list: string[], source: FontFace['source']) => {
    for (const f of list) if (!files.has(f)) files.set(f, source);
  };
  for (const d of config.dirs) add(listFontFiles(d, []), 'local');
  for (const d of config.bundled) add(listFontFiles(d, []), 'bundled');
  if (config.system) {
    for (const d of SYSTEM_DIRS) add(listFontFiles(d, []), 'system');
    add(fontconfigFiles(), 'system');
  }
  const faces: FontFace[] = [];
  const errors: string[] = [];
  for (const [file, source] of files) {
    try {
      const f = fontkit.openSync(file) as fontkit.Font | { fonts: fontkit.Font[] };
      if ('fonts' in f) f.fonts.forEach((member, i) => faces.push(describe(member, file, source, i)));
      else faces.push(describe(f, file, source));
    } catch (e) {
      errors.push(`${file}: ${(e as Error).message}`);
    }
  }
  return { faces, errors };
}

export const faceKey = (f: FontFace): string => (f.face === undefined ? f.file : `${f.file}#${f.face}`);

/** One face of a .ttc/.otc as a standalone sfnt (table directory plus its tables), so pdf-lib can embed it. */
function extractSfnt(buf: Uint8Array, face: number): Uint8Array<ArrayBuffer> {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const at = v.getUint32(12 + 4 * face);
  const n = v.getUint16(at + 4);
  const head = 12 + 16 * n;
  const tables = Array.from({ length: n }, (_, i) => ({ off: v.getUint32(at + 12 + 16 * i + 8), len: v.getUint32(at + 12 + 16 * i + 12) }));
  const out = new Uint8Array(tables.reduce((sum, t) => sum + ((t.len + 3) & ~3), head));
  const o = new DataView(out.buffer);
  out.set(buf.subarray(at, at + head));
  let pos = head;
  tables.forEach((t, i) => {
    out.set(buf.subarray(t.off, t.off + t.len), pos);
    o.setUint32(12 + 16 * i + 8, pos);
    pos += (t.len + 3) & ~3;
  });
  return out;
}

/** The face's bytes as one font file (.ttf/.otf/.woff/.woff2; a collection member is extracted). */
export function faceBytes(face: FontFace): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(readFileSync(face.file));
  return face.face === undefined ? bytes : extractSfnt(bytes, face.face);
}

/** `text` drawn in the face as one SVG path, so a preview doesn't need the whole (often many-MB) font file. */
export function faceSampleSvg(face: FontFace, text: string): string {
  const font = fontkit.create(Buffer.from(faceBytes(face)));
  if (!('numGlyphs' in font)) throw new Error(`${faceKey(face)} is a font collection`);
  // No shaping: font.layout runs GSUB/GPOS (~50-100 ms a face, blocking the server) for kerning a preview doesn't need.
  let x = 0;
  const d = font.glyphsForString(text).map((g) => {
    const s = g.path.translate(x, 0).toSVG();
    x += g.advanceWidth;
    return s;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${-font.ascent} ${x} ${font.ascent - font.descent}"><path transform="scale(1,-1)" d="${d.join('')}"/></svg>`;
}

export function fontIndex(): { faces: FontFace[]; errors: string[] } {
  index ??= buildIndex();
  return index;
}

export function loadFace(face: FontFace): LoadedFace {
  const key = faceKey(face);
  let l = loadedCache.get(key);
  if (!l) {
    const bytes = faceBytes(face);
    const font = fontkit.create(Buffer.from(bytes));
    if (!('numGlyphs' in font)) throw new Error(`${key} is a font collection`);
    l = { ...face, bytes, font };
    loadedCache.set(key, l);
  }
  return l;
}

export function faceCovers(face: LoadedFace, text: string): boolean {
  return [...text].every((ch) => ch === '\n' || face.font.hasGlyphForCodePoint(ch.codePointAt(0)!));
}

function rangesHave(ranges: Uint32Array, cp: number): boolean {
  let lo = 0;
  let hi = ranges.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[2 * mid]!) hi = mid - 1;
    else if (cp > ranges[2 * mid + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Number of faces currently held in memory by loadFace. */
export const loadedFaceCount = (): number => loadedCache.size;

/**
 * S2 lookup: PostScript name, then family + style, then a metric-compatible family with the same
 * style. Only these count as substitutes; anything looser is an S3 fallback.
 */
export function findSubstitute(req: FontRequest): { face: FontFace; how: 'postscript' | 'family' | 'alias' } | undefined {
  const faces = fontIndex().faces.filter((f) => f.embeddable);
  const ps = faces.find((f) => f.postscriptName.toLowerCase() === req.name.toLowerCase());
  if (ps) return { face: ps, how: 'postscript' };
  const family = parseFontName(req.name).family;
  const sameStyle = (f: FontFace) => f.bold === req.bold && f.italic === req.italic;
  const fam = faces.find((f) => sameStyle(f) && normalizeFamily(f.family) === family);
  if (fam) return { face: fam, how: 'family' };
  const group = METRIC_GROUPS.find((g) => g.includes(family));
  if (!group) return undefined;
  for (const member of group) {
    const hit = faces.find((f) => sameStyle(f) && normalizeFamily(f.family) === member);
    if (hit) return { face: hit, how: 'alias' };
  }
  return undefined;
}

/** S3c: the closest face with glyphs for all of `text` (serif/sans, fixed pitch, weight, slant). */
export function findFallback(req: FontRequest, text: string): LoadedFace | undefined {
  const family = parseFontName(req.name).family;
  const group = METRIC_GROUPS.find((g) => g.includes(family));
  const score = (f: FontFace) =>
    (f.serif === req.serif ? 8 : 0) +
    (f.mono === req.mono ? 8 : 0) +
    (f.bold === req.bold ? 4 : 0) +
    (f.italic === req.italic ? 2 : 0) +
    (group?.includes(normalizeFamily(f.family)) ? 1 : 0);
  const ranked = fontIndex().faces.filter((f) => f.embeddable).sort((a, b) => score(b) - score(a) || a.file.localeCompare(b.file));
  const cps = [...new Set([...text].filter((ch) => ch !== '\n').map((ch) => ch.codePointAt(0)!))];
  const hit = ranked.find((f) => cps.every((cp) => rangesHave(f.coverage, cp)));
  return hit && loadFace(hit);
}
