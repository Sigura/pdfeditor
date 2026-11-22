import { createHash } from 'node:crypto';
import type { PDFContext, PDFObject } from 'pdf-lib';
import { PdfError } from '../errors.ts';

export type ObjectSnapshot = Map<string, string>;

const key = (num: number, gen: number) => `${num} ${gen}`;

function serialize(obj: PDFObject): Uint8Array {
  const buf = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(buf, 0);
  return buf;
}

const digest = (b: Uint8Array) => createHash('sha1').update(b).digest('hex');

/** Hashes the serialization of every indirect object, taken right after loading. */
export function snapshotObjects(ctx: PDFContext): ObjectSnapshot {
  const snap: ObjectSnapshot = new Map();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) snap.set(key(ref.objectNumber, ref.generationNumber), digest(serialize(obj)));
  return snap;
}

function lastStartXref(bytes: Uint8Array): number {
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 4096))).toString('latin1');
  const m = /startxref\s+(\d+)\s*(?:%%EOF)?\s*$/.exec(tail) ?? [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  if (!m) throw new PdfError('INVALID_PDF', 'No startxref found; an incremental update is not possible');
  return Number(m[1]);
}

/**
 * Appends every object whose serialization differs from the snapshot (or is new) as an incremental
 * update: objects, a classic xref section and a trailer with /Prev. The original bytes stay a prefix.
 */
export function writeIncremental(original: Uint8Array, ctx: PDFContext, snapshot: ObjectSnapshot): Uint8Array {
  const changed: { num: number; gen: number; bytes: Uint8Array }[] = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const bytes = serialize(obj);
    if (snapshot.get(key(ref.objectNumber, ref.generationNumber)) !== digest(bytes)) changed.push({ num: ref.objectNumber, gen: ref.generationNumber, bytes });
  }
  if (changed.length === 0) return original;
  changed.sort((a, b) => a.num - b.num);

  const prev = lastStartXref(original);
  const enc = (s: string) => Buffer.from(s, 'latin1');
  const chunks: Uint8Array[] = [original];
  let offset = original.length;
  const push = (b: Uint8Array) => {
    chunks.push(b);
    offset += b.length;
  };
  const lastByte = original[original.length - 1];
  if (lastByte !== 0x0a && lastByte !== 0x0d) push(enc('\n'));

  const offsets = new Map<number, number>();
  for (const c of changed) {
    offsets.set(c.num, offset);
    push(enc(`${c.num} ${c.gen} obj\n`));
    push(c.bytes);
    push(enc('\nendobj\n'));
  }

  const xrefOffset = offset;
  let xref = 'xref\n';
  for (let i = 0; i < changed.length; ) {
    let j = i;
    while (j + 1 < changed.length && changed[j + 1]!.num === changed[j]!.num + 1) j++;
    xref += `${changed[i]!.num} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) xref += `${String(offsets.get(changed[k]!.num)).padStart(10, '0')} ${String(changed[k]!.gen).padStart(5, '0')} n \n`;
    i = j + 1;
  }
  const t = ctx.trailerInfo;
  if (!t.Root) throw new PdfError('INVALID_PDF', 'Trailer has no /Root');
  const size = Math.max(ctx.largestObjectNumber, ...changed.map((c) => c.num)) + 1;
  const entries = [`/Size ${size}`, `/Root ${t.Root.toString()}`];
  if (t.Info) entries.push(`/Info ${t.Info.toString()}`);
  if (t.ID) entries.push(`/ID ${t.ID.toString()}`);
  entries.push(`/Prev ${prev}`);
  push(enc(`${xref}trailer\n<< ${entries.join(' ')} >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
