import { useEffect, useMemo, useRef, useState } from 'react';
import type { PageModel, TextRun } from '@pdf-toolkit/shared';
import { installedFonts, type InstalledFont } from '../lib/api.ts';
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

/** A sample line in the installed font, drawn by the server as SVG paths (CJK font files are many MB). */
function Sample({ font }: { font: InstalledFont }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className="h-6 text-xs text-slate-400">No preview</div>;
  return <img data-testid="font-sample" src={`/api/fonts/${font.id}/sample.svg`} alt="The quick brown fox 123" loading="lazy" onError={() => setFailed(true)} className="h-6 max-w-full object-contain object-left" />;
}

function LicenseBadge({ font }: { font: InstalledFont }) {
  const { id, free, url } = font.license;
  if (!free)
    return (
      <span data-testid="font-license" className="rounded bg-amber-100 px-1 text-[10px] text-amber-800" title={id === 'unknown' ? 'The font has no licence information: check its terms before sharing the PDF' : 'Not a known free licence: check its terms before sharing the PDF'}>
        ⚠ {id}
      </span>
    );
  return (
    <span data-testid="font-license" className={`rounded px-1 text-[10px] ${id === 'MIT' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`} title={url ?? id}>
      {id}
    </span>
  );
}

/** Fonts the server can embed (font folder, bundled packages, system), grouped by family; restricted-licence faces are disabled. */
function InstalledFonts({ selected, onPick }: { selected?: string; onPick: (postscriptName: string) => void }) {
  const [fonts, setFonts] = useState<InstalledFont[]>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  useEffect(() => {
    installedFonts().then(setFonts, (e: Error) => setError(e.message));
  }, []);
  const families = useMemo(() => {
    const m = new Map<string, InstalledFont[]>();
    const q = query.trim().toLowerCase();
    for (const f of fonts ?? []) if (!q || f.family.toLowerCase().includes(q)) m.set(f.family, [...(m.get(f.family) ?? []), f]);
    return [...m].sort(([a], [b]) => a.localeCompare(b));
  }, [fonts, query]);

  return (
    <div data-testid="installed-fonts">
      <div className="flex items-center gap-2 px-2 pt-2 pb-1">
        <span className="text-[11px] font-medium whitespace-nowrap text-slate-500 uppercase">Installed{fonts && ` (${families.length})`}</span>
        <input data-testid="font-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="min-w-0 flex-1 rounded border border-slate-300 px-1 py-0.5 text-xs" />
      </div>
      {error && <div className="px-2 text-xs text-red-600">{error}</div>}
      {!fonts && !error && <div className="mx-2 h-6 animate-pulse rounded bg-slate-100" />}
      {families.map(([family, faces]) => {
        const sample = faces.find((f) => !f.bold && !f.italic) ?? faces[0]!;
        return (
          <div key={family} className="rounded px-2 py-1 hover:bg-slate-50" data-testid="installed-family" data-family={family}>
            <div className="flex items-center gap-1 text-xs text-slate-600">
              <span className="truncate">{family}</span>
              <LicenseBadge font={sample} />
              <span className="ml-auto text-[10px] text-slate-400">{sample.source}</span>
            </div>
            <Sample font={sample} />
            <div className="mt-0.5 flex flex-wrap gap-1">
              {faces.map((f) => (
                <button
                  key={f.id}
                  data-testid="installed-font"
                  data-ps={f.postscriptName}
                  disabled={!f.embeddable}
                  title={f.embeddable ? f.postscriptName : `${f.postscriptName}: the font's licence does not allow embedding it in a PDF`}
                  onClick={() => onPick(f.postscriptName)}
                  className={`rounded border px-1 text-[11px] disabled:cursor-not-allowed disabled:line-through disabled:opacity-50 ${selected === f.postscriptName ? 'border-sky-400 bg-sky-100' : 'border-slate-200 hover:bg-sky-50'}`}
                >
                  {f.style || f.postscriptName}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

type FontChoice = { fontFamily?: string; fontSize?: number };

/** Font and size for new text (the store's `newText`), or for `value`/`onChange` when given; unset fields show `auto` (the size as a placeholder). */
export function FontPicker({ pdf, pages, revision, value, onChange, auto }: { pdf: PdfDoc; pages: PageModel[]; revision: number; value?: FontChoice; onChange?: (s: FontChoice) => void; auto?: { fontFamily: string; fontSize?: number } }) {
  const store = useEditor();
  const newText: FontChoice = value ?? store.newText;
  const setNewText = onChange ?? store.setNewText;
  const [open, setOpen] = useState(false);
  const [sizeDraft, setSizeDraft] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
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

  // Capture phase, so Esc closes only the menu and doesn't also clear the page selection.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [open]);

  const commitSize = () => {
    if (sizeDraft === undefined) return;
    setSizeDraft(undefined);
    const n = Number(sizeDraft);
    if (sizeDraft.trim() === '') {
      if (auto) setNewText({ fontSize: undefined });
    } else if (Number.isFinite(n) && n > 0) setNewText({ fontSize: Math.min(200, Math.max(4, n)) });
  };

  return (
    <div ref={root} className="relative flex items-center gap-1" data-testid="font-picker">
      <button className="max-w-48 truncate rounded border border-slate-300 px-2 py-1 text-left" onClick={() => setOpen(!open)} title="Font for new text">
        {newText.fontFamily ?? auto?.fontFamily} ▾
      </button>
      <input
        type="number"
        min={4}
        max={200}
        data-testid="font-size"
        value={sizeDraft ?? newText.fontSize ?? ''}
        placeholder={auto && (auto.fontSize ? String(Math.round(auto.fontSize * 10) / 10) : 'auto')}
        onChange={(e) => setSizeDraft(e.target.value)}
        onBlur={commitSize}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitSize();
          else if (e.key === 'Escape') setSizeDraft(undefined);
        }}
        className="w-14 rounded border border-slate-300 px-1 py-1"
        title="Font size (pt)"
      />
      {open && (
        <div className="absolute top-full left-0 z-30 mt-1 max-h-[32rem] w-[28rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded border border-slate-300 bg-white p-1 shadow-lg">
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
          <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-slate-500 uppercase">Standard (a metric-compatible font is embedded)</div>
          {GENERIC.map((g) => (
            <button key={g.name} className={`block w-full rounded px-2 py-1 text-left hover:bg-sky-50 ${newText.fontFamily === g.name ? 'bg-sky-100' : ''}`} onClick={() => (setNewText({ fontFamily: g.name }), setOpen(false))}>
              <div className="text-xs text-slate-600">{g.name}</div>
              <div style={{ fontFamily: g.css, fontSize: 16 }}>The quick brown fox 123</div>
            </button>
          ))}
          <InstalledFonts selected={newText.fontFamily} onPick={(ps) => (setNewText({ fontFamily: ps }), setOpen(false))} />
        </div>
      )}
    </div>
  );
}
