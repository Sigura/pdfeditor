import { useEffect, useState } from 'react';
import type { Color, EditOperation, PageModel } from '@pdf-toolkit/shared';
import { apiError } from '../lib/api.ts';
import { openPdf } from '../lib/pdfjs.ts';
import { renderRegion } from './background.ts';
import { opPage } from './Changes.tsx';
import { detectSkew, scanLayout } from './rasterGrid.ts';
import { pageNo, track, useEditor } from './store.ts';

type Tilt = { angle: number; paper: Color };
const TILT_PX_PER_PT = 1.5;
/** Tilts the banner offers to straighten; smaller ones are left alone. */
export const TILT_MIN = 0.3;

/** Measured per document on the uploaded file, so a straightened page is measured afresh. */
const measured = new Map<string, Promise<Map<number, Tilt>>>();

export const isScan = (m: PageModel) => !m.editable && !m.added;

/** The angle that straightens each scanned page and its paper colour, measured once per document. */
export function measureTilts(docId: string, pages: PageModel[]): Promise<Map<number, Tilt>> {
  let p = measured.get(docId);
  if (!p) {
    const scans = pages.filter(isScan);
    p = track('Checking scanned pages for tilt…', async (step) => {
      const res = await fetch(`/api/documents/${docId}/pdf?original=raw`);
      if (!res.ok) throw await apiError(res);
      const pdf = await openPdf(new Uint8Array(await res.arrayBuffer()));
      try {
        const out = new Map<number, Tilt>();
        for (const [i, m] of scans.entries()) {
          step(`Checking scanned pages for tilt ${i + 1}/${scans.length}…`);
          const region = await renderRegion(pdf, m.pageIndex, m.view, TILT_PX_PER_PT);
          const angle = detectSkew(region.img);
          const paper = scanLayout(region, TILT_PX_PER_PT)?.paper;
          if (angle !== null && paper) out.set(m.pageIndex, { angle, paper });
        }
        return out;
      } finally {
        void pdf.destroy();
      }
    });
    measured.set(docId, p);
    p.catch(() => measured.delete(docId));
  }
  return p;
}

const PAGE_LEVEL: EditOperation['type'][] = ['deskewPage', 'scanLayout', 'setPageFlow', 'tableContinuation', 'arrangePages'];

/** Whether page `k` has edits other than its straightening; those are in the current page coordinates, so straightening waits for them to go. */
export function hasPageEdits(ops: EditOperation[], pages: PageModel[], origPages: PageModel[], k: number): boolean {
  return ops.some((op) => !PAGE_LEVEL.includes(op.type) && opPage(op, pages, origPages) === k);
}

export const deskewOf = (ops: EditOperation[], k: number) => ops.findLast((o): o is Extract<EditOperation, { type: 'deskewPage' }> => o.type === 'deskewPage' && o.pageIndex === k);

/** Straighten control above a scanned page: detect and apply, then fine-tune the angle in 0.1° steps or reset. */
export function StraightenBar({ model }: { model: PageModel }) {
  const st = useEditor();
  const k = model.pageIndex;
  const current = deskewOf(st.ops, k);
  const blocked = hasPageEdits(st.ops, st.pages, st.origPages, k);
  const [draft, setDraft] = useState<string | null>(null);
  const [straight, setStraight] = useState<number | null>(null);
  if (!isScan(model) || !st.docId) return null;
  const docId = st.docId;
  const apply = async (angle: number | 'detect') => {
    setStraight(null);
    try {
      const tilt = (await measureTilts(docId, st.origPages)).get(k);
      if (!tilt) return st.setError(`Page ${pageNo(st, k)}: no ink found to measure its tilt`);
      if (angle === 'detect' && Math.abs(tilt.angle - (current?.angle ?? 0)) < 0.05) return setStraight(k);
      const a = angle === 'detect' ? tilt.angle : Math.max(-15, Math.min(15, Math.round(angle * 100) / 100));
      await st.deskew([{ type: 'deskewPage', pageIndex: k, angle: a, paper: current?.paper ?? tilt.paper }]);
    } catch (e) {
      st.setError((e as Error).message);
    }
  };
  const angle = current?.angle ?? 0;
  const btn = 'rounded px-1.5 py-0.5 hover:bg-sky-200 disabled:opacity-40';
  return (
    <div
      data-testid="straighten"
      className="mx-auto mb-2 flex w-fit items-center gap-1 rounded bg-sky-100 px-2 py-0.5 text-xs text-sky-800"
      title={blocked ? 'Straighten before editing this page: undo its changes first' : 'Rotate the scan so its lines are level (the image itself is not resampled)'}
    >
      <button data-testid="straighten-detect" className={btn} disabled={blocked || st.busy} onClick={() => void apply('detect')}>
        ⟲ Straighten
      </button>
      {straight === k && <span data-testid="straighten-none">already straight</span>}
      {current && (
        <>
          <button className={btn} disabled={blocked || st.busy} title="Rotate 0.1° clockwise" onClick={() => void apply(angle - 0.1)}>
            −
          </button>
          <input
            data-testid="straighten-angle"
            aria-label="Straightening angle in degrees, counter-clockwise"
            className="w-14 rounded border border-sky-300 bg-white px-1 text-right tabular-nums"
            disabled={blocked || st.busy}
            value={draft ?? angle.toFixed(2)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const v = Number(draft);
              setDraft(null);
              if (draft !== null && Number.isFinite(v)) void apply(v);
            }}
          />
          °
          <button className={btn} disabled={blocked || st.busy} title="Rotate 0.1° counter-clockwise" onClick={() => void apply(angle + 0.1)}>
            +
          </button>
          <button className={btn} disabled={blocked || st.busy || angle === 0} title="Show the page as scanned" onClick={() => void apply(0)}>
            Reset
          </button>
        </>
      )}
    </div>
  );
}

/** After a document opens, offers to straighten every tilted scanned page that has no edits yet. */
export function TiltBanner() {
  const st = useEditor();
  const [tilts, setTilts] = useState<Map<number, Tilt> | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const { docId, origPages } = st;
  useEffect(() => {
    setTilts(null);
    if (!docId || !origPages.some(isScan)) return;
    let alive = true;
    measureTilts(docId, origPages).then(
      (t) => alive && setTilts(t),
      (e: Error) => alive && useEditor.getState().setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [docId, origPages]);
  if (!tilts || !docId || dismissed === docId) return null;
  const todo = [...tilts].filter(([k, t]) => Math.abs(t.angle) >= TILT_MIN && !deskewOf(st.ops, k) && !hasPageEdits(st.ops, st.pages, st.origPages, k));
  if (!todo.length) return null;
  return (
    <div data-testid="tilt-banner" className="flex items-center gap-3 bg-sky-50 px-4 py-2 text-sm text-sky-800">
      <span className="flex-1">
        {todo.length === 1 ? `Scanned page ${pageNo(st, todo[0]![0])} looks tilted` : `${todo.length} scanned pages look tilted`} ({todo.map(([, t]) => `${Math.abs(t.angle).toFixed(1)}°`).slice(0, 5).join(', ')}
        {todo.length > 5 ? ', …' : ''}).
      </span>
      <button
        data-testid="straighten-all"
        className="rounded bg-sky-600 px-2 py-1 text-white disabled:opacity-50"
        disabled={st.busy}
        onClick={() => void st.deskew(todo.map(([pageIndex, t]) => ({ type: 'deskewPage', pageIndex, angle: t.angle, paper: t.paper })))}
      >
        Straighten {todo.length === 1 ? 'it' : 'all'}
      </button>
      <button aria-label="Dismiss" title="Dismiss" className="rounded px-1 leading-5 hover:bg-sky-100" onClick={() => setDismissed(docId)}>
        ×
      </button>
    </div>
  );
}
