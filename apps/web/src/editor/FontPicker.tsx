import { useEffect, useMemo, useState } from 'react';
import type { PageModel, TextRun } from '@pdf-toolkit/shared';
import type { PdfDoc } from '../lib/pdfjs.ts';
import { useEditor } from './store.ts';

const GENERIC = [
  { name: 'Helvetica', css: 'Helvetica, Arial, sans-serif' },
  { name: 'Times-Roman', css: '"Times New Roman", Times, serif' },
  { name: 'Courier', css: '"Courier New", Courier, monospace' },
];

/** Crops each font's first run out of the rendered page, so the sample shows the file's real glyphs. */
async function samples(pdf: PdfDoc, fonts: { name: string; run: TextRun }[]): Promise<Record<string, string>> {
  const scale = 2;
  const pages = new Map<number, { canvas: HTMLCanvasElement; vp: { convertToViewportRectangle: (r: number[]) => number[] } }>();
  const out: Record<string, string> = {};
  for (const { name, run } of fonts) {
    let p = pages.get(run.pageIndex);
    if (!p) {
      const page = await pdf.getPage(run.pageIndex + 1);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvas, viewport: vp }).promise;
      p = { canvas, vp };
      pages.set(run.pageIndex, p);
    }
    const [a, b, c, d] = p.vp.convertToViewportRectangle([run.bbox.x0, run.bbox.y0, run.bbox.x1, run.bbox.y1]) as [number, number, number, number];
    const x = Math.max(0, Math.min(a, c) - 2);
    const y = Math.max(0, Math.min(b, d) - 2);
    const w = Math.min(Math.abs(c - a) + 4, 360);
    const h = Math.abs(d - b) + 4;
    const crop = document.createElement('canvas');
    crop.width = w;
    crop.height = h;
    crop.getContext('2d')!.drawImage(p.canvas, x, y, w, h, 0, 0, w, h);
    out[name] = crop.toDataURL('image/png');
  }
  return out;
}

type FontChoice = { fontFamily?: string; fontSize?: number };

/** Font and size for new text (the store's `newText`), or for `value`/`onChange` when given; unset fields show `auto` (the size as a placeholder). */
export function FontPicker({ pdf, pages, revision, value, onChange, auto }: { pdf: PdfDoc; pages: PageModel[]; revision: number; value?: FontChoice; onChange?: (s: FontChoice) => void; auto?: { fontFamily: string; fontSize?: number } }) {
  const store = useEditor();
  const newText: FontChoice = value ?? store.newText;
  const setNewText = onChange ?? store.setNewText;
  const [open, setOpen] = useState(false);
  const [imgs, setImgs] = useState<Record<string, string>>({});
  const fonts = useMemo(() => {
    const seen = new Map<string, TextRun>();
    for (const p of pages) for (const b of p.textBoxes) for (const r of b.runs) if (r.decodable && r.text.trim().length > 1 && !seen.has(r.fontName)) seen.set(r.fontName, r);
    return [...seen].map(([name, run]) => ({ name, run }));
  }, [pages]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    samples(pdf, fonts).then((s) => alive && setImgs(s), () => undefined);
    return () => {
      alive = false;
    };
  }, [open, pdf, fonts, revision]);

  return (
    <div className="relative flex items-center gap-1" data-testid="font-picker">
      <button className="max-w-48 truncate rounded border border-slate-300 px-2 py-1 text-left" onClick={() => setOpen(!open)} title="Font for new text">
        {newText.fontFamily ?? auto?.fontFamily} ▾
      </button>
      <input
        type="number"
        min={4}
        max={200}
        value={newText.fontSize ?? ''}
        placeholder={auto && (auto.fontSize ? String(Math.round(auto.fontSize * 10) / 10) : 'auto')}
        onChange={(e) => setNewText({ fontSize: e.target.value === '' && auto ? undefined : Math.max(4, Number(e.target.value) || 12) })}
        className="w-14 rounded border border-slate-300 px-1 py-1"
        title="Font size (pt)"
      />
      {open && (
        <div className="absolute top-full left-0 z-30 mt-1 max-h-96 w-96 overflow-y-auto rounded border border-slate-300 bg-white p-1 shadow-lg">
          {fonts.length > 0 && <div className="px-2 py-1 text-[11px] font-medium text-slate-500 uppercase">Used in this PDF (original glyphs when they cover the text)</div>}
          {fonts.map((f) => (
            <button
              key={f.name}
              className={`block w-full rounded px-2 py-1 text-left hover:bg-sky-50 ${newText.fontFamily === f.name ? 'bg-sky-100' : ''}`}
              onClick={() => (setNewText({ fontFamily: f.name, fontSize: Math.round(f.run.fontSize * Math.hypot(f.run.matrix[2], f.run.matrix[3]) * 10) / 10 }), setOpen(false))}
            >
              <div className="text-xs text-slate-600">
                {f.name} · {f.run.fontSize.toFixed(1)}pt
              </div>
              {imgs[f.name] ? <img src={imgs[f.name]} alt={f.run.text} className="h-6 max-w-full object-contain object-left" /> : <div className="h-6 animate-pulse rounded bg-slate-100" />}
            </button>
          ))}
          <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-slate-500 uppercase">Standard (embedded from the font folder)</div>
          {GENERIC.map((g) => (
            <button key={g.name} className={`block w-full rounded px-2 py-1 text-left hover:bg-sky-50 ${newText.fontFamily === g.name ? 'bg-sky-100' : ''}`} onClick={() => (setNewText({ fontFamily: g.name }), setOpen(false))}>
              <div className="text-xs text-slate-600">{g.name}</div>
              <div style={{ fontFamily: g.css, fontSize: 16 }}>The quick brown fox 123</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
