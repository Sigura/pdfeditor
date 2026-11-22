import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObjectCopier, PDFRawStream, PDFRef, type PDFContext, type PDFObject } from 'pdf-lib';
import { getDocument, ImageKind, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Matrix, Rect } from '@pdf-toolkit/shared';
import { apply, invert, mul } from '../math.ts';

type Samples = { data: Uint8Array; w: number; h: number; bpc: number; comps: number };

const WASM_URL = pathToFileURL(path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'wasm') + '/').href;

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

/** Samples to cut and the image dictionary entries a piece gets (besides its size); `mask`: the soft mask (or stencil mask) cut along. */
type Source = { samples: Samples; entries: Record<string, PDFObject>; mask?: Source & { key: 'SMask' | 'Mask' } };

/** The image's own samples, decoded here: the pieces keep its colour space, decode array and masks. */
function rawSource(ctx: PDFContext, stream: PDFRawStream): Source | null {
  const main = samplesOf(ctx, stream);
  if (!main) return null;
  const entriesOf = (s: PDFRawStream) => {
    const dict = s.dict.clone(ctx);
    for (const k of ['Filter', 'DecodeParms', 'Length', 'SMask', 'Mask', 'Metadata', 'Width', 'Height']) dict.delete(PDFName.of(k));
    const mask = s.dict.lookup(PDFName.of('Mask'));
    if (mask instanceof PDFArray) dict.set(PDFName.of('Mask'), mask);
    return Object.fromEntries([...dict.entries()].map(([k, v]) => [k.decodeText(), v]));
  };
  const key = stream.dict.has(PDFName.of('SMask')) ? 'SMask' : 'Mask';
  const maskObj = stream.dict.lookup(PDFName.of(key));
  if (!(maskObj instanceof PDFRawStream)) return { samples: main, entries: entriesOf(stream) };
  const mask = samplesOf(ctx, maskObj);
  if (!mask || mask.w !== main.w || mask.h !== main.h) return null;
  return { samples: main, entries: entriesOf(stream), mask: { samples: mask, entries: entriesOf(maskObj), key } };
}

/**
 * The image as pdf.js decodes it (DCT, JPX, CCITT, JBIG2: filters pdf-lib can't decode), for pieces
 * stored losslessly: RGB or 1-bit grey after pdf.js's colour conversion, with its alpha as a soft mask.
 */
async function pdfjsSource(ctx: PDFContext, ref: PDFRef): Promise<Source | null> {
  const one = await PDFDocument.create();
  const page = one.addPage([1, 1]);
  page.node.setXObject(PDFName.of('Im'), PDFObjectCopier.for(ctx, one.context).copy(ref));
  page.node.set(PDFName.of('Contents'), one.context.register(one.context.flateStream('q 1 0 0 1 0 0 cm /Im Do Q')));
  const pdf = await getDocument({ data: await one.save(), isEvalSupported: false, isOffscreenCanvasSupported: false, wasmUrl: WASM_URL, verbosity: 0 }).promise;
  try {
    const pp = await pdf.getPage(1);
    const list = await pp.getOperatorList();
    const at = list.fnArray.indexOf(OPS.paintImageXObject);
    if (at < 0) return null;
    const id = (list.argsArray[at] as [string])[0];
    const img = await new Promise<{ width: number; height: number; kind: number; data?: Uint8Array | Uint8ClampedArray }>((resolve) => pp.objs.get(id, resolve));
    const { width: w, height: h, kind, data } = img;
    if (!data) return null;
    const entries = (cs: string, bpc: number) => ({ Type: PDFName.of('XObject'), Subtype: PDFName.of('Image'), ColorSpace: PDFName.of(cs), BitsPerComponent: PDFNumber.of(bpc) });
    if (kind === ImageKind.GRAYSCALE_1BPP) return { samples: { data: new Uint8Array(data), w, h, bpc: 1, comps: 1 }, entries: entries('DeviceGray', 1) };
    if (kind === ImageKind.RGB_24BPP) return { samples: { data: new Uint8Array(data), w, h, bpc: 8, comps: 3 }, entries: entries('DeviceRGB', 8) };
    if (kind !== ImageKind.RGBA_32BPP) return null;
    const rgb = new Uint8Array(w * h * 3);
    const alpha = new Uint8Array(w * h);
    let opaque = true;
    for (let i = 0; i < w * h; i++) {
      rgb[i * 3] = data[i * 4]!;
      rgb[i * 3 + 1] = data[i * 4 + 1]!;
      rgb[i * 3 + 2] = data[i * 4 + 2]!;
      alpha[i] = data[i * 4 + 3]!;
      if (alpha[i] !== 255) opaque = false;
    }
    const main: Source = { samples: { data: rgb, w, h, bpc: 8, comps: 3 }, entries: entries('DeviceRGB', 8) };
    return opaque ? main : { ...main, mask: { samples: { data: alpha, w, h, bpc: 8, comps: 1 }, entries: entries('DeviceGray', 8), key: 'SMask' } };
  } finally {
    await pdf.destroy();
  }
}

/**
 * Cuts pieces out of an image painted with `ctm`: each piece is a new image XObject holding the source
 * samples whole (cut at pixel boundaries, with a margin), placed so its pixels land exactly on the
 * original ones. A rotated or skewed placement is cut in the image's own pixel grid (the bounding box of
 * the area there), so no pixel is resampled; the caller's clip trims the piece. A viewer then paints only the piece instead of the whole image under a
 * clip. Images pdf-lib can decode keep their colour space, decode array and masks; the others are
 * decoded by pdf.js. Returns null when the image can't be cut (a degenerate placement, an image mask or
 * a filter neither can decode, a mask of another size).
 */
export async function imageCropper(ctx: PDFContext, ref: PDFRef, ctm: Matrix): Promise<((user: Rect) => ImageCrop | null) | null> {
  const inv = invert(ctm);
  if (!inv) return null;
  const stream = ctx.lookup(ref);
  if (!(stream instanceof PDFRawStream)) return null;
  const mask = stream.dict.lookup(PDFName.of('ImageMask'))?.toString() === 'true';
  const source = rawSource(ctx, stream) ?? (mask ? null : await pdfjsSource(ctx, ref));
  if (!source) return null;
  const { w: W, h: H } = source.samples;
  const cache = new Map<string, ImageCrop>();

  const make = (src: Source, x0: number, y0: number, w: number, h: number, extra?: [string, PDFRef]) =>
    ctx.register(ctx.flateStream(cropSamples(src.samples, x0, y0, w, h), { ...src.entries, ...(extra && { [extra[0]]: extra[1] }), Width: w, Height: h }));

  return (user: Rect) => {
    // Image space: u right, v up over the unit square; pixel row 0 is the top (v = 1).
    const corners = [apply(inv, user.x0, user.y0), apply(inv, user.x1, user.y0), apply(inv, user.x0, user.y1), apply(inv, user.x1, user.y1)];
    const us = corners.map((p) => p[0]);
    const vs = corners.map((p) => p[1]);
    const x0 = Math.max(0, alignDown(Math.floor(Math.min(...us) * W) - MARGIN));
    const x1 = Math.min(W, alignUp(Math.ceil(Math.max(...us) * W) + MARGIN));
    const y0 = Math.max(0, alignDown(Math.floor((1 - Math.max(...vs)) * H) - MARGIN));
    const y1 = Math.min(H, alignUp(Math.ceil((1 - Math.min(...vs)) * H) + MARGIN));
    if (x1 <= x0 || y1 <= y0) return null;
    const key = `${x0},${y0},${x1},${y1}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const [w, h] = [x1 - x0, y1 - y0];
    const maskRef = source.mask && make(source.mask, x0, y0, w, h);
    const crop: ImageCrop = { ref: make(source, x0, y0, w, h, maskRef && [source.mask!.key, maskRef]), ctm: mul([w / W, 0, 0, h / H, x0 / W, 1 - y1 / H], ctm) };
    cache.set(key, crop);
    return crop;
  };
}
