import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function openPdf(data: Uint8Array) {
  // pdf.js transfers the buffer to the worker, so give it a copy.
  return pdfjs.getDocument({ data: data.slice(), isEvalSupported: false, enableXfa: false }).promise;
}

export type PdfDoc = Awaited<ReturnType<typeof openPdf>>;

/** `rotate`: degrees added to the page's own rotation. */
export async function renderThumbnail(doc: PdfDoc, pageNumber: number, width: number, rotate = 0): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const rotation = (page.rotate + rotate) % 360;
  const base = page.getViewport({ scale: 1, rotation });
  const viewport = page.getViewport({ scale: width / base.width, rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return canvas.toDataURL('image/png');
}
