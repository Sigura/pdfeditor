import { create } from 'zustand';

export type SourceFile = { id: string; name: string; bytes: Uint8Array; pageCount: number; password?: string };
/** A page of a source file, or a blank page (`fileId` BLANK). `rotate`: degrees added to the page's rotation. */
export type PageItem = { key: string; fileId: string; pageIndex: number; rotate: number };
export const BLANK = '';
let blankId = 0;

type MergeState = {
  files: Record<string, SourceFile>;
  pages: PageItem[];
  busy: boolean;
  error: string | null;
  addFile: (file: SourceFile) => void;
  movePage: (from: number, to: number) => void;
  removePage: (key: string) => void;
  rotatePage: (key: string) => void;
  /** Adds a blank page after position `index` (-1: first). */
  insertBlank: (index: number) => void;
  /** Repeats the page right after itself. */
  duplicatePage: (key: string) => void;
  /** Files handed over from another tab (the editor's "Arrange pages"), added when this tab mounts. */
  incoming: File[];
  setIncoming: (files: File[]) => void;
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
  incoming: [],
  setIncoming: (incoming) => set({ incoming }),
  addFile: (file) =>
    set((s) => ({
      files: { ...s.files, [file.id]: file },
      pages: [...s.pages, ...Array.from({ length: file.pageCount }, (_, i) => ({ key: `${file.id}:${i}`, fileId: file.id, pageIndex: i, rotate: 0 }))],
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
  rotatePage: (key) => set((s) => ({ pages: s.pages.map((p) => (p.key === key ? { ...p, rotate: (p.rotate + 90) % 360 } : p)) })),
  insertBlank: (index) =>
    set((s) => {
      const pages = s.pages.slice();
      pages.splice(index + 1, 0, { key: `blank:${++blankId}`, fileId: BLANK, pageIndex: -1, rotate: 0 });
      return { pages };
    }),
  duplicatePage: (key) =>
    set((s) => {
      const i = s.pages.findIndex((p) => p.key === key);
      if (i < 0) return s;
      const pages = s.pages.slice();
      pages.splice(i + 1, 0, { ...pages[i]!, key: `${key}+${++blankId}` });
      return { pages };
    }),
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

export type Segment = { file: number; pages: string; rotate?: number } | { blank: true };

/** Collapses the page order into per-file runs ("1-3") so the server copies each run in one go. */
export function toSegments(pages: PageItem[], fileOrder: string[]): Segment[] {
  const segments: Segment[] = [];
  let run: { fileId: string; start: number; end: number; rotate: number } | null = null;
  const flush = () => {
    if (!run) return;
    const n = (i: number) => i + 1;
    segments.push({ file: fileOrder.indexOf(run.fileId), pages: run.start === run.end ? `${n(run.start)}` : `${n(run.start)}-${n(run.end)}`, ...(run.rotate && { rotate: run.rotate }) });
    run = null;
  };
  for (const p of pages) {
    if (p.fileId === BLANK) {
      flush();
      segments.push({ blank: true });
      continue;
    }
    if (run && run.fileId === p.fileId && p.rotate === run.rotate && p.pageIndex === run.end + 1) {
      run.end = p.pageIndex;
      continue;
    }
    flush();
    run = { fileId: p.fileId, start: p.pageIndex, end: p.pageIndex, rotate: p.rotate };
  }
  flush();
  return segments;
}
