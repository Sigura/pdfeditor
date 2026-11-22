import { useEffect, useRef, useState } from 'react';
import type { DocumentInfo, EditOperation } from '@pdf-toolkit/shared';
import { apiError, downloadBlob } from '../lib/api.ts';
import { askConfirm, askPassword, modalOpen, useModalFocus } from '../lib/Dialogs.tsx';
import { openPdf, renderThumbnail, type PdfDoc } from '../lib/pdfjs.ts';
import { opPage } from './Changes.tsx';
import { FontPicker } from './FontPicker.tsx';
import { Inspector } from './Inspector.tsx';
import { PageView } from './PageView.tsx';
import { arrangement, hasUnsaved, pageNo, pageOrder, track, useEditor } from './store.ts';
import { StraightenBar, TiltBanner } from './Deskew.tsx';

/** `content` identifies what the page shows: the thumbnail is rendered again only when it changes. */
function Thumb({ pdf, index, no, rotate, content, active, changes, onClick }: { pdf: PdfDoc; index: number; no: number; rotate: number; content: string; active: boolean; changes: number; onClick: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const shownContent = useRef<string>(undefined);
  const url = useRef<string>(undefined);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  useEffect(() => {
    if (content === shownContent.current) return;
    let alive = true;
    renderThumbnail(pdf, index + 1, 220).then(
      (u) => {
        if (!alive) return URL.revokeObjectURL(u);
        shownContent.current = content;
        if (url.current) URL.revokeObjectURL(url.current);
        url.current = u;
        setSrc(u);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [pdf, index, content]);
  useEffect(() => () => void (url.current && URL.revokeObjectURL(url.current)), []);
  return (
    <button ref={ref} onClick={onClick} aria-current={active ? 'page' : undefined} className={`relative block w-full rounded p-1 ${active ? 'bg-sky-100 ring-2 ring-sky-500' : 'hover:bg-slate-200'}`}>
      {src ? (
        <img src={src} alt={`Page ${no}`} className="w-full bg-white shadow" style={rotate ? { transform: `rotate(${rotate}deg)${rotate % 180 ? ' scale(0.7)' : ''}` } : undefined} />
      ) : (
        <div className="h-36 animate-pulse bg-slate-200" />
      )}
      <div className="mt-1 text-center text-xs text-slate-600">{no}</div>
      {changes > 0 && (
        <span data-testid="thumb-changes" title={`${changes} change${changes > 1 ? 's' : ''} on this page`} className="absolute top-0 right-0 min-w-4 rounded-full bg-amber-500 px-1 text-[10px] leading-4 text-white">
          {changes}
        </span>
      )}
    </button>
  );
}

const PAGE_DRAG = 'application/x-pdf-toolkit-page';

/**
 * Thumbnails in display order with page tools (drag to reorder, rotate, insert a blank page after,
 * duplicate, delete). Each change is one arrangePages op, so undo takes it back. Pages added by the flow follow
 * the arranged pages and have no tools.
 */
function PageList({ pdf, pdfRevision }: { pdf: PdfDoc; pdfRevision: number }) {
  const st = useEditor();
  // Only from the page models of the revision `pdf` shows, so a thumbnail never renders a stale pdf as new content.
  const contentKeys = useRef<string[]>([]);
  if (pdfRevision === st.revision) contentKeys.current = st.pages.map((p, k) => JSON.stringify([st.docId, p, st.ops.filter((o) => opPage(o, st.pages, st.origPages) === k)]));
  const order = pageOrder(st.ops, st.pages);
  const base = st.pages.filter((p) => !p.added).length;
  const arr = arrangement(st.ops);
  const rotation = (k: number) => arr?.order.find((e) => e.page === k)?.rotate ?? 0;
  const shown = order.filter((k) => k < base);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const commit = (pages: { page: number; rotate: number }[], blanks = arr?.blanks ?? []) =>
    st.edit([{ type: 'arrangePages', order: pages.map(({ page, rotate }) => (rotate ? { page, rotate: rotate as 0 | 90 | 180 | 270 } : { page })), blanks }]);
  const entries = () => shown.map((k) => ({ page: k, rotate: rotation(k) }));
  const rotate = (k: number) => commit(entries().map((e) => (e.page === k ? { ...e, rotate: (e.rotate + 90) % 360 } : e)));
  const remove = (k: number) => commit(entries().filter((e) => e.page !== k));
  const insertBlank = (k: number) => {
    const m = st.pages[k]!;
    const [w, h] = [m.view.x1 - m.view.x0, m.view.y1 - m.view.y0];
    const turned = (m.rotate + rotation(k)) % 180 !== 0;
    const list = entries();
    list.splice(list.findIndex((e) => e.page === k) + 1, 0, { page: base, rotate: 0 });
    void commit(list, [...(arr?.blanks ?? []), turned ? { width: h, height: w } : { width: w, height: h }]);
  };
  const duplicate = (k: number) => {
    const list = entries();
    list.splice(list.findIndex((e) => e.page === k) + 1, 0, { page: base, rotate: rotation(k) });
    const tilt = st.ops.findLast((o) => o.type === 'deskewPage' && o.pageIndex === k);
    const arrange: EditOperation = { type: 'arrangePages', order: list.map(({ page, rotate }) => (rotate ? { page, rotate: rotate as 0 | 90 | 180 | 270 } : { page })), blanks: [...(arr?.blanks ?? []), { copy: k }] };
    void st.edit(tilt?.type === 'deskewPage' ? [arrange, { ...tilt, pageIndex: base }] : [arrange]);
  };
  const move = (from: number, before: number) => {
    const list = entries();
    const item = list.splice(list.findIndex((e) => e.page === from), 1)[0]!;
    const at = list.findIndex((e) => e.page === before);
    list.splice(at < 0 ? list.length : at, 0, item);
    if (list.some((e, i) => e.page !== shown[i])) void commit(list);
  };
  const moveBy = async (k: number, step: number) => {
    const list = entries();
    const i = list.findIndex((e) => e.page === k);
    const j = i + step;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    await commit(list);
    document.querySelector<HTMLElement>(`[data-testid="page-thumb"][data-page="${k}"] > button`)?.focus();
  };
  const tool = 'h-6 w-6 rounded-full bg-white/90 text-sm shadow hover:text-sky-600 disabled:opacity-40';
  return (
    <>
      {order.map((k, i) => {
        const own = k < base;
        return (
          <div
            key={k}
            data-testid="page-thumb"
            data-page={k}
            className={`group relative ${dragOver === k ? 'border-t-4 border-sky-500' : ''}`}
            draggable={own && !st.busy}
            onDragStart={(e) => e.dataTransfer.setData(PAGE_DRAG, String(k))}
            onDragOver={(e) => {
              if (!own || !e.dataTransfer.types.includes(PAGE_DRAG)) return;
              e.preventDefault();
              e.stopPropagation();
              setDragOver(k);
            }}
            onKeyDown={(e) => {
              const step = own && e.altKey && !st.busy ? { ArrowUp: -1, ArrowDown: 1 }[e.key] : undefined;
              if (!step) return;
              e.preventDefault();
              void moveBy(k, step);
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => {
              if (!e.dataTransfer.types.includes(PAGE_DRAG)) return;
              e.preventDefault();
              e.stopPropagation();
              setDragOver(null);
              move(Number(e.dataTransfer.getData(PAGE_DRAG)), k);
            }}
          >
            <Thumb pdf={pdf} index={k} no={i + 1} rotate={rotation(k)} content={contentKeys.current[k] ?? ''} active={k === st.pageIndex} changes={st.ops.filter((o) => opPage(o, st.pages, st.origPages) === k).length} onClick={() => st.setPage(k)} />
            {own && (
              <div className="absolute bottom-6 left-1/2 hidden -translate-x-1/2 gap-1 group-focus-within:flex group-hover:flex">
                <button data-testid="thumb-rotate" className={tool} disabled={st.busy} title="Rotate 90° clockwise" aria-label="Rotate page" onClick={() => rotate(k)}>
                  ↻
                </button>
                <button data-testid="thumb-blank" className={tool} disabled={st.busy} title="Insert a blank page after this one" aria-label="Insert blank page after" onClick={() => insertBlank(k)}>
                  +
                </button>
                <button data-testid="thumb-duplicate" className={tool} disabled={st.busy} title="Duplicate this page after it, as in the original file (its edits are not copied); the copy is edited on its own" aria-label="Duplicate page" onClick={() => duplicate(k)}>
                  ⧉
                </button>
                <button data-testid="thumb-delete" className={`${tool} hover:text-red-600`} disabled={st.busy || shown.length < 2} title="Delete page" aria-label="Delete page" onClick={() => remove(k)}>
                  ×
                </button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * New page (copy header/footer, empty) or Cancel for content pushed past the last page, with the
 * questions that go with it (repeat a cut table's header rows, keep a copied page number);
 * Yes/No on repeating header rows for a table cut onto an existing page; Shrink/Cancel for a column
 * that doesn't fit the page.
 */
function PromptDialog() {
  const { prompt, setPrompt, revert, edit, busy, ops, pages } = useEditor();
  const [repeat, setRepeat] = useState(true);
  const [numbers, setNumbers] = useState<'keep' | 'omit'>('omit');
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, prompt);
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
      ? `Content runs ${prompt.by.toFixed(1)} pt past the bottom of the last page (${pageNo({ ops, pages }, prompt.pageIndex)}). Continue it on a new page?`
      : prompt.kind === 'continuation'
        ? `A table continues on page ${pageNo({ ops, pages }, prompt.pageIndex)}. Repeat header rows on the continued part?`
        : `The new column would make the table exceed the page width by ${prompt.by.toFixed(1)} pt. Shrink the other columns proportionally (text wraps, font size stays) or cancel?`;
  const radio = (name: string, testId: string, label: string, checked: boolean, onChange: () => void) => (
    <label className="mr-3 inline-flex items-center gap-1">
      <input type="radio" name={name} data-testid={testId} checked={checked} onChange={onChange} />
      {label}
    </label>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30" data-testid="prompt">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-text"
        className="max-w-md rounded-lg bg-white p-4 text-sm shadow-xl"
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || busy) return;
          e.stopPropagation();
          choices.find((c) => c.testId === 'prompt-cancel')?.run();
        }}
      >
        <p id="prompt-text" className="mb-3">{text}</p>
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
            <button key={c.testId} data-testid={c.testId} autoFocus={c.primary} className={c.primary ? 'rounded bg-sky-600 px-3 py-1.5 text-white' : 'rounded px-3 py-1.5 hover:bg-slate-100'} disabled={busy} onClick={c.run}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** "Page n / N" in display order; type a number and press Enter to go there. */
function PageJump() {
  const st = useEditor();
  const order = pageOrder(st.ops, st.pages);
  const current = order.indexOf(st.pageIndex) + 1;
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (!invalid) return;
    const t = setTimeout(() => setInvalid(false), 2000);
    return () => clearTimeout(t);
  }, [invalid]);
  const go = () => {
    const n = Number(draft);
    if (Number.isInteger(n) && n >= 1 && n <= order.length) st.setPage(order[n - 1]!);
    else if (draft !== null && draft !== '' && n !== current) setInvalid(true);
    setDraft(null);
  };
  return (
    <label className="ml-4 flex items-center gap-1 text-slate-600">
      Page
      <input
        data-testid="page-jump"
        aria-label="Go to page"
        aria-invalid={invalid || undefined}
        title={invalid ? `No such page: pages are 1–${order.length}` : undefined}
        inputMode="numeric"
        className={`w-10 rounded border px-1 py-0.5 text-center tabular-nums ${invalid ? 'border-red-500 ring-2 ring-red-300' : 'border-slate-300'}`}
        value={draft ?? String(current)}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
        onBlur={go}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') {
            setDraft(null);
            requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
          }
        }}
      />
      <span className="tabular-nums" data-testid="page-count">/ {order.length}</span>
      {invalid && <span role="status" className="text-xs text-red-600">pages 1–{order.length}</span>}
    </label>
  );
}

const SHORTCUTS: [string, string][] = [
  ['V / T / B', 'Select / Add text / Table tool'],
  ['PageDown / PageUp', 'Scroll the page, then go to the next / previous page'],
  ['Home / End', 'First / last page'],
  ['Alt + ↑ / ↓', 'Move the focused thumbnail’s page up / down'],
  ['Ctrl + wheel, Ctrl + = / −', 'Zoom in / out'],
  ['Ctrl + 0', 'Fit page width'],
  ['Ctrl + Z / Ctrl + Shift + Z', 'Undo / redo'],
  ['Ctrl + S', 'Download'],
  ['Enter', 'Edit the selected box or cell'],
  ['Arrows (Shift: 10 pt)', 'Move the selection by 1 pt; in a table, go to the next cell'],
  ['Tab / Shift + Tab', 'Next / previous table cell'],
  ['Delete', 'Remove the selected box or table; clear the selected cell'],
  ['Esc', 'Deselect; back to the Select tool; leave the table setup; close this list'],
  ['Alt while dragging', 'Turn snapping off'],
  ['Violet handle', 'Click to select a whole table (arrows nudge it), drag to move it'],
  ['Ctrl + Enter / Esc', 'Apply / cancel text editing'],
  ['?', 'Show this list'],
];

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, true);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" data-testid="shortcuts" className="w-[30rem] rounded-lg bg-white p-4 text-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center">
          <h2 id="shortcuts-title" className="flex-1 font-semibold">Keyboard shortcuts</h2>
          <button aria-label="Close" autoFocus className="rounded px-2 hover:bg-slate-100" onClick={onClose}>
            ×
          </button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="whitespace-nowrap font-mono text-xs leading-5 text-slate-700">{k}</dt>
              <dd className="text-slate-600">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

const ZOOM_STEP = 1.2;
// defineTable coordinates refer to the original page, which no longer matches the view once things moved.
const isGridLocked = (ops: EditOperation[]) => ops.some((o) => ['moveElement', 'tableInsertRow', 'tableDeleteRow', 'tableInsertCol', 'tableDeleteCol', 'resizeTable'].includes(o.type));
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || !!t.closest('[aria-modal]'));

export function EditorView({ onArrange }: { onArrange: (file: File) => void }) {
  const st = useEditor();
  const [pdf, setPdf] = useState<PdfDoc | null>(null);
  const [pdfRevision, setPdfRevision] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [dropActive, setDropActive] = useState(false);
  const [help, setHelp] = useState(false);

  const shown = useRef<PdfDoc | null>(null);
  useEffect(() => {
    if (!st.docId) return;
    let alive = true;
    const revision = st.revision;
    void (async () => {
      const loaded = await track('Loading the document…', async () => {
        const res = await fetch(`/api/documents/${st.docId}/pdf?rev=${revision}`);
        if (!res.ok) throw await apiError(res);
        return openPdf(new Uint8Array(await res.arrayBuffer()));
      });
      if (!alive) return void loaded.destroy();
      // The shown revision stays usable until the next one replaces it: a render on a destroyed
      // document never settles, and the Table tool may start one right after an edit.
      const old = shown.current;
      shown.current = loaded;
      setPdf(loaded);
      setPdfRevision(revision);
      if (old) void old.destroy();
    })().catch((e: Error) => useEditor.getState().setError(e.message));
    return () => {
      alive = false;
    };
  }, [st.docId, st.revision]);
  useEffect(
    () => () => {
      void shown.current?.destroy();
      shown.current = null;
    },
    [st.docId],
  );

  const open = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') return st.setError(`${file.name}: not a PDF`);
    const cur = useEditor.getState();
    if (hasUnsaved(cur) && !(await askConfirm(`Open ${file.name}? Changes to ${cur.fileName} that you haven't downloaded will be lost.`, 'Open'))) return;
    await upload(file);
  };

  const upload = async (file: File, password?: string): Promise<void> => {
    st.setBusy(true);
    st.setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      if (password) form.append('password', password);
      const res = await track('Uploading and analysing…', () => fetch('/api/documents', { method: 'POST', body: form }));
      if (!res.ok) {
        const err = await apiError(res);
        if (err.code === 'ENCRYPTED' || err.code === 'BAD_PASSWORD') {
          const pw = await askPassword(`${file.name}: ${err.message}`);
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

  const [downloading, setDownloading] = useState(false);
  // Changes still queued or being applied (a pending nudge, an edit's scan measuring) go into the file too.
  const download = async (use: (blob: Blob, name: string) => void, saved: boolean) => {
    setDownloading(true);
    try {
      await track('Preparing the download…', async () => {
        await useEditor.getState().settle();
        const { docId, revision, fileName } = useEditor.getState();
        const res = await fetch(`/api/documents/${docId}/download`);
        if (!res.ok) throw await apiError(res);
        use(await res.blob(), fileName.replace(/\.pdf$/i, '') + (revision ? '-edited.pdf' : '.pdf'));
        if (saved) useEditor.getState().setDownloaded(revision);
      });
    } catch (e) {
      st.setError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };

  const downloadNow = useRef<() => void>(() => {});
  downloadNow.current = () => {
    if (!downloading) void download(downloadBlob, true);
  };

  useEffect(() => {
    // Read from the store, not the render: StrictMode runs the effect twice with the same render.
    const f = useEditor.getState().incoming;
    if (!f) return;
    useEditor.getState().setIncoming(null);
    void open(f);
  }, [st.incoming]);

  const fitWidth = () => {
    const m = useEditor.getState().pages[useEditor.getState().pageIndex];
    const el = sectionRef.current;
    if (!m || !el) return;
    const [w, h] = [m.view.x1 - m.view.x0, m.view.y1 - m.view.y0];
    // p-6 padding on both sides, plus room for a vertical scrollbar.
    st.setZoom((el.clientWidth - 48 - 16) / (m.rotate % 180 ? h : w));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useEditor.getState();
      if (!s.docId || s.prompt) return;
      if (modalOpen()) {
        if (e.key === 'Escape' || e.key === '?') setHelp(false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        // Text still in an open editor isn't applied yet, so it doesn't download; the browser's own save never fits.
        e.preventDefault();
        if (!typing(e.target)) downloadNow.current();
        return;
      }
      if (typing(e.target)) return;
      if (e.ctrlKey || e.metaKey) {
        const zoom = { '=': ZOOM_STEP, '+': ZOOM_STEP, '-': 1 / ZOOM_STEP }[e.key];
        if (zoom) s.setZoom(s.zoom * zoom);
        else if (e.key === '0') fitWidth();
        else return;
        e.preventDefault();
        return;
      }
      if (e.altKey) return;
      const el = sectionRef.current;
      const order = pageOrder(s.ops, s.pages);
      const pos = order.indexOf(s.pageIndex);
      const last = order.length - 1;
      if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        if (!el) return;
        const down = e.key === 'PageDown';
        const canScroll = down ? el.scrollTop + el.clientHeight < el.scrollHeight - 2 : el.scrollTop > 2;
        if (canScroll) el.scrollBy({ top: (down ? 0.9 : -0.9) * el.clientHeight });
        else if (down ? pos < last : pos > 0) {
          s.setPage(order[pos + (down ? 1 : -1)]!);
          requestAnimationFrame(() => (el.scrollTop = down ? 0 : el.scrollHeight));
        }
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        s.setPage(order[e.key === 'Home' ? 0 : last]!);
      } else if (e.key === '?') {
        setHelp(true);
      } else if (e.key === 'Escape') {
        if (s.tool !== 'select' && !s.tableSetup && !s.selectedId && !s.cell) s.setTool('select');
      } else if (!s.tableSetup && !s.editingId && !s.editingCell) {
        const tool = ({ v: 'select', t: 'addText', b: 'table' } as const)[e.key.toLowerCase() as 'v' | 't' | 'b'];
        if (!tool || (tool === 'table' && isGridLocked(s.ops))) return;
        s.setTool(tool);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const s = useEditor.getState();
      s.setZoom(s.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [st.docId]);

  const model = st.pages[st.pageIndex];
  const gridLocked = isGridLocked(st.ops);

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDropActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropActive(false);
        const f = e.dataTransfer.files[0];
        if (f) void open(f);
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 text-sm">
        <button className="rounded border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50 disabled:opacity-40" onClick={() => inputRef.current?.click()} disabled={st.busy}>
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
            if (f) void open(f);
            e.target.value = '';
          }}
        />
        {st.docId && (
          <>
            <span className="max-w-xs truncate font-medium">{st.fileName}</span>
            {hasUnsaved(st) && <span data-testid="unsaved" title="Changes not downloaded yet" aria-label="Changes not downloaded yet" className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />}
            <div className="ml-4 flex items-center gap-1">
              <button className="rounded px-2 py-1 hover:bg-slate-100" onClick={() => st.setZoom(st.zoom / ZOOM_STEP)} title="Zoom out (Ctrl + −)">−</button>
              <span className="w-12 text-center tabular-nums">{Math.round(st.zoom * 100)}%</span>
              <button className="rounded px-2 py-1 hover:bg-slate-100" onClick={() => st.setZoom(st.zoom * ZOOM_STEP)} title="Zoom in (Ctrl + =)">+</button>
              <button className="rounded px-2 py-1 hover:bg-slate-100" onClick={fitWidth} title="Fit page width (Ctrl + 0)" data-testid="fit-width">
                Fit
              </button>
            </div>
            <PageJump />
            <div className="ml-4 flex items-center gap-1" data-testid="tools">
              {(
                [
                  ['select', 'Select', 'Select, move, resize and edit (V)'],
                  ['addText', 'Add text', 'Click on the page to add a text box (T)'],
                  ['table', 'Table', 'Click a detected table or drag a rectangle around one, then align the mesh vertices to the cell corners and Confirm (B)'],
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
              <button className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40" disabled={st.busy || !st.ops.length} onClick={() => void st.undo()} title="Undo (Ctrl + Z)">
                ↶
              </button>
              <button className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40" disabled={st.busy || !st.redoStack.length} onClick={() => void st.redo()} title="Redo (Ctrl + Shift + Z)">
                ↷
              </button>
            </div>
            <button
              data-testid="arrange-pages"
              className="ml-auto rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
              title="Combine with other PDFs: opens a copy of the edited PDF in Merge & Pages, where these edits can no longer be undone. To reorder, rotate, delete or add pages with undo, use the tools on the page thumbnails."
              disabled={downloading}
              onClick={() => void download((b, name) => onArrange(new File([b], name, { type: 'application/pdf' })), false)}
            >
              Open in Merge &amp; Pages
            </button>
            <button className="rounded px-2 py-1 text-slate-600 hover:bg-slate-100" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => setHelp(true)}>
              ?
            </button>
            <button data-testid="download" title="Download the edited PDF (Ctrl + S)" className="rounded bg-sky-600 px-3 py-1.5 text-white hover:bg-sky-700 disabled:opacity-60" disabled={downloading} onClick={() => void download(downloadBlob, true)}>
              Download
            </button>
          </>
        )}
      </div>
      {st.error && (
        <div data-testid="editor-error" role="alert" className="flex items-start gap-2 bg-red-50 px-4 py-2 text-sm text-red-700">
          <span className="flex-1">{st.error}</span>
          <button aria-label="Dismiss" title="Dismiss" className="rounded px-1 leading-5 hover:bg-red-100" onClick={() => st.setError(null)}>
            ×
          </button>
        </div>
      )}
      <TiltBanner />
      <PromptDialog />
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {dropActive && st.docId && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center border-4 border-dashed border-sky-500 bg-sky-50/70 text-lg font-medium text-sky-700">Drop to open this PDF</div>
      )}
      {!st.docId ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <button
            data-testid="editor-dropzone"
            disabled={st.busy}
            onClick={() => inputRef.current?.click()}
            className={`flex h-64 w-full max-w-xl flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-slate-500 ${dropActive ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-slate-300 hover:border-slate-400 hover:bg-slate-50'}`}
          >
            {st.busy ? (
              'Analysing…'
            ) : (
              <>
                <span className="text-base font-medium text-slate-700">Drop a PDF here to edit it</span>
                <span className="text-sm">or click to choose a file</span>
              </>
            )}
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="w-36 shrink-0 space-y-2 overflow-y-auto border-r border-slate-200 bg-slate-50 p-2">
            {pdf && <PageList pdf={pdf} pdfRevision={pdfRevision} />}
          </aside>
          <section ref={sectionRef} data-pdf-revision={pdfRevision} className="min-w-0 flex-1 overflow-auto bg-slate-200 p-6">
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
            {model && arrangement(st.ops)?.order.find((e) => e.page === st.pageIndex)?.rotate ? (
              <div data-testid="page-rotation" className="mx-auto mb-2 w-fit rounded bg-sky-100 px-2 py-0.5 text-xs text-sky-800" title="Shown upright for editing; the downloaded page is rotated">
                ↻ {arrangement(st.ops)!.order.find((e) => e.page === st.pageIndex)!.rotate}° on download
              </div>
            ) : null}
            {model && <StraightenBar model={model} />}
            {pdf && model && <PageView pdf={pdf} model={model} revision={st.revision} />}
          </section>
          <Inspector />
        </div>
      )}
    </div>
  );
}
