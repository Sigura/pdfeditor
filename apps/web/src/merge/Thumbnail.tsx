import { useEffect, useState } from 'react';
import { openPdf, renderThumbnail, type PdfDoc } from '../lib/pdfjs.ts';
import type { SourceFile } from './store.ts';

const docCache = new Map<string, Promise<PdfDoc>>();

export function getPdfDoc(file: SourceFile): Promise<PdfDoc> {
  let p = docCache.get(file.id);
  if (!p) {
    p = openPdf(file.bytes, file.password);
    docCache.set(file.id, p);
  }
  return p;
}

/** Frees the pdf.js documents of these files (all when omitted); a later thumbnail opens them again. */
export function releasePdfDocs(fileIds: string[] = [...docCache.keys()]) {
  for (const id of fileIds) {
    const p = docCache.get(id);
    if (!p) continue;
    docCache.delete(id);
    p.then((doc) => doc.destroy(), () => undefined);
  }
}

export function Thumbnail({ file, pageIndex, rotate = 0, width = 140 }: { file: SourceFile; pageIndex: number; rotate?: number; width?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let url: string | undefined;
    getPdfDoc(file)
      .then((doc) => renderThumbnail(doc, pageIndex + 1, width * 2, rotate))
      .then((u) => {
        url = u;
        if (alive) setSrc(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file, pageIndex, rotate, width]);
  if (failed) return <div className="flex h-44 items-center justify-center text-xs text-red-600">render failed</div>;
  if (!src) return <div className="h-44 animate-pulse bg-slate-200" style={{ width }} />;
  return <img src={src} alt={`${file.name} page ${pageIndex + 1}`} style={{ width }} className="block bg-white shadow" draggable={false} />;
}
