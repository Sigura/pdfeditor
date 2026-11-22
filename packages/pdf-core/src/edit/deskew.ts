import { PDFName, type PDFDocument } from 'pdf-lib';
import type { DeskewPage, EditOperation } from '@pdf-toolkit/shared';
import { PdfError } from '../errors.ts';
import { loadPdf } from '../load.ts';
import { pageContentBytes } from '../model/extract.ts';
import { snapshotObjects, writeIncremental } from '../save/incremental.ts';
import { fillOp } from './raster.ts';

const num = (n: number) => String(Number(n.toFixed(6)) || 0);

/** The last deskewPage op of each page. */
export function deskews(ops: EditOperation[]): Map<number, DeskewPage> {
  return new Map(ops.flatMap((op) => (op.type === 'deskewPage' ? [[op.pageIndex, op] as const] : [])));
}

/** Appends the arrangement's blank and copied pages, so edit page indices exist before analysis. */
export async function addArrangedPages(doc: PDFDocument, ops: EditOperation[]): Promise<void> {
  for (const b of ops.findLast((op) => op.type === 'arrangePages')?.blanks ?? []) {
    if ('copy' in b) {
      const count = doc.getPageCount();
      if (b.copy >= count) throw new PdfError('INVALID_EDIT', `arrangePages: page ${b.copy + 1} to copy does not exist (${count} pages)`);
      const [copy] = await doc.copyPages(doc, [b.copy]);
      doc.addPage(copy!);
    } else {
      const page = doc.addPage([b.width, b.height]);
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('')));
    }
  }
}

/** Replaces each deskewed page's content with one stream: paper fill, then the old content rotated about the crop box centre. */
export function applyDeskews(doc: PDFDocument, ops: EditOperation[]): void {
  const pages = doc.getPages();
  for (const [k, op] of deskews(ops)) {
    const page = pages[k];
    if (!page) throw new PdfError('INVALID_EDIT', `deskewPage: page ${k + 1} does not exist (${pages.length} pages)`);
    if (Math.abs(op.angle) < 1e-6) continue;
    const mb = page.getMediaBox();
    const cb = page.getCropBox();
    const [cx, cy] = [cb.x + cb.width / 2, cb.y + cb.height / 2];
    const t = (op.angle * Math.PI) / 180;
    const [c, s] = [Math.cos(t), Math.sin(t)];
    const cm = [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy].map(num).join(' ');
    const head = `q ${fillOp(op.paper)} ${num(mb.x)} ${num(mb.y)} ${num(mb.width)} ${num(mb.height)} re f Q\nq ${cm} cm\n`;
    const body = pageContentBytes(page);
    const bytes = new Uint8Array([...new TextEncoder().encode(head), ...body, ...new TextEncoder().encode('\nQ\n')]);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(bytes)));
  }
}

/** The file with only its deskewPage ops applied (incremental): the coordinates every other op is in. */
export async function deskewPdf(original: Uint8Array, ops: EditOperation[]): Promise<Uint8Array> {
  // Copies keep the indices of the edit document, so pages measured here (scan layouts) line up.
  if (!deskews(ops).size && !ops.findLast((op) => op.type === 'arrangePages')?.blanks.some((b) => 'copy' in b)) return original;
  const { doc, decrypted } = await loadPdf(original);
  const snapshot = decrypted ? null : snapshotObjects(doc.context);
  await addArrangedPages(doc, ops);
  applyDeskews(doc, ops);
  return snapshot ? writeIncremental(original, doc.context, snapshot) : doc.save({ useObjectStreams: false });
}
