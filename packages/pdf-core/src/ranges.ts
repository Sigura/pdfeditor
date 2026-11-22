import { PdfError } from './errors.ts';

/**
 * Parses a 1-based page range spec ("1-3,5,8-", "-2", "5-3") into 0-based indices, in the order
 * given. Duplicates are kept (a range may intentionally repeat pages).
 */
export function parsePageRanges(spec: string | undefined, pageCount: number): number[] {
  if (spec === undefined || spec.trim() === '' || spec.trim() === '*') {
    return Array.from({ length: pageCount }, (_, i) => i);
  }
  const out: number[] = [];
  for (const raw of spec.split(',')) {
    const part = raw.trim();
    if (part === '') throw new PdfError('INVALID_RANGE', `Empty element in page range "${spec}"`);
    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(part);
    if (!m || (m[1] === undefined && m[3] === undefined)) {
      throw new PdfError('INVALID_RANGE', `Invalid page range element "${part}"`);
    }
    const isRange = m[2] !== undefined;
    if (!isRange && m[3] !== undefined) throw new PdfError('INVALID_RANGE', `Invalid page range element "${part}"`);
    const start = m[1] !== undefined ? Number(m[1]) : 1;
    const end = isRange ? (m[3] !== undefined ? Number(m[3]) : pageCount) : start;
    for (const n of [start, end]) {
      if (n < 1 || n > pageCount) {
        throw new PdfError('INVALID_RANGE', `Page ${n} out of bounds in "${part}" (document has ${pageCount} pages)`);
      }
    }
    const step = end >= start ? 1 : -1;
    for (let p = start; step > 0 ? p <= end : p >= end; p += step) out.push(p - 1);
  }
  return out;
}
