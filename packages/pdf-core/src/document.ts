import type { PageModel } from '@pdf-toolkit/shared';
import { loadPdf } from './load.ts';
import { analyzeDocument } from './model/extract.ts';

export type PdfAnalysis = {
  pageCount: number;
  pages: PageModel[];
  decrypted: boolean;
  /** Set when the input was encrypted: the decrypted document, so later steps never need the password. */
  decryptedBytes?: Uint8Array;
};

export async function analyzePdf(bytes: Uint8Array, opts: { password?: string } = {}): Promise<PdfAnalysis> {
  const { doc, decrypted } = await loadPdf(bytes, opts);
  const pages = analyzeDocument(doc).map((p) => p.model);
  const decryptedBytes = decrypted ? await doc.save({ useObjectStreams: false }) : undefined;
  return { pageCount: pages.length, pages, decrypted, decryptedBytes };
}
