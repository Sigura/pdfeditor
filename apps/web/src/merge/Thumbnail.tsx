import { useEffect, useState } from 'react';
import { openPdf, renderThumbnail, type PdfDoc } from '../lib/pdfjs.ts';
import type { SourceFile } from './store.ts';

const docCache = new Map<string, Promise<PdfDoc>>();

export function getPdfDoc(file: SourceFile): Promise<PdfDoc> {
  let p = docCache.get(file.id);
  if (!p) {
    p = file.password
      ? import('pdfjs-dist').then((pdfjs) => pdfjs.getDocument({ data: file.bytes.slice(), password: file.password, isEvalSupported: false }).promise)
      : openPdf(file.bytes);
    docCache.set(file.id, p);
  }
  return p;
}

export function Thumbnail({ file, pageIndex, width = 140 }: { file: SourceFile; pageIndex: number; width?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    getPdfDoc(file)
      .then((doc) => renderThumbnail(doc, pageIndex + 1, width * 2))
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [file, pageIndex, width]);
  if (failed) return <div className="flex h-44 items-center justify-center text-xs text-red-600">render failed</div>;
  if (!src) return <div className="h-44 animate-pulse bg-slate-200" style={{ width }} />;
  return <img src={src} alt={`${file.name} page ${pageIndex + 1}`} style={{ width }} className="block bg-white shadow" draggable={false} />;
}
