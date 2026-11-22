import { decodePDFRawStream, PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, type PDFContext, type PDFObject } from 'pdf-lib';
import type { Matrix, Rect } from '@pdf-toolkit/shared';

type Samples = { data: Uint8Array; w: number; h: number; bpc: number; comps: number };

/** The filters pdf-lib decodes. */
const DECODABLE = new Set(['/FlateDecode', '/LZWDecode', '/ASCII85Decode', '/ASCIIHexDecode', '/RunLengthDecode']);

const numOf =(o: PDFObject | undefined) => (o instanceof PDFNumber ? o.asNumber() : undefined);

function components(ctx: PDFContext, cs: PDFObject | undefined): number | null {
  const o = cs instanceof PDFRef ? ctx.lookup(cs) : cs;
  if (o instanceof PDFName) return ({ DeviceGray: 1, CalGray: 1, DeviceRGB: 3, CalRGB: 3, Lab: 3, DeviceCMYK: 4 } as Record<string, number>)[o.decodeText()] ?? null;
  if (!(o instanceof PDFArray) || !o.size()) return null;
  const kind = o.lookup(0, PDFName).decodeText();
  if (kind === 'Indexed') return 1;
  if (kind === 'ICCBased') return numOf(o.lookup(1, PDFRawStream).dict.lookup(PDFName.of('N'))) ?? null;
  if (kind === 'CalGray') return 1;
  if (kind === 'CalRGB' || kind === 'Lab') return 3;
  if (kind === 'Separation') return 1;
  if (kind === 'DeviceN') return o.lookup(1, PDFArray).size();
  return null;
}

/** Undoes PNG predictors (Predictor ≥ 10) in place of the decoded rows. */
function unpredict(raw: Uint8Array, rowBytes: number, bpp: number, h: number): Uint8Array | null {
  const out = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) {
    const at = y * (rowBytes + 1);
    if (at + rowBytes + 1 > raw.length) return null;
    const type = raw[at]!;
    const row = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    const up = y ? out.subarray((y - 1) * rowBytes, y * rowBytes) : new Uint8Array(rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[at + 1 + i]!;
      const a = i >= bpp ? row[i - bpp]! : 0;
      const b = up[i]!;
      const c = i >= bpp ? up[i - bpp]! : 0;
      let v: number;
      if (type === 0) v = x;
      else if (type === 1) v = x + a;
      else if (type === 2) v = x + b;
      else if (type === 3) v = x + ((a + b) >> 1);
      else if (type === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else return null;
      row[i] = v & 0xff;
    }
  }
  return out;
}

/** The image's samples, or null when its filter can't be decoded here (DCT, JPX, CCITT, JBIG2) or it isn't a plain sampled image. */
function samplesOf(ctx: PDFContext, s: PDFRawStream): Samples | null {
  const d = s.dict;
  const w = numOf(d.lookup(PDFName.of('Width')));
  const h = numOf(d.lookup(PDFName.of('Height')));
  const mask = d.lookup(PDFName.of('ImageMask'))?.toString() === 'true';
  const bpc = mask ? 1 : numOf(d.lookup(PDFName.of('BitsPerComponent')));
  const comps = mask ? 1 : components(ctx, d.get(PDFName.of('ColorSpace')));
  if (!w || !h || !bpc || !comps) return null;
  const filters = d.lookup(PDFName.of('Filter'));
  const names = filters instanceof PDFArray ? filters.asArray().map((n) => n.toString()) : filters ? [filters.toString()] : [];
  if (!names.every((n) => DECODABLE.has(n))) return null;
  const raw = decodePDFRawStream(s).decode();
  const rowBytes = Math.ceil((w * comps * bpc) / 8);
  const parmsObj = d.lookup(PDFName.of('DecodeParms'));
  const parms = parmsObj instanceof PDFArray ? parmsObj.lookupMaybe(parmsObj.size() - 1, PDFDict) : parmsObj instanceof PDFDict ? parmsObj : undefined;
  const predictor = parms && filters ? (numOf(parms.lookup(PDFName.of('Predictor'))) ?? 1) : 1;
  if (predictor >= 10) {
    // The predictor works on its own declared layout; it has to match the image's.
    const colors = numOf(parms!.lookup(PDFName.of('Colors'))) ?? 1;
    const pbpc = numOf(parms!.lookup(PDFName.of('BitsPerComponent'))) ?? 8;
    const columns = numOf(parms!.lookup(PDFName.of('Columns'))) ?? 1;
    if (colors !== comps || pbpc !== bpc || columns !== w) return null;
    const un = unpredict(raw, rowBytes, Math.max(1, Math.ceil((comps * bpc) / 8)), h);
    return un && { data: un, w, h, bpc, comps };
  }
  if (predictor !== 1 || raw.length < rowBytes * h) return null;
  return { data: raw, w, h, bpc, comps };
}

function cropSamples(s: Samples, x0: number, y0: number, w: number, h: number): Uint8Array {
  const bitsPx = s.comps * s.bpc;
  const srcRow = Math.ceil((s.w * bitsPx) / 8);
  const dstRow = Math.ceil((w * bitsPx) / 8);
  const out = new Uint8Array(dstRow * h);
  for (let y = 0; y < h; y++) {
    const src = (y0 + y) * srcRow;
    if (bitsPx % 8 === 0) {
      const bx = (x0 * bitsPx) / 8;
      out.set(s.data.subarray(src + bx, src + bx + dstRow), y * dstRow);
      continue;
    }
    const total = w * bitsPx;
    for (let b = 0; b < total; b++) {
      const sb = x0 * bitsPx + b;
      if ((s.data[src + (sb >> 3)]! >> (7 - (sb & 7))) & 1) out[y * dstRow + (b >> 3)]! |= 0x80 >> (b & 7);
    }
  }
  return out;
}

const MARGIN = 4;
const ALIGN = 8;
const alignDown = (n: number) => Math.floor(n / ALIGN) * ALIGN;
const alignUp = (n: number) => Math.ceil(n / ALIGN) * ALIGN;

export type ImageCrop = { ref: PDFRef; ctm: Matrix };

/**
 * Cuts pieces out of an axis-aligned image painted with `ctm`: each piece is a new image XObject with
 * the same colour space, decode and bit depth, holding the source samples whole (cut at pixel
 * boundaries, one pixel of margin), placed so its pixels land exactly on the original ones. A viewer
 * then paints only the piece instead of the whole image under a clip. Returns null when the image
 * can't be cut (see samplesOf, a rotated placement, or a soft mask of another size).
 */
export function imageCropper(ctx: PDFContext, ref: PDFRef, ctm: Matrix): ((user: Rect) => ImageCrop | null) | null {
  const [a, b, c, d, e, f] = ctm;
  if (Math.abs(b) > 1e-9 || Math.abs(c) > 1e-9 || !a || !d) return null;
  const stream = ctx.lookup(ref);
  if (!(stream instanceof PDFRawStream)) return null;
  const main = samplesOf(ctx, stream);
  if (!main) return null;
  const smaskRef = stream.dict.get(PDFName.of('SMask')) ?? stream.dict.get(PDFName.of('Mask'));
  const smaskStream = smaskRef instanceof PDFRef ? ctx.lookup(smaskRef) : undefined;
  const smask = smaskStream instanceof PDFRawStream ? samplesOf(ctx, smaskStream) : null;
  if (smaskStream && (!smask || smask.w !== main.w || smask.h !== main.h)) return null;
  const { w: W, h: H } = main;
  const cache = new Map<string, ImageCrop>();

  const make = (src: PDFRawStream, s: Samples, x0: number, y0: number, w: number, h: number, extra?: [string, PDFRef]) => {
    const dict = src.dict.clone(ctx);
    for (const k of ['Filter', 'DecodeParms', 'Length', 'SMask', 'Mask', 'Metadata', 'Width', 'Height']) dict.delete(PDFName.of(k));
    const mask = src.dict.lookup(PDFName.of('Mask'));
    if (mask instanceof PDFArray) dict.set(PDFName.of('Mask'), mask);
    if (extra) dict.set(PDFName.of(extra[0]), extra[1]);
    const entries = Object.fromEntries([...dict.entries()].map(([k, v]) => [k.decodeText(), v]));
    return ctx.register(ctx.flateStream(cropSamples(s, x0, y0, w, h), { ...entries, Width: w, Height: h }));
  };

  return (user: Rect) => {
    // Image space: u right, v up over the unit square; pixel row 0 is the top (v = 1).
    const us = [(user.x0 - e) / a, (user.x1 - e) / a];
    const vs = [(user.y0 - f) / d, (user.y1 - f) / d];
    const x0 = Math.max(0, alignDown(Math.floor(Math.min(...us) * W) - MARGIN));
    const x1 = Math.min(W, alignUp(Math.ceil(Math.max(...us) * W) + MARGIN));
    const y0 = Math.max(0, alignDown(Math.floor((1 - Math.max(...vs)) * H) - MARGIN));
    const y1 = Math.min(H, alignUp(Math.ceil((1 - Math.min(...vs)) * H) + MARGIN));
    if (x1 <= x0 || y1 <= y0) return null;
    const key = `${x0},${y0},${x1},${y1}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const [w, h] = [x1 - x0, y1 - y0];
    const maskRef = smask && smaskStream ? make(smaskStream as PDFRawStream, smask, x0, y0, w, h) : undefined;
    const pieceRef = make(stream, main, x0, y0, w, h, maskRef && [stream.dict.has(PDFName.of('SMask')) ? 'SMask' : 'Mask', maskRef]);
    const crop: ImageCrop = { ref: pieceRef, ctm: [(a * w) / W, 0, 0, (d * h) / H, e + (a * x0) / W, f + d * (1 - y1 / H)] };
    cache.set(key, crop);
    return crop;
  };
}
