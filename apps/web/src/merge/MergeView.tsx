import { useEffect, useRef, useState, type DragEvent } from 'react';
import * as pdfjs from 'pdfjs-dist';
import { apiError, downloadBlob, serverLimits } from '../lib/api.ts';
import { askConfirm, askPassword, modalOpen } from '../lib/Dialogs.tsx';
import { Thumbnail } from './Thumbnail.tsx';
import { BLANK, toSegments, useMergeStore } from './store.ts';

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

const COLORS = ['bg-sky-500', 'bg-amber-500', 'bg-emerald-500', 'bg-rose-500', 'bg-violet-500', 'bg-lime-500'];

async function countPages(bytes: Uint8Array, name: string): Promise<{ pageCount: number; password?: string }> {
  let password: string | undefined;
  for (;;) {
    try {
      const doc = await pdfjs.getDocument({ data: bytes.slice(), password, isEvalSupported: false }).promise;
      const pageCount = doc.numPages;
      await doc.destroy();
      return { pageCount, password };
    } catch (e) {
      if (e instanceof Error && e.name === 'PasswordException') {
        const pw = await askPassword(password === undefined ? `${name} is password-protected.` : `Wrong password for ${name}. Try again.`);
        if (pw === null) throw new Error(`${name}: password required`);
        password = pw;
        continue;
      }
      throw new Error(`${name}: not a readable PDF`);
    }
  }
}

export function MergeView({ onEdit }: { onEdit: (file: File) => void }) {
  const { files, pages, busy, error, addFile, movePage, removePage, rotatePage, insertBlank, duplicatePage, removeFile, undoStack, undo, clear, setBusy, setError } = useMergeStore();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileIds = Object.keys(files);
  const hasPages = pages.some((p) => p.fileId !== BLANK);

  const addFiles = async (list: FileList | File[]) => {
    setError(null);
    // Copy before the first await: the input's FileList empties when its value is reset.
    const picked = Array.from(list);
    const limits = await serverLimits().catch(() => null);
    for (const f of picked) {
      if (!f.name.toLowerCase().endsWith('.pdf') && f.type !== 'application/pdf') {
        setError(`${f.name}: not a PDF`);
        continue;
      }
      if (limits && f.size > limits.maxFileBytes) {
        setError(`${f.name} is ${mb(f.size)} MB; files can be at most ${mb(limits.maxFileBytes)} MB.`);
        continue;
      }
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const { pageCount, password } = await countPages(bytes, f.name);
        addFile({ id: crypto.randomUUID(), name: f.name, bytes, pageCount, password });
      } catch (e) {
        setError((e as Error).message);
      }
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey || modalOpen() || t.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      useMergeStore.getState().undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    // Read from the store, not the render: StrictMode runs the effect twice with the same render.
    const list = useMergeStore.getState().incoming;
    if (!list.length) return;
    useMergeStore.getState().setIncoming([]);
    void addFiles(list);
  }, []);

  const onFileDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
  };

  const firstFile = files[pages.find((p) => p.fileId !== BLANK)?.fileId ?? ''];
  const outName = `${(firstFile?.name ?? 'document').replace(/\.pdf$/i, '')}-merged.pdf`;

  const merge = async (then: (blob: Blob) => void) => {
    setBusy(true);
    setError(null);
    try {
      const used = fileIds.filter((id) => pages.some((p) => p.fileId === id));
      const limits = await serverLimits();
      if (used.length > limits.maxFiles) throw new Error(`The pages come from ${used.length} files; one merge takes at most ${limits.maxFiles}. Merge in parts, then merge the results.`);
      const form = new FormData();
      for (const id of used) {
        const f = files[id]!;
        form.append('files', new Blob([f.bytes.slice()], { type: 'application/pdf' }), f.name);
      }
      form.append('segments', JSON.stringify(toSegments(pages, used)));
      form.append('passwords', JSON.stringify(used.map((id) => files[id]!.password ?? '')));
      const res = await fetch('/api/merge', { method: 'POST', body: form });
      if (!res.ok) throw await apiError(res);
      then(await res.blob());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropActive(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDropActive(false)}
      onDrop={onFileDrop}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
        <button className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" onClick={() => inputRef.current?.click()}>
          Add PDFs
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          data-testid="merge-input"
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-700 disabled:opacity-40"
          disabled={!hasPages || busy}
          onClick={() => void merge((b) => downloadBlob(b, outName))}
        >
          {busy ? 'Merging…' : `Merge & download (${pages.length} pages)`}
        </button>
        <button
          data-testid="merge-edit"
          className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-40"
          title="Merge, then open the result in the editor"
          disabled={!hasPages || busy}
          onClick={() => void merge((b) => onEdit(new File([b], outName, { type: 'application/pdf' })))}
        >
          Edit result
        </button>
        <button
          data-testid="merge-undo"
          className="rounded px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-40"
          title="Undo the last change to the pages or files (Ctrl+Z)"
          disabled={busy || !undoStack.length}
          onClick={undo}
        >
          Undo
        </button>
        <button
          data-testid="merge-clear"
          className="rounded px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-40"
          disabled={busy || !pages.length}
          onClick={() => void askConfirm(`Clear the list? ${pages.length === 1 ? 'The page is' : `All ${pages.length} pages are`} removed, with their files.`, 'Clear').then((yes) => yes && clear())}
        >
          Clear
        </button>
        <div className="ml-auto flex flex-wrap gap-2">
          {fileIds.map((id, i) => (
            <span key={id} className="flex items-center gap-1 rounded bg-slate-100 px-2 py-1 text-xs">
              <span className={`h-2 w-2 rounded-full ${COLORS[i % COLORS.length]}`} />
              {files[id]!.name}
              <button className="ml-1 text-slate-500 hover:text-red-600" title="Remove file" onClick={() => removeFile(id)}>
                ×
              </button>
            </span>
          ))}
        </div>
      </div>
      {error && (
        <div data-testid="merge-error" role="alert" className="flex items-start gap-2 bg-red-50 px-4 py-2 text-sm text-red-700">
          <span className="flex-1">{error}</span>
          <button aria-label="Dismiss" title="Dismiss" className="rounded px-1 leading-5 hover:bg-red-100" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
      <div className={`min-h-0 flex-1 overflow-auto p-6 ${dropActive ? 'bg-sky-50 outline-2 outline-dashed outline-sky-400' : ''}`}>
        {pages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-slate-500">Drop PDF files here or click “Add PDFs”. Then reorder, rotate, delete or insert blank pages.</div>
        ) : (
          <ol className="flex flex-wrap gap-5">
            {pages.map((p, i) => {
              const file = files[p.fileId];
              const color = file ? COLORS[fileIds.indexOf(p.fileId) % COLORS.length] : 'bg-slate-300';
              return (
                <li
                  key={p.key}
                  draggable
                  tabIndex={0}
                  data-key={p.key}
                  aria-label={`${file ? `${file.name} page ${p.pageIndex + 1}` : 'Blank page'}, position ${i + 1} of ${pages.length}. Alt+arrows move it, Delete removes it`}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    const step = e.altKey ? { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key] : undefined;
                    if (step) {
                      e.preventDefault();
                      const to = i + step;
                      if (to < 0 || to >= pages.length) return;
                      movePage(i, to);
                      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-key="${CSS.escape(p.key)}"]`)?.focus());
                    } else if (e.key === 'Delete') {
                      e.preventDefault();
                      removePage(p.key);
                    }
                  }}
                  data-testid="merge-page"
                  onDragStart={(e) => {
                    setDragIndex(i);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', p.key);
                  }}
                  onDragOver={(e) => {
                    if (dragIndex === null) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setOverIndex(i);
                  }}
                  onDrop={(e) => {
                    if (dragIndex === null) return;
                    e.preventDefault();
                    e.stopPropagation();
                    movePage(dragIndex, i);
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                  className={`group relative cursor-grab rounded p-1 focus-visible:outline-2 focus-visible:outline-sky-500 ${overIndex === i && dragIndex !== i ? 'ring-2 ring-sky-500' : ''} ${dragIndex === i ? 'opacity-40' : ''}`}
                >
                  {file ? (
                    <Thumbnail file={file} pageIndex={p.pageIndex} rotate={p.rotate} />
                  ) : (
                    <div data-testid="blank-page" className="flex h-[198px] w-[140px] items-center justify-center bg-white text-xs text-slate-400 shadow">
                      Blank page
                    </div>
                  )}
                  <div className="mt-1 flex items-center gap-1 text-xs text-slate-600">
                    <span className={`h-2 w-2 rounded-full ${color}`} />
                    <span className="max-w-[110px] truncate">{file ? file.name : 'Blank'}</span>
                    {file && <span className="ml-auto">p.{p.pageIndex + 1}</span>}
                  </div>
                  <div className="absolute top-2 right-2 hidden gap-1 group-hover:flex group-focus-within:flex">
                    {file && (
                      <button data-testid="page-rotate" title="Rotate 90° clockwise" aria-label="Rotate page" className="h-6 w-6 rounded-full bg-white/90 text-sm shadow hover:text-sky-600" onClick={() => rotatePage(p.key)}>
                        ↻
                      </button>
                    )}
                    <button data-testid="page-blank" title="Insert a blank page after this one" aria-label="Insert blank page after" className="h-6 w-6 rounded-full bg-white/90 text-sm shadow hover:text-sky-600" onClick={() => insertBlank(i)}>
                      +
                    </button>
                    <button data-testid="page-duplicate" title="Duplicate this page after it" aria-label="Duplicate page" className="h-6 w-6 rounded-full bg-white/90 text-sm shadow hover:text-sky-600" onClick={() => duplicatePage(p.key)}>
                      ⧉
                    </button>
                    <button data-testid="page-delete" title="Delete page (Ctrl+Z brings it back)" aria-label="Delete page" className="h-6 w-6 rounded-full bg-white/90 text-sm shadow hover:text-red-600" onClick={() => removePage(p.key)}>
                      ×
                    </button>
                  </div>
                  {p.rotate > 0 && <span className="absolute top-2 left-2 rounded bg-sky-600 px-1 text-[10px] text-white">↻ {p.rotate}°</span>}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
