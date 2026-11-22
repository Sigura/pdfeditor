import * as fontkit from 'fontkit';
import { readCff, wrapCffAsOpenType } from './cff.ts';
import { BASE_ENCODINGS, UNICODE_TO_NAME } from './encodings.ts';
import { parseType1, type PathCmd, type Type1Program } from './type1.ts';

export type { PathCmd };
export type GlyphBox = { x0: number; y0: number; x1: number; y1: number };

/**
 * Uniform view of an embedded font program. Paths, boxes and advances are in glyph space
 * (1/1000 em), like PDF widths.
 */
export interface GlyphProgram {
  readonly kind: 'TrueType' | 'OpenType' | 'CFF' | 'Type1';
  readonly numGlyphs: number;
  /** Built-in encoding (code → gid) of Type1 and name-keyed CFF programs. */
  readonly builtinEncoding: Map<number, number> | null;
  gidForName(name: string): number | undefined;
  gidForUnicode(ch: string): number | undefined;
  /** CID → gid for CID-keyed CFF (charset); identity otherwise. */
  gidForCid(cid: number): number | undefined;
  nameOf(gid: number): string | undefined;
  hasOutline(gid: number): boolean;
  path(gid: number): PathCmd[];
  advance(gid: number): number;
  bbox(gid: number): GlyphBox | null;
}

type FkPathCommand = { command: string; args: number[] };

/** Converts fontkit path commands (quadratic or cubic) to M/L/C/Z scaled by `k`. */
export function convertFontkitPath(commands: FkPathCommand[], k: number): PathCmd[] {
  const out: PathCmd[] = [];
  let cx = 0;
  let cy = 0;
  for (const { command, args } of commands) {
    const a = args.map((n) => n * k);
    switch (command) {
      case 'moveTo':
        out.push({ op: 'M', p: a });
        [cx, cy] = [a[0]!, a[1]!];
        break;
      case 'lineTo':
        out.push({ op: 'L', p: a });
        [cx, cy] = [a[0]!, a[1]!];
        break;
      case 'quadraticCurveTo': {
        const [qx, qy, x, y] = a as [number, number, number, number];
        out.push({ op: 'C', p: [cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y] });
        [cx, cy] = [x, y];
        break;
      }
      case 'bezierCurveTo':
        out.push({ op: 'C', p: a });
        [cx, cy] = [a[4]!, a[5]!];
        break;
      case 'closePath':
        out.push({ op: 'Z', p: [] });
        break;
    }
  }
  return out;
}

export function pathBox(path: PathCmd[]): GlyphBox | null {
  let box: GlyphBox | null = null;
  for (const c of path) {
    for (let i = 0; i + 1 < c.p.length; i += 2) {
      const x = c.p[i]!;
      const y = c.p[i + 1]!;
      if (!box) box = { x0: x, y0: y, x1: x, y1: y };
      else box = { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) };
    }
  }
  return box;
}

function namesFor(ch: string): string[] {
  const cp = ch.codePointAt(0)!;
  const hex = cp.toString(16).toUpperCase().padStart(4, '0');
  const agl = UNICODE_TO_NAME.get(ch);
  return [...(agl ? [agl] : []), `uni${hex}`, `u${hex}`];
}

abstract class BaseProgram {
  private boxes = new Map<number, GlyphBox | null>();
  abstract path(gid: number): PathCmd[];
  bbox(gid: number): GlyphBox | null {
    if (!this.boxes.has(gid)) this.boxes.set(gid, pathBox(this.path(gid)));
    return this.boxes.get(gid)!;
  }
  hasOutline(gid: number): boolean {
    return this.path(gid).length > 0;
  }
}

class FontkitProgram extends BaseProgram implements GlyphProgram {
  private names: Map<string, number> | undefined;
  private paths = new Map<number, PathCmd[]>();
  private readonly k: number;
  private readonly hasCmap: boolean;
  constructor(
    readonly kind: 'TrueType' | 'OpenType' | 'CFF',
    private readonly font: fontkit.Font,
    readonly builtinEncoding: Map<number, number> | null,
    private readonly cidCharset: number[] | null,
  ) {
    super();
    this.k = 1000 / font.unitsPerEm;
    // fontkit types omit the table directory; wrapped CFF programs have no cmap table.
    this.hasCmap = 'cmap' in (font as unknown as { directory: { tables: Record<string, unknown> } }).directory.tables;
  }
  get numGlyphs(): number {
    return this.font.numGlyphs;
  }
  nameOf(gid: number): string | undefined {
    if (gid < 0 || gid >= this.numGlyphs || this.cidCharset) return undefined;
    return this.font.getGlyph(gid).name || undefined;
  }
  gidForName(name: string): number | undefined {
    if (!this.names) {
      this.names = new Map();
      for (let g = 0; g < this.numGlyphs; g++) {
        const n = this.nameOf(g);
        if (n && !this.names.has(n)) this.names.set(n, g);
      }
    }
    return this.names.get(name);
  }
  gidForUnicode(ch: string): number | undefined {
    if (this.hasCmap) {
      const g = this.font.glyphForCodePoint(ch.codePointAt(0)!);
      if (g.id > 0) return g.id;
    }
    for (const n of namesFor(ch)) {
      const g = this.gidForName(n);
      if (g !== undefined) return g;
    }
    return undefined;
  }
  gidForCid(cid: number): number | undefined {
    if (!this.cidCharset) return cid < this.numGlyphs ? cid : undefined;
    const g = this.cidCharset.indexOf(cid);
    return g < 0 ? undefined : g;
  }
  path(gid: number): PathCmd[] {
    if (gid <= 0 || gid >= this.numGlyphs) return [];
    let p = this.paths.get(gid);
    if (!p) {
      p = convertFontkitPath(this.font.getGlyph(gid).path.commands as FkPathCommand[], this.k);
      this.paths.set(gid, p);
    }
    return p;
  }
  advance(gid: number): number {
    if (this.kind === 'CFF') {
      // The wrapped CFF has no hmtx; approximate the advance with equal side bearings.
      const b = this.bbox(gid);
      return b ? b.x1 + Math.max(0, b.x0) : 0;
    }
    return this.font.getGlyph(gid).advanceWidth * this.k;
  }
}

class Type1GlyphProgram extends BaseProgram implements GlyphProgram {
  readonly kind = 'Type1' as const;
  private readonly gids = new Map<string, number>();
  private readonly order: string[];
  readonly builtinEncoding: Map<number, number>;
  private readonly k: number;
  constructor(private readonly t1: Type1Program) {
    super();
    this.order = ['.notdef', ...[...t1.charStrings.keys()].filter((n) => n !== '.notdef')];
    this.order.forEach((n, i) => this.gids.set(n, i));
    this.builtinEncoding = new Map();
    t1.encoding.forEach((n, code) => {
      const g = n ? this.gids.get(n) : undefined;
      if (g !== undefined) this.builtinEncoding.set(code, g);
    });
    this.k = t1.fontMatrix[0]! * 1000;
  }
  get numGlyphs(): number {
    return this.order.length;
  }
  nameOf(gid: number): string | undefined {
    return this.order[gid];
  }
  gidForName(name: string): number | undefined {
    return this.t1.charStrings.has(name) ? this.gids.get(name) : undefined;
  }
  gidForUnicode(ch: string): number | undefined {
    for (const n of namesFor(ch)) {
      const g = this.gidForName(n);
      if (g !== undefined) return g;
    }
    return undefined;
  }
  gidForCid(cid: number): number | undefined {
    return cid < this.order.length ? cid : undefined;
  }
  path(gid: number): PathCmd[] {
    const name = this.order[gid];
    if (!name || gid === 0) return [];
    const g = this.t1.glyph(name);
    return g ? g.path.map((c) => ({ op: c.op, p: c.p.map((n) => n * this.k) })) : [];
  }
  advance(gid: number): number {
    const name = this.order[gid];
    return name ? (this.t1.glyph(name)?.width ?? 0) * this.k : 0;
  }
}

export type ProgramSource = { kind: 'TrueType' | 'OpenType' | 'CFF' | 'Type1'; bytes: Uint8Array; length1?: number };

/** Loads an embedded program; throws with a readable message when it can't be parsed. */
export function loadGlyphProgram(src: ProgramSource): GlyphProgram {
  if (src.kind === 'Type1') return new Type1GlyphProgram(parseType1(src.bytes, src.length1 ?? 0));
  if (src.kind === 'CFF') {
    const info = readCff(src.bytes);
    const upm = 1 / (info.fontMatrix[0] || 0.001);
    const f = fontkit.create(Buffer.from(wrapCffAsOpenType(src.bytes, info.numGlyphs, upm)));
    if (!('numGlyphs' in f)) throw new Error('wrapped CFF did not load as a single font');
    const prog = new FontkitProgram('CFF', f, info.isCid ? null : info.encoding, info.isCid ? info.charset : null);
    if (info.standardEncoding) {
      BASE_ENCODINGS.StandardEncoding.forEach((name, code) => {
        const g = name ? prog.gidForName(name) : undefined;
        if (g !== undefined) info.encoding.set(code, g);
      });
    }
    return prog;
  }
  const f = fontkit.create(Buffer.from(src.bytes));
  if (!('numGlyphs' in f)) throw new Error('embedded font is a collection');
  return new FontkitProgram(src.kind, f, null, null);
}
