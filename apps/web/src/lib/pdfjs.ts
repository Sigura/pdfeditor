import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function openPdf(data: Uint8Array) {
  // pdf.js transfers the buffer to the worker, so give it a copy.
  return pdfjs.getDocument({ data: data.slice(), isEvalSupported: false, enableXfa: false }).promise;
}

export type PdfDoc = Awaited<ReturnType<typeof openPdf>>;

export async function renderThumbnail(doc: PdfDoc, pageNumber: number, width: number): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return canvas.toDataURL('image/png');
}
