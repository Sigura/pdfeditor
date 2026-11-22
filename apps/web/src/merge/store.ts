import { create } from 'zustand';

export type SourceFile = { id: string; name: string; bytes: Uint8Array; pageCount: number; password?: string };
export type PageItem = { key: string; fileId: string; pageIndex: number };

type MergeState = {
  files: Record<string, SourceFile>;
  pages: PageItem[];
  busy: boolean;
  error: string | null;
  addFile: (file: SourceFile) => void;
  movePage: (from: number, to: number) => void;
  removePage: (key: string) => void;
  removeFile: (fileId: string) => void;
  clear: () => void;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
};

export const useMergeStore = create<MergeState>((set) => ({
  files: {},
  pages: [],
  busy: false,
  error: null,
  addFile: (file) =>
    set((s) => ({
      files: { ...s.files, [file.id]: file },
      pages: [...s.pages, ...Array.from({ length: file.pageCount }, (_, i) => ({ key: `${file.id}:${i}`, fileId: file.id, pageIndex: i }))],
    })),
  movePage: (from, to) =>
    set((s) => {
      const pages = s.pages.slice();
      const [item] = pages.splice(from, 1);
      if (!item) return s;
      pages.splice(to, 0, item);
      return { pages };
    }),
  removePage: (key) => set((s) => ({ pages: s.pages.filter((p) => p.key !== key) })),
  removeFile: (fileId) =>
    set((s) => {
      const files = { ...s.files };
      delete files[fileId];
      return { files, pages: s.pages.filter((p) => p.fileId !== fileId) };
    }),
  clear: () => set({ files: {}, pages: [], error: null }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
}));

export type Segment = { file: number; pages: string };

/** Collapses the page order into per-file runs ("1-3") so the server copies each run in one go. */
export function toSegments(pages: PageItem[], fileOrder: string[]): Segment[] {
  const segments: Segment[] = [];
  let run: { fileId: string; start: number; end: number } | null = null;
  const flush = () => {
    if (!run) return;
    const n = (i: number) => i + 1;
    segments.push({ file: fileOrder.indexOf(run.fileId), pages: run.start === run.end ? `${n(run.start)}` : `${n(run.start)}-${n(run.end)}` });
  };
  for (const p of pages) {
    if (run && run.fileId === p.fileId && p.pageIndex === run.end + 1) {
      run.end = p.pageIndex;
      continue;
    }
    flush();
    run = { fileId: p.fileId, start: p.pageIndex, end: p.pageIndex };
  }
  flush();
  return segments;
}
