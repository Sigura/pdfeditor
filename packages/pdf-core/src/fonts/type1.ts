import { BASE_ENCODINGS } from './encodings.ts';

export type PathCmd = { op: 'M' | 'L' | 'C' | 'Z'; p: number[] };
export type Type1Glyph = { path: PathCmd[]; width: number };

export type Type1Program = {
  fontMatrix: number[];
  encoding: (string | undefined)[];
  charStrings: Map<string, Uint8Array>;
  subrs: Uint8Array[];
  glyph(name: string): Type1Glyph | undefined;
};

const EEXEC_KEY = 55665;
const CHARSTRING_KEY = 4330;

function decrypt(data: Uint8Array, key: number, discard: number): Uint8Array {
  let r = key;
  const out = new Uint8Array(Math.max(0, data.length - discard));
  for (let i = 0; i < data.length; i++) {
    const c = data[i]!;
    if (i >= discard) out[i - discard] = c ^ (r >> 8);
    r = ((c + r) * 52845 + 22719) & 0xffff;
  }
  return out;
}

const isHex = (b: number) => (b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102);
const isWs = (b: number) => b === 32 || b === 9 || b === 10 || b === 13 || b === 12 || b === 0;

function hexDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (const b of data) {
    if (!isHex(b)) continue;
    const v = parseInt(String.fromCharCode(b), 16);
    if (hi < 0) hi = v;
    else {
      out.push((hi << 4) | v);
      hi = -1;
    }
  }
  return Uint8Array.from(out);
}

const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

/**
 * Parses an embedded Type1 program (PDF FontFile: cleartext part of `length1` bytes followed by
 * the eexec-encrypted part, binary or hex).
 */
export function parseType1(bytes: Uint8Array, length1: number): Type1Program {
  let clearEnd = length1 > 0 && length1 < bytes.length ? length1 : -1;
  const text = latin1(bytes);
  if (clearEnd < 0 || !text.slice(Math.max(0, clearEnd - 30), clearEnd + 10).includes('eexec')) {
    const at = text.indexOf('eexec');
    if (at < 0) throw new Error('Type1 program has no eexec section');
    clearEnd = at + 5;
  }
  while (clearEnd < bytes.length && isWs(bytes[clearEnd]!)) clearEnd++;
  const clear = text.slice(0, clearEnd);
  let enc = bytes.subarray(clearEnd);
  if (enc.length >= 4 && [0, 1, 2, 3].every((i) => isHex(enc[i]!))) enc = hexDecode(enc);
  const priv = decrypt(enc, EEXEC_KEY, 4);
  const privText = latin1(priv);

  const fm = /\/FontMatrix\s*\[([^\]]*)\]/.exec(clear);
  let fontMatrix = fm ? fm[1]!.trim().split(/\s+/).map(Number) : [0.001, 0, 0, 0.001, 0, 0];
  if (fontMatrix.length !== 6 || fontMatrix.some((n) => !Number.isFinite(n))) fontMatrix = [0.001, 0, 0, 0.001, 0, 0];

  const encoding: (string | undefined)[] = new Array(256).fill(undefined);
  if (/\/Encoding\s+StandardEncoding/.test(clear)) BASE_ENCODINGS.StandardEncoding.forEach((n, i) => (encoding[i] = n));
  else for (const m of clear.matchAll(/dup\s+(\d+)\s*\/([^\s/\[\]{}()<>]+)\s+put/g)) encoding[Number(m[1])] = m[2];

  const lenIVm = /\/lenIV\s+(-?\d+)/.exec(privText);
  const lenIV = lenIVm ? Number(lenIVm[1]) : 4;
  const decodeCs = (b: Uint8Array) => (lenIV < 0 ? b : decrypt(b, CHARSTRING_KEY, lenIV));

  // Binary entries look like `dup 5 23 RD <23 bytes> NP` / `/A 23 -| <23 bytes> |-`.
  const subrs: Uint8Array[] = [];
  const subrsAt = privText.search(/\/Subrs\s+\d+\s+array/);
  const csAt = privText.search(/\/CharStrings\s+\d+\s+dict/);
  if (csAt < 0) throw new Error('Type1 program has no CharStrings');
  if (subrsAt >= 0) {
    const re = /dup\s+(\d+)\s+(\d+)\s+(RD|-\|)\s/y;
    let pos = privText.indexOf('array', subrsAt) + 5;
    for (;;) {
      while (pos < privText.length && isWs(priv[pos]!)) pos++;
      re.lastIndex = pos;
      const m = re.exec(privText);
      if (!m) break;
      const start = re.lastIndex;
      const len = Number(m[2]);
      subrs[Number(m[1])] = decodeCs(priv.subarray(start, start + len));
      pos = start + len;
      const tail = /\s*(NP|\|)\s*(noaccess\s+put)?/y;
      tail.lastIndex = pos;
      if (tail.exec(privText)) pos = tail.lastIndex;
    }
  }
  const charStrings = new Map<string, Uint8Array>();
  {
    const re = /\/([^\s/\[\]{}()<>]+)\s+(\d+)\s+(RD|-\|)\s/g;
    re.lastIndex = csAt;
    let m: RegExpExecArray | null;
    while ((m = re.exec(privText))) {
      const start = re.lastIndex;
      const len = Number(m[2]);
      charStrings.set(m[1]!, decodeCs(priv.subarray(start, start + len)));
      re.lastIndex = start + len;
    }
  }

  const cache = new Map<string, Type1Glyph | undefined>();
  const program: Type1Program = {
    fontMatrix,
    encoding,
    charStrings,
    subrs,
    glyph(name) {
      if (!cache.has(name)) {
        const cs = charStrings.get(name);
        cache.set(name, cs ? runCharString(program, cs) : undefined);
      }
      return cache.get(name);
    },
  };
  return program;
}

/** Type1 charstring interpreter (hints ignored; flex, hint replacement and seac handled). */
function runCharString(font: Type1Program, cs: Uint8Array, depth = 0): Type1Glyph {
  const path: PathCmd[] = [];
  let width = 0;
  let x = 0;
  let y = 0;
  let lsb = 0;
  const stack: number[] = [];
  const ps: number[] = [];
  let flex: number[][] | null = null;
  let open = false;
  const moveTo = (nx: number, ny: number) => {
    x = nx;
    y = ny;
    if (flex) {
      flex.push([x, y]);
      return;
    }
    if (open) path.push({ op: 'Z', p: [] });
    path.push({ op: 'M', p: [x, y] });
    open = true;
  };
  const lineTo = (nx: number, ny: number) => {
    x = nx;
    y = ny;
    path.push({ op: 'L', p: [x, y] });
  };
  const curveTo = (dx1: number, dy1: number, dx2: number, dy2: number, dx3: number, dy3: number) => {
    const x1 = x + dx1;
    const y1 = y + dy1;
    const x2 = x1 + dx2;
    const y2 = y1 + dy2;
    x = x2 + dx3;
    y = y2 + dy3;
    path.push({ op: 'C', p: [x1, y1, x2, y2, x, y] });
  };
  let done = false;

  const exec = (data: Uint8Array, level: number): void => {
    if (level > 10) throw new Error('Type1 subroutine nesting too deep');
    let i = 0;
    while (i < data.length && !done) {
      const v = data[i++]!;
      if (v >= 32) {
        if (v <= 246) stack.push(v - 139);
        else if (v <= 250) stack.push((v - 247) * 256 + data[i++]! + 108);
        else if (v <= 254) stack.push(-(v - 251) * 256 - data[i++]! - 108);
        else {
          stack.push((data[i]! << 24) | (data[i + 1]! << 16) | (data[i + 2]! << 8) | data[i + 3]!);
          i += 4;
        }
        continue;
      }
      switch (v) {
        case 1: // hstem
        case 3: // vstem
          stack.length = 0;
          break;
        case 4:
          moveTo(x, y + (stack[0] ?? 0));
          stack.length = 0;
          break;
        case 5:
          lineTo(x + stack[0]!, y + stack[1]!);
          stack.length = 0;
          break;
        case 6:
          lineTo(x + stack[0]!, y);
          stack.length = 0;
          break;
        case 7:
          lineTo(x, y + stack[0]!);
          stack.length = 0;
          break;
        case 8:
          curveTo(stack[0]!, stack[1]!, stack[2]!, stack[3]!, stack[4]!, stack[5]!);
          stack.length = 0;
          break;
        case 9:
          if (open) path.push({ op: 'Z', p: [] });
          open = false;
          stack.length = 0;
          break;
        case 10: {
          const n = stack.pop()!;
          const sub = font.subrs[n];
          if (sub) exec(sub, level + 1);
          break;
        }
        case 11:
          return;
        case 13: // hsbw
          lsb = stack[0]!;
          width = stack[1]!;
          x = lsb;
          y = 0;
          stack.length = 0;
          break;
        case 14:
          done = true;
          break;
        case 21:
          moveTo(x + stack[0]!, y + stack[1]!);
          stack.length = 0;
          break;
        case 22:
          moveTo(x + stack[0]!, y);
          stack.length = 0;
          break;
        case 30:
          curveTo(0, stack[0]!, stack[1]!, stack[2]!, stack[3]!, 0);
          stack.length = 0;
          break;
        case 31:
          curveTo(stack[0]!, 0, stack[1]!, stack[2]!, 0, stack[3]!);
          stack.length = 0;
          break;
        case 12: {
          const e = data[i++]!;
          switch (e) {
            case 6: {
              // seac: the accent's sidebearing point goes to (adx, ady) relative to the base's.
              const [asb, adx, ady, bchar, achar] = stack.splice(-5, 5) as [number, number, number, number, number];
              const std = BASE_ENCODINGS.StandardEncoding;
              const base = std[bchar] ? font.charStrings.get(std[bchar]!) : undefined;
              const acc = std[achar] ? font.charStrings.get(std[achar]!) : undefined;
              if (depth > 2 || !base || !acc) throw new Error('Type1 seac references missing glyphs');
              const bg = runCharString(font, base, depth + 1);
              const ag = runCharString(font, acc, depth + 1);
              path.push(...bg.path);
              const ox = adx - asb + lsb;
              path.push(...ag.path.map((c) => ({ op: c.op, p: c.p.map((n, k) => n + (k % 2 === 0 ? ox : ady)) })));
              width = bg.width;
              open = false;
              done = true;
              break;
            }
            case 7: // sbw
              lsb = stack[0]!;
              width = stack[2]!;
              x = lsb;
              y = stack[1]!;
              stack.length = 0;
              break;
            case 12: {
              const b = stack.pop()!;
              const a = stack.pop()!;
              stack.push(a / b);
              break;
            }
            case 16: {
              const other = stack.pop()!;
              const n = stack.pop()!;
              const args = stack.splice(-n, n);
              if (other === 1) flex = [];
              else if (other === 0) {
                const pts = flex ?? [];
                flex = null;
                if (pts.length >= 7) {
                  const [p1, p2, p3, p4, p5, p6] = pts.slice(1, 7) as [number[], number[], number[], number[], number[], number[]];
                  path.push({ op: 'C', p: [p1[0]!, p1[1]!, p2[0]!, p2[1]!, p3[0]!, p3[1]!] });
                  path.push({ op: 'C', p: [p4[0]!, p4[1]!, p5[0]!, p5[1]!, p6[0]!, p6[1]!] });
                  x = p6[0]!;
                  y = p6[1]!;
                }
                ps.push(y, x);
              } else if (other === 2) {
                // flex point marker; the point was recorded by the preceding rmoveto
              } else ps.push(...args.reverse());
              break;
            }
            case 17:
              stack.push(ps.pop() ?? 0);
              break;
            case 33:
              x = stack[0]!;
              y = stack[1]!;
              stack.length = 0;
              break;
            default: // dotsection, vstem3, hstem3
              stack.length = 0;
          }
          break;
        }
        default:
          stack.length = 0;
      }
    }
  };
  exec(cs, 0);
  if (open) path.push({ op: 'Z', p: [] });
  return { path, width };
}
