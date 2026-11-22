import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import * as fontkit from 'fontkit';

export type FontFace = {
  file: string;
  postscriptName: string;
  family: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
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

let config: { dirs: string[]; system: boolean } = { dirs: process.env.PDF_FONTS_DIR ? [process.env.PDF_FONTS_DIR] : [], system: true };
let index: { faces: FontFace[]; errors: string[] } | null = null;
const loadedCache = new Map<string, LoadedFace>();

/** Sets the local font directories (searched before system fonts) and resets the index. */
export function configureFonts(opts: { dirs: string[]; system?: boolean }): void {
  config = { dirs: opts.dirs, system: opts.system ?? true };
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

function listFontFiles(dir: string, out: string[], depth = 0): void {
  if (depth > 6) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if (isMissing(e)) return; // e.g. macOS font paths on Linux
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
    else if (/\.(ttf|otf)$/i.test(e)) out.push(p);
  }
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

function buildIndex(): { faces: FontFace[]; errors: string[] } {
  const files: string[] = [];
  for (const d of config.dirs) listFontFiles(d, files);
  if (config.system) for (const d of SYSTEM_DIRS) listFontFiles(d, files);
  const faces: FontFace[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      const f = fontkit.openSync(file);
      if (!('numGlyphs' in f)) continue;
      const os2 = (f as unknown as { 'OS/2'?: { usWeightClass?: number; fsSelection?: { italic?: boolean; bold?: boolean } } })['OS/2'];
      const sub = f.subfamilyName ?? '';
      faces.push({
        file,
        postscriptName: f.postscriptName ?? '',
        family: f.familyName ?? '',
        bold: (os2?.usWeightClass ?? 400) >= 600 || !!os2?.fsSelection?.bold || /bold|black|heavy/i.test(sub),
        italic: !!os2?.fsSelection?.italic || f.italicAngle !== 0 || /italic|oblique/i.test(sub),
        ...classify(f),
      });
    } catch (e) {
      errors.push(`${file}: ${(e as Error).message}`);
    }
  }
  return { faces, errors };
}

export function fontIndex(): { faces: FontFace[]; errors: string[] } {
  index ??= buildIndex();
  return index;
}

export function loadFace(face: FontFace): LoadedFace {
  let l = loadedCache.get(face.file);
  if (!l) {
    const bytes = new Uint8Array(readFileSync(face.file));
    const font = fontkit.create(Buffer.from(bytes));
    if (!('numGlyphs' in font)) throw new Error(`${face.file} is a font collection`);
    l = { ...face, bytes, font };
    loadedCache.set(face.file, l);
  }
  return l;
}

export function faceCovers(face: LoadedFace, text: string): boolean {
  return [...text].every((ch) => ch === '\n' || face.font.hasGlyphForCodePoint(ch.codePointAt(0)!));
}

/**
 * S2 lookup: PostScript name, then family + style, then a metric-compatible family with the same
 * style. Only these count as substitutes; anything looser is an S3 fallback.
 */
export function findSubstitute(req: FontRequest): { face: FontFace; how: 'postscript' | 'family' | 'alias' } | undefined {
  const { faces } = fontIndex();
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
  const ranked = [...fontIndex().faces].sort((a, b) => score(b) - score(a) || a.file.localeCompare(b.file));
  for (const f of ranked) {
    const l = loadFace(f);
    if (faceCovers(l, text)) return l;
  }
  return undefined;
}
