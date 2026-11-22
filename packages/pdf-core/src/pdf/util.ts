import {
  PDFArray,
  PDFDict,
  PDFFlateStream,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFHexString,
  decodePDFRawStream,
  type PDFContext,
} from 'pdf-lib';

export const N = (s: string): PDFName => PDFName.of(s);

export function resolve(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  let cur = o;
  for (let i = 0; cur instanceof PDFRef && i < 32; i++) cur = ctx.lookup(cur);
  return cur;
}

export function getNum(dict: PDFDict | undefined, key: string, dflt: number): number {
  const v = dict?.lookup(N(key));
  return v instanceof PDFNumber ? v.asNumber() : dflt;
}

export function getName(dict: PDFDict | undefined, key: string): string | undefined {
  const v = dict?.lookup(N(key));
  return v instanceof PDFName ? v.decodeText() : undefined;
}

export function getDict(dict: PDFDict | undefined, key: string): PDFDict | undefined {
  if (!dict) return undefined;
  const v = dict.lookup(N(key));
  return v instanceof PDFDict ? v : v instanceof PDFStream ? v.dict : undefined;
}

export function getArray(dict: PDFDict | undefined, key: string): PDFArray | undefined {
  if (!dict) return undefined;
  const v = dict.lookup(N(key));
  return v instanceof PDFArray ? v : undefined;
}

export function getStream(dict: PDFDict | undefined, key: string): PDFStream | undefined {
  if (!dict) return undefined;
  const v = dict.lookup(N(key));
  return v instanceof PDFStream ? v : undefined;
}

export function numbers(arr: PDFArray | undefined): number[] {
  if (!arr) return [];
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = arr.lookup(i);
    out.push(v instanceof PDFNumber ? v.asNumber() : 0);
  }
  return out;
}

export function textOf(o: PDFObject | undefined): string | undefined {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  if (o instanceof PDFName) return o.decodeText();
  return undefined;
}

/** Decoded (filter-free) bytes of any pdf-lib stream object. */
export function streamBytes(s: PDFStream): Uint8Array {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (s instanceof PDFFlateStream) return s.getUnencodedContents();
  return s.getContents();
}
