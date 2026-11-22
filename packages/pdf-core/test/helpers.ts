import { PDFDocument, PDFHexString, PDFName, PDFPage, PDFRawStream, PDFString, StandardFonts, PDFDict, PDFArray, PDFStream } from 'pdf-lib';
import { computeLegacyKey, computeLegacyO, computeLegacyU, rc4, type EncryptParams } from '../src/crypto/standard.ts';
import { createHash } from 'node:crypto';

export async function makePdf(pageCount: number, label: string, opts: { size?: [number, number]; rotate?: number } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage(opts.size ?? [300, 400]);
    if (opts.rotate) page.setRotation({ type: 'degrees', angle: opts.rotate } as never);
    page.drawText(`${label} page ${i + 1}`, { x: 20, y: 350, size: 14, font });
  }
  return doc;
}

export function addInternalLink(doc: PDFDocument, from: PDFPage, to: PDFPage) {
  const link = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [10, 10, 100, 30],
    Border: [0, 0, 0],
    Dest: [to.ref, PDFName.of('Fit')],
  });
  from.node.addAnnot(doc.context.register(link));
}

/** RC4-128 (V2/R3) encryption of a classic-xref file, enough to exercise the decryption path. */
export async function encryptRc4(doc: PDFDocument, userPassword: string, ownerPassword: string): Promise<Uint8Array> {
  const id0 = new Uint8Array(createHash('md5').update(userPassword + ownerPassword).digest());
  const base = { v: 2, r: 3, lengthBytes: 16, p: -4, id0, encryptMetadata: true, stmMethod: 'rc4', strMethod: 'rc4', u: new Uint8Array(32) } as const;
  const o = computeLegacyO(base, Buffer.from(ownerPassword, 'latin1'), Buffer.from(userPassword, 'latin1'));
  const params: EncryptParams = { ...base, o };
  const key = computeLegacyKey(params, Buffer.from(userPassword, 'latin1'));
  const u = computeLegacyU(params, key);
  const objKey = (n: number, g: number) =>
    createHash('md5').update(key).update(Uint8Array.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, g & 255, (g >> 8) & 255])).digest().subarray(0, 16);
  const ctx = doc.context;
  const encStrings = (obj: unknown, k: Uint8Array): void => {
    if (obj instanceof PDFDict) for (const [name, v] of obj.entries()) {
      if (v instanceof PDFString || v instanceof PDFHexString) obj.set(name, PDFHexString.of(Buffer.from(rc4(k, v.asBytes())).toString('hex')));
      else encStrings(v, k);
    }
    if (obj instanceof PDFArray) for (let i = 0; i < obj.size(); i++) {
      const v = obj.get(i);
      if (v instanceof PDFString || v instanceof PDFHexString) obj.set(i, PDFHexString.of(Buffer.from(rc4(k, v.asBytes())).toString('hex')));
      else encStrings(v, k);
    }
  };
  // Flush pending font embedding so every object exists before encryption.
  await doc.flush();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const k = objKey(ref.objectNumber, ref.generationNumber);
    if (obj instanceof PDFRawStream) ctx.assign(ref, PDFRawStream.of(obj.dict, rc4(k, obj.contents)));
    else if (obj instanceof PDFStream) ctx.assign(ref, PDFRawStream.of(obj.dict, rc4(k, obj.getContents())));
    encStrings(obj, k);
  }
  const encRef = ctx.register(ctx.obj({ Filter: 'Standard', V: 2, R: 3, Length: 128, P: -4,
    O: PDFHexString.of(Buffer.from(o).toString('hex')), U: PDFHexString.of(Buffer.from(u).toString('hex')) }));
  ctx.trailerInfo.Encrypt = encRef;
  const idHex = PDFHexString.of(Buffer.from(id0).toString('hex'));
  ctx.trailerInfo.ID = ctx.obj([idHex, idHex]);
  return doc.save({ useObjectStreams: false });
}

type RasterPath = {
  segments: { x0: number; y0: number; x1: number; y1: number }[];
  rects: { x0: number; y0: number; x1: number; y1: number }[];
  paint: string;
  lineWidth: number;
  fill: { values: number[] };
  stroke: { values: number[] };
};

/**
 * Minimal rasterizer for axis-aligned table drawings (fills and straight strokes), `scale` px per pt,
 * pixel centres sampled. Stroke ends joined to a perpendicular segment of the same path get a miter
 * square; free ends are butt. Returns a colour key per pixel ('' = unpainted), row 0 at `area.y1`.
 */
export function rasterize(paths: RasterPath[], area: { x0: number; y0: number; x1: number; y1: number }, scale: number, what: 'fill' | 'stroke' | 'all' = 'all'): string[][] {
  const w = Math.round((area.x1 - area.x0) * scale);
  const h = Math.round((area.y1 - area.y0) * scale);
  const img = Array.from({ length: h }, () => Array<string>(w).fill(''));
  const paintRect = (x0: number, y0: number, x1: number, y1: number, key: string) => {
    for (let j = 0; j < h; j++) {
      const y = area.y1 - (j + 0.5) / scale;
      if (y < y0 || y > y1) continue;
      for (let i = 0; i < w; i++) {
        const x = area.x0 + (i + 0.5) / scale;
        if (x >= x0 && x <= x1) img[j]![i] = key;
      }
    }
  };
  const key = (v: number[]) => v.map((n) => n.toFixed(2)).join(',');
  for (const p of paths) {
    if ((p.paint === 'fill' || p.paint === 'fillStroke') && what !== 'stroke') {
      for (const r of p.rects) paintRect(r.x0, r.y0, r.x1, r.y1, key(p.fill.values));
      if (p.segments.length) {
        const xs = p.segments.flatMap((s) => [s.x0, s.x1]);
        const ys = p.segments.flatMap((s) => [s.y0, s.y1]);
        paintRect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), key(p.fill.values));
      }
    }
    if ((p.paint === 'stroke' || p.paint === 'fillStroke') && what !== 'fill') {
      const hw = p.lineWidth / 2;
      const k = key(p.stroke.values);
      const segs = [...p.segments, ...p.rects.flatMap((r) => [
        { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y0 }, { x0: r.x1, y0: r.y0, x1: r.x1, y1: r.y1 },
        { x0: r.x1, y0: r.y1, x1: r.x0, y1: r.y1 }, { x0: r.x0, y0: r.y1, x1: r.x0, y1: r.y0 },
      ])];
      const horiz = (s: (typeof segs)[number]) => Math.abs(s.y0 - s.y1) < 1e-6;
      const joined = (s: (typeof segs)[number], x: number, y: number) => segs.some((o) => o !== s && horiz(o) !== horiz(s) && ((Math.abs(o.x0 - x) < 1e-6 && Math.abs(o.y0 - y) < 1e-6) || (Math.abs(o.x1 - x) < 1e-6 && Math.abs(o.y1 - y) < 1e-6)));
      for (const s of segs) {
        if (Math.hypot(s.x1 - s.x0, s.y1 - s.y0) < 1e-6) continue;
        const e0 = joined(s, s.x0, s.y0) ? hw : 0;
        const e1 = joined(s, s.x1, s.y1) ? hw : 0;
        if (horiz(s)) {
          const [a, b, ea, eb] = s.x0 <= s.x1 ? [s.x0, s.x1, e0, e1] : [s.x1, s.x0, e1, e0];
          paintRect(a - ea, s.y0 - hw, b + eb, s.y0 + hw, k);
        } else {
          const [a, b, ea, eb] = s.y0 <= s.y1 ? [s.y0, s.y1, e0, e1] : [s.y1, s.y0, e1, e0];
          paintRect(s.x0 - hw, a - ea, s.x0 + hw, b + eb, k);
        }
      }
    }
  }
  return img;
}

/** Share of differing pixels between two equal-size rasters. */
export function rasterDiff(a: string[][], b: string[][]): number {
  let diff = 0;
  let n = 0;
  a.forEach((row, j) => row.forEach((v, i) => {
    n++;
    if (b[j]?.[i] !== v) diff++;
  }));
  return n ? diff / n : 0;
}
