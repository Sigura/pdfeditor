import { PDFDict, PDFName, PDFPage, PDFRawStream, PDFRef, type PDFContext, type PDFDocument } from 'pdf-lib';
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
      copyPage(doc, b.copy);
    } else {
      const page = doc.addPage([b.width, b.height]);
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('')));
    }
  }
}

const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'].map((k) => PDFName.of(k));

/**
 * Appends a copy of page k that shares content streams, fonts and images with it: an edit writes a new
 * page content stream, but patches a Form XObject in place, so forms (and forms inside them) are cloned.
 * Only link annotations are copied: widgets belong to form fields, markup annotations pair with popups.
 */
export function copyPage(doc: PDFDocument, k: number): void {
  const ctx = doc.context;
  const src = doc.getPage(k).node;
  const leaf = src.clone();
  for (const key of INHERITED) {
    const v = leaf.get(key) ? undefined : src.getInheritableAttribute(key);
    if (v) leaf.set(key, v);
  }
  leaf.delete(PDFName.of('Parent'));
  const res = leaf.lookup(PDFName.of('Resources'));
  if (res instanceof PDFDict) leaf.set(PDFName.of('Resources'), withOwnForms(ctx, res, new Map()));
  const ref = ctx.register(leaf);
  const annots = src.Annots();
  leaf.delete(PDFName.of('Annots'));
  const links = (annots?.asArray() ?? []).flatMap((a) => {
    const d = ctx.lookup(a);
    if (!(d instanceof PDFDict) || d.get(PDFName.of('Subtype'))?.toString() !== '/Link') return [];
    const c = d.clone(ctx);
    c.set(PDFName.of('P'), ref);
    return [ctx.register(c)];
  });
  if (links.length) leaf.set(PDFName.of('Annots'), ctx.obj(links));
  doc.addPage(PDFPage.of(leaf, ref, doc));
}

function withOwnForms(ctx: PDFContext, res: PDFDict, done: Map<PDFRef, PDFRef>): PDFDict {
  const xobjects = res.lookup(PDFName.of('XObject'));
  if (!(xobjects instanceof PDFDict)) return res;
  const out = res.clone(ctx);
  const own = xobjects.clone(ctx);
  for (const [name, v] of xobjects.entries()) {
    const form = v instanceof PDFRef ? ctx.lookup(v) : undefined;
    if (!(v instanceof PDFRef) || !(form instanceof PDFRawStream) || form.dict.get(PDFName.of('Subtype'))?.toString() !== '/Form') continue;
    let copy = done.get(v);
    if (!copy) {
      const c = form.clone(ctx);
      copy = ctx.register(c);
      done.set(v, copy);
      const inner = c.dict.lookup(PDFName.of('Resources'));
      if (inner instanceof PDFDict) c.dict.set(PDFName.of('Resources'), withOwnForms(ctx, inner, done));
    }
    own.set(name, copy);
  }
  out.set(PDFName.of('XObject'), own);
  return out;
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
