import { PdfError } from '../errors.ts';

export type Operand =
  | { t: 'num'; v: number }
  | { t: 'str'; v: Uint8Array; hex: boolean }
  | { t: 'name'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'arr'; v: Operand[] }
  | { t: 'dict'; v: Map<string, Operand> };

export type ContentOp = {
  op: string;
  operands: Operand[];
  /** Byte offsets of the operator including its operands, end exclusive. */
  start: number;
  end: number;
  /** For BI: the raw image data between ID and EI. */
  inlineData?: Uint8Array;
};

export type ParsedContent = { bytes: Uint8Array; ops: ContentOp[] };

const WS = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

const isRegular = (c: number) => !WS[c] && !DELIM[c];

type Token =
  | { k: 'operand'; v: Operand }
  | { k: 'op'; v: string }
  | { k: 'arrOpen' }
  | { k: 'arrClose' }
  | { k: 'dictOpen' }
  | { k: 'dictClose' }
  | { k: 'eof' };

export class ContentLexer {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}

  skipWs(): void {
    const b = this.bytes;
    while (this.pos < b.length) {
      const c = b[this.pos]!;
      if (WS[c]) this.pos++;
      else if (c === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }

  next(): Token {
    this.skipWs();
    const b = this.bytes;
    if (this.pos >= b.length) return { k: 'eof' };
    const c = b[this.pos]!;
    switch (c) {
      case 0x28: // (
        return { k: 'operand', v: { t: 'str', v: this.literalString(), hex: false } };
      case 0x3c: // <
        if (b[this.pos + 1] === 0x3c) {
          this.pos += 2;
          return { k: 'dictOpen' };
        }
        return { k: 'operand', v: { t: 'str', v: this.hexString(), hex: true } };
      case 0x3e: // >
        if (b[this.pos + 1] === 0x3e) {
          this.pos += 2;
          return { k: 'dictClose' };
        }
        this.pos++;
        return this.next();
      case 0x5b:
        this.pos++;
        return { k: 'arrOpen' };
      case 0x5d:
        this.pos++;
        return { k: 'arrClose' };
      case 0x7b:
      case 0x7d:
        this.pos++;
        return this.next();
      case 0x2f: // /
        return { k: 'operand', v: { t: 'name', v: this.name() } };
      case 0x29: // stray )
        this.pos++;
        return this.next();
    }
    const start = this.pos;
    while (this.pos < b.length && isRegular(b[this.pos]!)) this.pos++;
    const word = latin1(b.subarray(start, this.pos));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { k: 'operand', v: { t: 'num', v: Number(word) } };
    if (/^[+-]?\d*\.?\d*[+-]\d*$/.test(word) || word === '-' || word === '+' || word === '.') {
      // Malformed numbers like "0.5-0.2" or "--1" appear in the wild; pdf.js reads the leading part.
      const m = /^[+-]?\d*\.?\d*/.exec(word);
      const n = Number(m?.[0] ?? 0);
      return { k: 'operand', v: { t: 'num', v: Number.isFinite(n) ? n : 0 } };
    }
    if (word === 'true' || word === 'false') return { k: 'operand', v: { t: 'bool', v: word === 'true' } };
    if (word === 'null') return { k: 'operand', v: { t: 'null' } };
    return { k: 'op', v: word };
  }

  private name(): string {
    const b = this.bytes;
    this.pos++;
    const out: number[] = [];
    while (this.pos < b.length && isRegular(b[this.pos]!)) {
      const c = b[this.pos]!;
      if (c === 0x23 && this.pos + 2 < b.length) {
        const h = Number.parseInt(latin1(b.subarray(this.pos + 1, this.pos + 3)), 16);
        if (!Number.isNaN(h)) {
          out.push(h);
          this.pos += 3;
          continue;
        }
      }
      out.push(c);
      this.pos++;
    }
    return latin1(Uint8Array.from(out));
  }

  private literalString(): Uint8Array {
    const b = this.bytes;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++]!;
      if (c === 0x5c) {
        const n = b[this.pos++];
        if (n === undefined) break;
        switch (n) {
          case 0x6e: out.push(0x0a); break;
          case 0x72: out.push(0x0d); break;
          case 0x74: out.push(0x09); break;
          case 0x62: out.push(0x08); break;
          case 0x66: out.push(0x0c); break;
          case 0x0d:
            if (b[this.pos] === 0x0a) this.pos++;
            break;
          case 0x0a:
            break;
          default:
            if (n >= 0x30 && n <= 0x37) {
              let v = n - 0x30;
              for (let i = 0; i < 2 && b[this.pos]! >= 0x30 && b[this.pos]! <= 0x37; i++) v = v * 8 + (b[this.pos++]! - 0x30);
              out.push(v & 0xff);
            } else out.push(n);
        }
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return Uint8Array.from(out);
  }

  private hexString(): Uint8Array {
    const b = this.bytes;
    this.pos++;
    const digits: number[] = [];
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const c = b[this.pos++]!;
      const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
      if (v >= 0) digits.push(v);
    }
    this.pos++;
    if (digits.length % 2) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = (digits[2 * i]! << 4) | digits[2 * i + 1]!;
    return out;
  }
}

export const latin1 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};

/** Parses a content stream into operators, keeping exact byte ranges for lossless rewriting. */
export function parseContent(bytes: Uint8Array): ParsedContent {
  const lex = new ContentLexer(bytes);
  const ops: ContentOp[] = [];
  let operands: Operand[] = [];
  let opStart = -1;
  const stack: { kind: 'arr' | 'dict'; items: Operand[] }[] = [];

  const push = (v: Operand) => {
    const top = stack[stack.length - 1];
    if (top) top.items.push(v);
    else operands.push(v);
  };

  for (;;) {
    lex.skipWs();
    const tokStart = lex.pos;
    const tok = lex.next();
    if (tok.k === 'eof') break;
    if (opStart < 0) opStart = tokStart;
    switch (tok.k) {
      case 'operand':
        push(tok.v);
        break;
      case 'arrOpen':
        stack.push({ kind: 'arr', items: [] });
        break;
      case 'dictOpen':
        stack.push({ kind: 'dict', items: [] });
        break;
      case 'arrClose':
      case 'dictClose': {
        const top = stack.pop();
        if (!top) break;
        if (top.kind === 'arr') push({ t: 'arr', v: top.items });
        else push({ t: 'dict', v: itemsToDict(top.items) });
        break;
      }
      case 'op': {
        if (stack.length > 0) {
          // An operator inside an unclosed array: the array is malformed. Close everything.
          while (stack.length) {
            const top = stack.pop()!;
            push(top.kind === 'arr' ? { t: 'arr', v: top.items } : { t: 'dict', v: itemsToDict(top.items) });
          }
        }
        if (tok.v === 'BI') {
          ops.push(readInlineImage(lex, bytes, opStart));
        } else {
          ops.push({ op: tok.v, operands, start: opStart, end: lex.pos });
        }
        operands = [];
        opStart = -1;
        break;
      }
    }
  }
  return { bytes, ops };
}

function itemsToDict(items: Operand[]): Map<string, Operand> {
  const m = new Map<string, Operand>();
  for (let i = 0; i + 1 < items.length; i += 2) {
    const k = items[i]!;
    if (k.t === 'name') m.set(k.v, items[i + 1]!);
  }
  return m;
}

function readInlineImage(lex: ContentLexer, bytes: Uint8Array, start: number): ContentOp {
  const dictItems: Operand[] = [];
  for (;;) {
    const tok = lex.next();
    if (tok.k === 'eof') throw new PdfError('INVALID_PDF', 'Unterminated inline image');
    if (tok.k === 'op' && tok.v === 'ID') break;
    if (tok.k === 'operand') dictItems.push(tok.v);
  }
  const dict = itemsToDict(dictItems);
  lex.pos++; // single whitespace after ID
  const dataStart = lex.pos;
  // Find "EI" delimited by whitespace and followed by whitespace/EOF. Image data may contain "EI",
  // so require the following bytes to look like a content-stream continuation.
  let p = dataStart;
  for (;;) {
    p = indexOfEI(bytes, p);
    if (p < 0) throw new PdfError('INVALID_PDF', 'Inline image without EI');
    const after = bytes[p + 2];
    if ((p === dataStart || WS[bytes[p - 1]!]) && (after === undefined || WS[after])) break;
    p += 2;
  }
  let dataEnd = p;
  if (dataEnd > dataStart && WS[bytes[dataEnd - 1]!]) dataEnd--;
  lex.pos = p + 2;
  return { op: 'BI', operands: [{ t: 'dict', v: dict }], start, end: lex.pos, inlineData: bytes.subarray(dataStart, dataEnd) };
}

function indexOfEI(b: Uint8Array, from: number): number {
  for (let i = from; i + 1 < b.length; i++) if (b[i] === 0x45 && b[i + 1] === 0x49) return i;
  return -1;
}

const fmtNum = (n: number): string => {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};

export function serializeOperand(o: Operand): string {
  switch (o.t) {
    case 'num':
      return fmtNum(o.v);
    case 'bool':
      return String(o.v);
    case 'null':
      return 'null';
    case 'name':
      return '/' + o.v.replace(/[^!-~]|[#()<>[\]{}/%]/g, (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'));
    case 'str':
      return '<' + Buffer.from(o.v).toString('hex') + '>';
    case 'arr':
      return '[' + o.v.map(serializeOperand).join(' ') + ']';
    case 'dict':
      return '<<' + [...o.v].map(([k, v]) => `${serializeOperand({ t: 'name', v: k })} ${serializeOperand(v)}`).join(' ') + '>>';
  }
}

export function serializeOp(op: string, operands: Operand[]): string {
  return operands.length ? `${operands.map(serializeOperand).join(' ')} ${op}` : op;
}

export const num = (v: number): Operand => ({ t: 'num', v });
export const name = (v: string): Operand => ({ t: 'name', v });
export const str = (v: Uint8Array): Operand => ({ t: 'str', v, hex: true });

export type StreamPatch = {
  /** Replace op i with this text ('' deletes it). */
  replace: Map<number, string>;
  /** Insert text after op i (-1 = at start). */
  insertAfter: Map<number, string[]>;
  /** Insert text before op i. */
  insertBefore: Map<number, string[]>;
};

export const emptyPatch = (): StreamPatch => ({ replace: new Map(), insertAfter: new Map(), insertBefore: new Map() });

/** Applies a patch, copying all untouched bytes (including whitespace and comments) verbatim. */
export function applyPatch(content: ParsedContent, patch: StreamPatch, append: string[] = []): Uint8Array {
  const { bytes, ops } = content;
  const chunks: Uint8Array[] = [];
  const enc = (s: string) => Buffer.from(s, 'latin1');
  let cursor = 0;
  const atStart = patch.insertAfter.get(-1);
  if (atStart) chunks.push(enc(atStart.join('\n') + '\n'));
  ops.forEach((op, i) => {
    chunks.push(bytes.subarray(cursor, op.start));
    const before = patch.insertBefore.get(i);
    if (before) chunks.push(enc(before.join('\n') + '\n'));
    const rep = patch.replace.get(i);
    chunks.push(rep === undefined ? bytes.subarray(op.start, op.end) : enc(rep));
    const after = patch.insertAfter.get(i);
    if (after) chunks.push(enc('\n' + after.join('\n')));
    cursor = op.end;
  });
  chunks.push(bytes.subarray(cursor));
  if (append.length) chunks.push(enc('\n' + append.join('\n') + '\n'));
  return Buffer.concat(chunks);
}
