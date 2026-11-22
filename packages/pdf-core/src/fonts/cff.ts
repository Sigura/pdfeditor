/**
 * Minimal reader for bare CFF programs (FontFile3 /Type1C, /CIDFontType0C): top DICT, charset
 * and built-in encoding. Charstrings are interpreted by fontkit after wrapping the CFF data in an
 * sfnt container (see wrapCffAsOpenType).
 */
export type CffInfo = {
  fontMatrix: number[];
  numGlyphs: number;
  isCid: boolean;
  /** gid → SID (name-keyed) or CID (CID-keyed). */
  charset: number[];
  /** code → gid from the built-in encoding (name-keyed fonts). */
  encoding: Map<number, number>;
  /** Encoding offset 0: the predefined StandardEncoding (resolved by glyph name). */
  standardEncoding: boolean;
};

type Index = { items: Uint8Array[]; end: number };

function readIndex(b: Uint8Array, pos: number): Index {
  const count = (b[pos]! << 8) | b[pos + 1]!;
  if (count === 0) return { items: [], end: pos + 2 };
  const offSize = b[pos + 2]!;
  const offAt = pos + 3;
  const off = (i: number) => {
    let v = 0;
    for (let k = 0; k < offSize; k++) v = (v << 8) | b[offAt + i * offSize + k]!;
    return v;
  };
  const dataAt = offAt + (count + 1) * offSize - 1;
  const items: Uint8Array[] = [];
  for (let i = 0; i < count; i++) items.push(b.subarray(dataAt + off(i), dataAt + off(i + 1)));
  return { items, end: dataAt + off(count) };
}

function readDict(d: Uint8Array): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let ops: number[] = [];
  let i = 0;
  while (i < d.length) {
    const b0 = d[i]!;
    if (b0 <= 21) {
      const key = b0 === 12 ? 1200 + d[i + 1]! : b0;
      i += b0 === 12 ? 2 : 1;
      out.set(key, ops);
      ops = [];
    } else if (b0 === 28) {
      ops.push(((d[i + 1]! << 24) | (d[i + 2]! << 16)) >> 16);
      i += 3;
    } else if (b0 === 29) {
      ops.push((d[i + 1]! << 24) | (d[i + 2]! << 16) | (d[i + 3]! << 8) | d[i + 4]!);
      i += 5;
    } else if (b0 === 30) {
      let s = '';
      i++;
      const nib = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', 'E', 'E-', '', '-'];
      for (let end = false; !end && i < d.length; i++) {
        for (const n of [d[i]! >> 4, d[i]! & 15]) {
          if (n === 15) {
            end = true;
            break;
          }
          s += nib[n];
        }
      }
      ops.push(Number(s));
    } else if (b0 >= 32 && b0 <= 246) {
      ops.push(b0 - 139);
      i++;
    } else if (b0 >= 247 && b0 <= 250) {
      ops.push((b0 - 247) * 256 + d[i + 1]! + 108);
      i += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      ops.push(-(b0 - 251) * 256 - d[i + 1]! - 108);
      i += 2;
    } else i++;
  }
  return out;
}

export function readCff(b: Uint8Array): CffInfo {
  if (b.length < 4 || b[0] !== 1) throw new Error('not a CFF program');
  const hdrSize = b[2]!;
  const names = readIndex(b, hdrSize);
  const tops = readIndex(b, names.end);
  const top = readDict(tops.items[0] ?? new Uint8Array());
  const fm = top.get(1207);
  const fontMatrix = fm && fm.length === 6 ? fm : [0.001, 0, 0, 0.001, 0, 0];
  const csOff = top.get(17)?.[0];
  if (csOff === undefined) throw new Error('CFF program has no CharStrings');
  const numGlyphs = readIndex(b, csOff).items.length;
  const isCid = top.has(1230);

  const charset: number[] = [0];
  const csetOff = top.get(15)?.[0] ?? 0;
  const push = (sid: number) => charset.push(sid);
  if (csetOff > 2) {
    const fmt = b[csetOff]!;
    let p = csetOff + 1;
    if (fmt === 0) {
      while (charset.length < numGlyphs) {
        push((b[p]! << 8) | b[p + 1]!);
        p += 2;
      }
    } else {
      while (charset.length < numGlyphs && p < b.length) {
        const first = (b[p]! << 8) | b[p + 1]!;
        const left = fmt === 1 ? b[p + 2]! : (b[p + 2]! << 8) | b[p + 3]!;
        p += fmt === 1 ? 3 : 4;
        for (let k = 0; k <= left && charset.length < numGlyphs; k++) push(first + k);
      }
    }
  } else {
    // Predefined charsets (ISOAdobe/Expert): ISOAdobe maps gid → SID 1:1 for the first 229 glyphs.
    for (let g = 1; g < numGlyphs; g++) push(g);
  }

  const encoding = new Map<number, number>();
  const encOff = top.get(16)?.[0] ?? 0;
  if (!isCid && encOff > 1) {
    const fmt = b[encOff]! & 0x7f;
    let p = encOff + 1;
    if (fmt === 0) {
      const n = b[p++]!;
      for (let g = 1; g <= n; g++) encoding.set(b[p++]!, g);
    } else if (fmt === 1) {
      const nRanges = b[p++]!;
      let g = 1;
      for (let r = 0; r < nRanges; r++) {
        const first = b[p]!;
        const left = b[p + 1]!;
        p += 2;
        for (let k = 0; k <= left; k++) encoding.set(first + k, g++);
      }
    }
  }
  return { fontMatrix, numGlyphs, isCid, charset, encoding, standardEncoding: !isCid && encOff === 0 };
}

/** Wraps bare CFF data in an 'OTTO' sfnt (CFF, head, maxp) so fontkit can interpret charstrings. */
export function wrapCffAsOpenType(cff: Uint8Array, numGlyphs: number, unitsPerEm: number): Uint8Array {
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  head.writeUInt16BE(Math.max(16, Math.min(16384, Math.round(unitsPerEm))), 18);
  // fontkit decodes the full version-1.0 layout regardless of the version field.
  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00005000, 0);
  maxp.writeUInt16BE(numGlyphs, 4);
  const tables: [string, Uint8Array][] = [
    ['CFF ', cff],
    ['head', head],
    ['maxp', maxp],
  ];
  const dirSize = 12 + 16 * tables.length;
  const pad = (n: number) => (n + 3) & ~3;
  let offset = dirSize;
  const out = Buffer.alloc(dirSize + tables.reduce((s, [, d]) => s + pad(d.length), 0));
  out.writeUInt32BE(0x4f54544f, 0);
  out.writeUInt16BE(tables.length, 4);
  tables.forEach(([tag, data], i) => {
    const e = 12 + 16 * i;
    out.write(tag, e, 'latin1');
    out.writeUInt32BE(0, e + 4);
    out.writeUInt32BE(offset, e + 8);
    out.writeUInt32BE(data.length, e + 12);
    out.set(data, offset);
    offset += pad(data.length);
  });
  return out;
}
