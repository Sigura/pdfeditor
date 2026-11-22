import { useEffect, useRef, useState, type DragEvent } from 'react';
import * as pdfjs from 'pdfjs-dist';
import { apiError, downloadBlob } from '../lib/api.ts';
import { askPassword } from '../lib/Dialogs.tsx';
import { Thumbnail } from './Thumbnail.tsx';
import { BLANK, toSegments, useMergeStore } from './store.ts';

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
  const { files, pages, busy, error, addFile, movePage, removePage, rotatePage, insertBlank, removeFile, clear, setBusy, setError } = useMergeStore();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileIds = Object.keys(files);
  const hasPages = pages.some((p) => p.fileId !== BLANK);

  const addFiles = async (list: FileList | File[]) => {
    setError(null);
    for (const f of Array.from(list)) {
      if (!f.name.toLowerCase().endsWith('.pdf') && f.type !== 'application/pdf') {
        setError(`${f.name}: not a PDF`);
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

  const merge = async (then: (blob: Blob) => void) => {
    setBusy(true);
    setError(null);
    try {
      const used = fileIds.filter((id) => pages.some((p) => p.fileId === id));
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
      onDragLeave={() => setDropActive(false)}
      onDrop={onFileDrop}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
        <button className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white" onClick={() => inputRef.current?.click()}>
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
          className="rounded bg-emerald-600 px-3 py-1.5 text-sm text-white disabled:opacity-40"
          disabled={!hasPages || busy}
          onClick={() => void merge((b) => downloadBlob(b, 'merged.pdf'))}
        >
          {busy ? 'Merging…' : `Merge & download (${pages.length} pages)`}
        </button>
        <button
          data-testid="merge-edit"
          className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white disabled:opacity-40"
          title="Merge, then open the result in the editor"
          disabled={!hasPages || busy}
          onClick={() => void merge((b) => onEdit(new File([b], 'merged.pdf', { type: 'application/pdf' })))}
        >
          Edit result
        </button>
        <button className="rounded px-3 py-1.5 text-sm hover:bg-slate-100" onClick={clear} disabled={busy}>
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
      {error && <div className="bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
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
                  className={`group relative cursor-grab rounded p-1 ${overIndex === i && dragIndex !== i ? 'ring-2 ring-sky-500' : ''} ${dragIndex === i ? 'opacity-40' : ''}`}
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
                    <button title="Remove page" aria-label="Remove page" className="h-6 w-6 rounded-full bg-white/90 text-sm shadow hover:text-red-600" onClick={() => removePage(p.key)}>
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
