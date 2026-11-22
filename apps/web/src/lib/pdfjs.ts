import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const fontUrls = import.meta.glob<string>('/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', { query: '?url', import: 'default', eager: true });
const fontByName = new Map(Object.entries(fontUrls).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));

// Non-embedded standard-14 fonts would otherwise render with whatever the viewer's system maps
// "Helvetica" to, so ink measurements (and the look) would differ between machines.
class StandardFontData {
  async fetch({ filename }: { filename: string }): Promise<Uint8Array> {
    const url = fontByName.get(filename);
    if (!url) throw new Error(`No bundled standard font ${filename}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Loading ${filename} failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

export function openPdf(data: Uint8Array, password?: string) {
  // pdf.js transfers the buffer to the worker, so give it a copy.
  return pdfjs.getDocument({
    data: data.slice(),
    password,
    isEvalSupported: false,
    enableXfa: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    StandardFontDataFactory: StandardFontData,
  }).promise;
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
