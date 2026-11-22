import { ContentLexer, type Operand } from '../content/parser.ts';

export type CodespaceRange = { bytes: number; low: number; high: number };

export class CMap {
  codespace: CodespaceRange[] = [];
  /** code → Unicode string (ToUnicode) */
  readonly toUnicode = new Map<number, string>();
  /** code → CID (encoding CMaps) */
  readonly toCid = new Map<number, number>();
  cidRanges: { bytes: number; low: number; high: number; cid: number }[] = [];
  name = '';
  vertical = false;
  identity = false;

  static identity(vertical: boolean): CMap {
    const c = new CMap();
    c.codespace = [{ bytes: 2, low: 0, high: 0xffff }];
    c.identity = true;
    c.vertical = vertical;
    c.name = vertical ? 'Identity-V' : 'Identity-H';
    return c;
  }

  /** Splits a byte string into codes using the codespace ranges (1-byte fallback for unmatched bytes). */
  split(bytes: Uint8Array): { code: number; len: number }[] {
    const out: { code: number; len: number }[] = [];
    const ranges = this.codespace.length ? this.codespace : [{ bytes: 1, low: 0, high: 0xff }];
    const maxLen = Math.max(...ranges.map((r) => r.bytes));
    let i = 0;
    while (i < bytes.length) {
      let matched = false;
      let code = 0;
      for (let len = 1; len <= maxLen && i + len <= bytes.length; len++) {
        code = (code << 8) | bytes[i + len - 1]!;
        if (ranges.some((r) => r.bytes === len && code >= r.low && code <= r.high)) {
          out.push({ code, len });
          i += len;
          matched = true;
          break;
        }
      }
      if (!matched) {
        const len = Math.min(ranges[0]!.bytes, bytes.length - i);
        let c = 0;
        for (let k = 0; k < len; k++) c = (c << 8) | bytes[i + k]!;
        out.push({ code: c, len });
        i += len;
      }
    }
    return out;
  }

  codeLength(code: number): number {
    for (const r of this.codespace) if (code >= r.low && code <= r.high && (r.bytes > 1 || code <= 0xff)) return r.bytes;
    return this.codespace[0]?.bytes ?? 1;
  }

  cid(code: number): number {
    if (this.identity) return code;
    const direct = this.toCid.get(code);
    if (direct !== undefined) return direct;
    for (const r of this.cidRanges) if (code >= r.low && code <= r.high) return r.cid + (code - r.low);
    return 0;
  }
}

const strToInt = (o: Operand | undefined): number => {
  if (!o) return 0;
  if (o.t === 'num') return o.v;
  if (o.t === 'str') return o.v.reduce((a, b) => a * 256 + b, 0);
  return 0;
};

const utf16be = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
  if (b.length % 2) s += String.fromCharCode(b[b.length - 1]!);
  return s;
};

const incrementLast = (s: string, by: number): string => {
  if (s.length === 0) return s;
  const last = s.charCodeAt(s.length - 1) + by;
  return s.slice(0, -1) + String.fromCharCode(last & 0xffff);
};

/** Parses a CMap program (ToUnicode or an embedded encoding CMap). */
export function parseCMap(bytes: Uint8Array): CMap {
  const cmap = new CMap();
  const lex = new ContentLexer(bytes);
  let operands: Operand[] = [];
  let arrayStack: Operand[][] = [];
  let mode: string | null = null;
  let pendingName: string | null = null;
  for (;;) {
    const tok = lex.next();
    if (tok.k === 'eof') break;
    if (tok.k === 'arrOpen') {
      arrayStack.push([]);
      continue;
    }
    if (tok.k === 'arrClose') {
      const arr = arrayStack.pop();
      if (arr) (arrayStack[arrayStack.length - 1] ?? operands).push({ t: 'arr', v: arr });
      continue;
    }
    if (tok.k === 'operand') {
      if (tok.v.t === 'name' && tok.v.v === 'CMapName') pendingName = 'CMapName';
      else if (pendingName === 'CMapName' && tok.v.t === 'name') {
        cmap.name = tok.v.v;
        pendingName = null;
      } else if (tok.v.t === 'name' && tok.v.v === 'WMode') pendingName = 'WMode';
      else if (pendingName === 'WMode' && tok.v.t === 'num') {
        cmap.vertical = tok.v.v === 1;
        pendingName = null;
      }
      (arrayStack[arrayStack.length - 1] ?? operands).push(tok.v);
      continue;
    }
    if (tok.k !== 'op') continue;
    const op = tok.v;
    if (op.startsWith('begin')) {
      mode = op.slice(5);
      operands = [];
      arrayStack = [];
      continue;
    }
    if (op.startsWith('end') && mode) {
      applyBlock(cmap, mode, operands);
      mode = null;
      operands = [];
      continue;
    }
    if (op === 'usecmap') {
      const last = operands[operands.length - 1];
      if (last?.t === 'name' && last.v.startsWith('Identity')) {
        const id = CMap.identity(last.v.endsWith('V'));
        cmap.codespace.push(...id.codespace);
        cmap.identity = cmap.toCid.size === 0 && cmap.cidRanges.length === 0;
      }
    }
    if (!mode) operands = [];
  }
  return cmap;
}

function applyBlock(cmap: CMap, mode: string, ops: Operand[]): void {
  switch (mode) {
    case 'codespacerange':
      for (let i = 0; i + 1 < ops.length; i += 2) {
        const lo = ops[i]!;
        const hi = ops[i + 1]!;
        if (lo.t !== 'str' || hi.t !== 'str') continue;
        cmap.codespace.push({ bytes: lo.v.length, low: strToInt(lo), high: strToInt(hi) });
      }
      break;
    case 'bfchar':
      for (let i = 0; i + 1 < ops.length; i += 2) {
        const dst = ops[i + 1]!;
        const u = dst.t === 'str' ? utf16be(dst.v) : dst.t === 'name' ? dst.v : '';
        cmap.toUnicode.set(strToInt(ops[i]), u);
      }
      break;
    case 'bfrange':
      for (let i = 0; i + 2 < ops.length; i += 3) {
        const lo = strToInt(ops[i]);
        const hi = strToInt(ops[i + 1]);
        const dst = ops[i + 2]!;
        if (hi - lo > 0xffff) continue;
        if (dst.t === 'arr') {
          dst.v.forEach((d, k) => {
            if (d.t === 'str' && lo + k <= hi) cmap.toUnicode.set(lo + k, utf16be(d.v));
          });
        } else if (dst.t === 'str') {
          const base = utf16be(dst.v);
          for (let c = lo; c <= hi; c++) cmap.toUnicode.set(c, incrementLast(base, c - lo));
        }
      }
      break;
    case 'cidchar':
      for (let i = 0; i + 1 < ops.length; i += 2) cmap.toCid.set(strToInt(ops[i]), strToInt(ops[i + 1]));
      break;
    case 'cidrange':
      for (let i = 0; i + 2 < ops.length; i += 3) {
        const lo = ops[i]!;
        cmap.cidRanges.push({ bytes: lo.t === 'str' ? lo.v.length : 1, low: strToInt(lo), high: strToInt(ops[i + 1]), cid: strToInt(ops[i + 2]) });
      }
      break;
  }
}

/** Serializes a ToUnicode CMap (used when we embed fonts or extend encodings). */
export function buildToUnicodeCMap(entries: Map<number, string>, codeBytes: 1 | 2): string {
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(codeBytes * 2, '0');
  const uhex = (s: string) => [...s].map((ch) => {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0xffff) return cp.toString(16).toUpperCase().padStart(4, '0');
    const v = cp - 0x10000;
    return ((0xd800 + (v >> 10)).toString(16) + (0xdc00 + (v & 0x3ff)).toString(16)).toUpperCase();
  }).join('');
  const lines: string[] = [];
  const all = [...entries].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < all.length; i += 100) {
    const chunk = all.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const [c, u] of chunk) lines.push(`<${hex(c)}> <${uhex(u)}>`);
    lines.push('endbfchar');
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    codeBytes === 1 ? '<00> <FF>' : '<0000> <FFFF>',
    'endcodespacerange',
    ...lines,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}
