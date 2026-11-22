import { useEffect, useRef, useState } from 'react';
import type { DocumentInfo, EditOperation } from '@pdf-toolkit/shared';
import { apiError, downloadBlob } from '../lib/api.ts';
import { openPdf, renderThumbnail, type PdfDoc } from '../lib/pdfjs.ts';
import { opPage } from './Changes.tsx';
import { FontPicker } from './FontPicker.tsx';
import { Inspector } from './Inspector.tsx';
import { PageView } from './PageView.tsx';
import { track, useEditor } from './store.ts';

function Thumb({ pdf, index, revision, active, changes, onClick }: { pdf: PdfDoc; index: number; revision: number; active: boolean; changes: number; onClick: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    renderThumbnail(pdf, index + 1, 220).then((u) => alive && setSrc(u), () => undefined);
    return () => {
      alive = false;
    };
  }, [pdf, index, revision]);
  return (
    <button onClick={onClick} className={`relative block w-full rounded p-1 ${active ? 'bg-sky-100 ring-2 ring-sky-500' : 'hover:bg-slate-200'}`}>
      {src ? <img src={src} alt={`Page ${index + 1}`} className="w-full bg-white shadow" /> : <div className="h-36 animate-pulse bg-slate-200" />}
      <div className="mt-1 text-center text-xs text-slate-600">{index + 1}</div>
      {changes > 0 && (
        <span data-testid="thumb-changes" title={`${changes} change${changes > 1 ? 's' : ''} on this page`} className="absolute top-0 right-0 min-w-4 rounded-full bg-amber-500 px-1 text-[10px] leading-4 text-white">
          {changes}
        </span>
      )}
    </button>
  );
}

/**
 * New page (copy header/footer, empty) or Cancel for content pushed past the last page, with the
 * questions that go with it (repeat a cut table's header rows, keep a copied page number);
 * Yes/No on repeating header rows for a table cut onto an existing page; Shrink/Cancel for a column
 * that doesn't fit the page.
 */
function PromptDialog() {
  const { prompt, setPrompt, revert, edit, busy } = useEditor();
  const [repeat, setRepeat] = useState(true);
  const [numbers, setNumbers] = useState<'keep' | 'omit'>('omit');
  useEffect(() => {
    setRepeat(true);
    setNumbers('omit');
  }, [prompt]);
  if (!prompt) return null;
  const continued = (repeatHeader: boolean): EditOperation[] => (prompt.kind === 'colFit' ? [] : prompt.tableIds.map((tableId) => ({ type: 'tableContinuation', tableId, repeatHeader })));
  const newPage = (newPages: 'copy' | 'empty'): EditOperation[] => [{ type: 'setPageFlow', newPages, ...(newPages === 'copy' && prompt.kind === 'newPage' && prompt.pageNumber && { pageNumbers: numbers }) }, ...continued(repeat)];
  const choices: { label: string; testId: string; primary?: boolean; run: () => void }[] =
    prompt.kind === 'newPage'
      ? [
          { label: 'Cancel', testId: 'prompt-cancel', run: () => void revert(prompt.count) },
          { label: 'Empty page (same size)', testId: 'prompt-empty', run: () => (setPrompt(null), void edit(newPage('empty'))) },
          { label: 'Copy header/footer', testId: 'prompt-copy', primary: true, run: () => (setPrompt(null), void edit(newPage('copy'))) },
        ]
      : prompt.kind === 'continuation'
        ? [
            { label: 'No', testId: 'prompt-no', run: () => (setPrompt(null), void edit(continued(false))) },
            { label: 'Yes', testId: 'prompt-yes', primary: true, run: () => (setPrompt(null), void edit(continued(true))) },
          ]
        : [
            { label: 'Cancel', testId: 'prompt-cancel', run: () => setPrompt(null) },
            { label: 'Shrink other columns', testId: 'prompt-shrink', primary: true, run: () => (setPrompt(null), void edit([{ ...prompt.op, fit: 'shrink' }])) },
          ];
  const text =
    prompt.kind === 'newPage'
      ? `Content runs ${prompt.by.toFixed(1)} pt past the bottom of the last page (${prompt.pageIndex + 1}). Continue it on a new page?`
      : prompt.kind === 'continuation'
        ? `A table continues on page ${prompt.pageIndex + 1}. Repeat header rows on the continued part?`
        : `The new column would make the table exceed the page width by ${prompt.by.toFixed(1)} pt. Shrink the other columns proportionally (text wraps, font size stays) or cancel?`;
  const radio = (name: string, testId: string, label: string, checked: boolean, onChange: () => void) => (
    <label className="mr-3 inline-flex items-center gap-1">
      <input type="radio" name={name} data-testid={testId} checked={checked} onChange={onChange} />
      {label}
    </label>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30" data-testid="prompt">
      <div className="max-w-md rounded-lg bg-white p-4 text-sm shadow-xl">
        <p className="mb-3">{text}</p>
        {prompt.kind === 'newPage' && prompt.tableIds.length > 0 && (
          <div className="mb-2">
            <div className="mb-1">Repeat header rows on the continued part?</div>
            {radio('repeat', 'prompt-repeat-yes', 'Yes', repeat, () => setRepeat(true))}
            {radio('repeat', 'prompt-repeat-no', 'No', !repeat, () => setRepeat(false))}
          </div>
        )}
        {prompt.kind === 'newPage' && prompt.pageNumber && (
          <div className="mb-3">
            <div className="mb-1">The copied header/footer has a page number (“{prompt.pageNumber}”):</div>
            {radio('numbers', 'prompt-number-keep', 'Keep verbatim', numbers === 'keep', () => setNumbers('keep'))}
            {radio('numbers', 'prompt-number-omit', 'Leave out', numbers === 'omit', () => setNumbers('omit'))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          {choices.map((c) => (
            <button key={c.testId} data-testid={c.testId} className={c.primary ? 'rounded bg-sky-600 px-3 py-1.5 text-white' : 'rounded px-3 py-1.5 hover:bg-slate-100'} disabled={busy} onClick={c.run}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const PROGRESS_AFTER_MS = 1500;

/** The latest running activity, once something has run for 1.5 s, with the elapsed time. */
function ProgressBanner() {
  const activities = useEditor((s) => s.activities);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!activities.length) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [activities.length]);
  const oldest = activities[0];
  if (!oldest || now - oldest.since < PROGRESS_AFTER_MS) return null;
  const latest = activities.at(-1)!;
  return (
    <div data-testid="progress" role="status" className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
      <span>{latest.label}</span>
      <span className="tabular-nums text-white/60">{((now - oldest.since) / 1000).toFixed(1)} s</span>
    </div>
  );
}

export function EditorView() {
  const st = useEditor();
  const [pdf, setPdf] = useState<PdfDoc | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!st.docId) return;
    let alive = true;
    let loaded: PdfDoc | null = null;
    void (async () => {
      loaded = await track('Loading the document…', async () => {
        const res = await fetch(`/api/documents/${st.docId}/pdf?rev=${st.revision}`);
        if (!res.ok) throw await apiError(res);
        return openPdf(new Uint8Array(await res.arrayBuffer()));
      });
      if (alive) setPdf(loaded);
      else void loaded.destroy();
    })().catch((e: Error) => useEditor.getState().setError(e.message));
    return () => {
      alive = false;
      if (loaded) void loaded.destroy();
    };
  }, [st.docId, st.revision]);

  const upload = async (file: File, password?: string) => {
    st.setBusy(true);
    st.setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      if (password) form.append('password', password);
      const res = await track('Uploading and analysing…', () => fetch('/api/documents', { method: 'POST', body: form }));
      if (!res.ok) {
        const err = await apiError(res);
        if (/\((ENCRYPTED|BAD_PASSWORD)\)/.test(err.message)) {
          const pw = window.prompt(`${file.name}: ${err.message}\nPassword:`);
          if (pw !== null) return upload(file, pw);
        }
        throw err;
      }
      const info = (await res.json()) as DocumentInfo;
      setPdf(null);
      st.setDocument({ docId: info.docId, fileName: info.fileName, pages: info.pages });
    } catch (e) {
      st.setError((e as Error).message);
    } finally {
      st.setBusy(false);
    }
  };

  const download = async () => {
    const res = await fetch(`/api/documents/${st.docId}/download`);
    if (!res.ok) return st.setError((await apiError(res)).message);
    downloadBlob(await res.blob(), st.fileName.replace(/\.pdf$/i, '') + (st.revision ? '-edited.pdf' : '.pdf'));
  };

  const model = st.pages[st.pageIndex];
  // defineTable coordinates refer to the original page, which no longer matches the view once things moved.
  const gridLocked = st.ops.some((o) => ['moveElement', 'tableInsertRow', 'tableDeleteRow', 'tableInsertCol', 'tableDeleteCol', 'resizeTable'].includes(o.type));

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 text-sm">
        <button className="rounded bg-slate-900 px-3 py-1.5 text-white" onClick={() => inputRef.current?.click()} disabled={st.busy}>
          Open PDF
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          data-testid="editor-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
        />
        {st.docId && (
          <>
            <span className="max-w-xs truncate font-medium">{st.fileName}</span>
            <div className="ml-4 flex items-center gap-1">
              <button className="rounded px-2 py-1 hover:bg-slate-100" onClick={() => st.setZoom(st.zoom / 1.2)} title="Zoom out">−</button>
              <span className="w-12 text-center tabular-nums">{Math.round(st.zoom * 100)}%</span>
              <button className="rounded px-2 py-1 hover:bg-slate-100" onClick={() => st.setZoom(st.zoom * 1.2)} title="Zoom in">+</button>
            </div>
            <div className="ml-4 flex items-center gap-1" data-testid="tools">
              {(
                [
                  ['select', 'Select', 'Select, move, resize and edit (Delete removes the selection)'],
                  ['addText', 'Add text', 'Click on the page to add a text box'],
                  ['table', 'Table', 'Click a detected table or drag a rectangle around one, then align the mesh vertices to the cell corners and Confirm'],
                ] as const
              ).map(([t, label, title]) => (
                <button
                  key={t}
                  title={t === 'table' && gridLocked ? 'Tables are set up on the original layout: undo moves and row/column changes first' : title}
                  disabled={t === 'table' && gridLocked}
                  className={`rounded px-2 py-1 disabled:opacity-40 ${st.tool === t ? 'bg-sky-600 text-white' : 'hover:bg-slate-100'}`}
                  onClick={() => st.setTool(t)}
                >
                  {label}
                </button>
              ))}
              {st.tool === 'addText' && pdf && <FontPicker pdf={pdf} pages={st.pages} revision={st.revision} />}
            </div>
            <div className="ml-2 flex items-center gap-1">
              <button className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40" disabled={st.busy || !st.ops.length} onClick={() => void st.undo()} title="Undo (Ctrl+Z)">
                ↶
              </button>
              <button className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40" disabled={st.busy || !st.redoStack.length} onClick={() => void st.redo()} title="Redo (Ctrl+Shift+Z)">
                ↷
              </button>
            </div>
            <button className="ml-auto rounded bg-emerald-600 px-3 py-1.5 text-white" onClick={() => void download()}>
              Download
            </button>
          </>
        )}
      </div>
      {st.error && <div data-testid="editor-error" className="bg-red-50 px-4 py-2 text-sm text-red-700">{st.error}</div>}
      <PromptDialog />
      <ProgressBanner />
      {!st.docId ? (
        <div className="flex flex-1 items-center justify-center text-slate-500">{st.busy ? 'Analyzing…' : 'Open a PDF to edit it.'}</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="w-36 shrink-0 space-y-2 overflow-y-auto border-r border-slate-200 bg-slate-50 p-2">
            {pdf &&
              st.pages.map((_, i) => (
                <Thumb key={i} pdf={pdf} index={i} revision={st.revision} active={i === st.pageIndex} changes={st.ops.filter((o) => opPage(o, st.pages, st.origPages) === i).length} onClick={() => st.setPage(i)} />
              ))}
          </aside>
          <section className="min-w-0 flex-1 overflow-auto bg-slate-200 p-6">
            {st.warnings.length > 0 && (
              <ul className="mx-auto mb-3 max-w-3xl rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {st.warnings.map((w) => (
                  <li key={w}>⚠ {w}</li>
                ))}
              </ul>
            )}
            {model && model.warnings.length > 0 && (
              <ul className="mx-auto mb-3 max-w-3xl rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {model.warnings.map((w) => (
                  <li key={w}>⚠ {w}</li>
                ))}
              </ul>
            )}
            {pdf && model && <PageView pdf={pdf} model={model} revision={st.revision} />}
          </section>
          <Inspector />
        </div>
      )}
    </div>
  );
}
