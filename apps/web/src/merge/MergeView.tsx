import { useRef, useState, type DragEvent } from 'react';
import * as pdfjs from 'pdfjs-dist';
import { apiError, downloadBlob } from '../lib/api.ts';
import { Thumbnail } from './Thumbnail.tsx';
import { toSegments, useMergeStore } from './store.ts';

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
        const pw = window.prompt(`${name} is password-protected. Password:`);
        if (pw === null) throw new Error(`${name}: password required`);
        password = pw;
        continue;
      }
      throw new Error(`${name}: not a readable PDF`);
    }
  }
}

export function MergeView() {
  const { files, pages, busy, error, addFile, movePage, removePage, removeFile, clear, setBusy, setError } = useMergeStore();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileIds = Object.keys(files);

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

  const onFileDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
  };

  const merge = async () => {
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
      downloadBlob(await res.blob(), 'merged.pdf');
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
          disabled={pages.length === 0 || busy}
          onClick={() => void merge()}
        >
          {busy ? 'Merging…' : `Merge & download (${pages.length} pages)`}
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
          <div className="flex h-full items-center justify-center text-slate-500">Drop PDF files here or click “Add PDFs”.</div>
        ) : (
          <ol className="flex flex-wrap gap-5">
            {pages.map((p, i) => {
              const file = files[p.fileId]!;
              const color = COLORS[fileIds.indexOf(p.fileId) % COLORS.length];
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
                  <Thumbnail file={file} pageIndex={p.pageIndex} />
                  <div className="mt-1 flex items-center gap-1 text-xs text-slate-600">
                    <span className={`h-2 w-2 rounded-full ${color}`} />
                    <span className="max-w-[110px] truncate">{file.name}</span>
                    <span className="ml-auto">p.{p.pageIndex + 1}</span>
                  </div>
                  <button
                    title="Remove page"
                    className="absolute top-2 right-2 hidden h-6 w-6 rounded-full bg-white/90 text-sm shadow group-hover:block hover:text-red-600"
                    onClick={() => removePage(p.key)}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
