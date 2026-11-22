import { create } from 'zustand';
import { releasePdfDocs } from './Thumbnail.tsx';

/** `labels`: the file's page labels (/PageLabels) by page index, if it has any. */
export type SourceFile = { id: string; name: string; bytes: Uint8Array; pageCount: number; password?: string; labels?: string[] | null };
/**
 * A page of a source file, or a blank page (`fileId` BLANK). `rotate`: degrees added to the page's rotation.
 * `copyOf`: the key of the page it duplicates, so the server can share that page's content.
 */
export type PageItem = { key: string; fileId: string; pageIndex: number; rotate: number; copyOf?: string };
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
  /** Turns the page by `by` degrees, clockwise (default 90; -90 turns it back). */
  rotatePage: (key: string, by?: number) => void;
  /** Adds a blank page after position `index` (-1: first). */
  insertBlank: (index: number) => void;
  /** Repeats the page right after itself. */
  duplicatePage: (key: string) => void;
  /** Files handed over from another tab (the editor's "Arrange pages"), added when this tab mounts. */
  incoming: File[];
  setIncoming: (files: File[]) => void;
  removeFile: (fileId: string) => void;
  /** States before each change to the files or pages, newest last. */
  undoStack: { files: Record<string, SourceFile>; pages: PageItem[] }[];
  undo: () => void;
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
      undoStack: pushUndo(s),
    })),
  movePage: (from, to) =>
    set((s) => {
      const pages = s.pages.slice();
      const [item] = pages.splice(from, 1);
      if (!item || from === to) return s;
      pages.splice(to, 0, item);
      return { pages, undoStack: pushUndo(s) };
    }),
  removePage: (key) => set((s) => ({ pages: s.pages.filter((p) => p.key !== key), undoStack: pushUndo(s) })),
  rotatePage: (key, by = 90) => set((s) => ({ pages: s.pages.map((p) => (p.key === key ? { ...p, rotate: (((p.rotate + by) % 360) + 360) % 360 } : p)), undoStack: pushUndo(s) })),
  insertBlank: (index) =>
    set((s) => {
      const pages = s.pages.slice();
      pages.splice(index + 1, 0, { key: `blank:${++blankId}`, fileId: BLANK, pageIndex: -1, rotate: 0 });
      return { pages, undoStack: pushUndo(s) };
    }),
  duplicatePage: (key) =>
    set((s) => {
      const i = s.pages.findIndex((p) => p.key === key);
      if (i < 0) return s;
      const pages = s.pages.slice();
      const src = pages[i]!;
      pages.splice(i + 1, 0, { ...src, key: `${key}+${++blankId}`, copyOf: src.copyOf ?? key });
      return { pages, undoStack: pushUndo(s) };
    }),
  removeFile: (fileId) => {
    releasePdfDocs([fileId]);
    set((s) => {
      const files = { ...s.files };
      delete files[fileId];
      return { files, pages: s.pages.filter((p) => p.fileId !== fileId), undoStack: pushUndo(s) };
    });
  },
  undoStack: [],
  undo: () =>
    set((s) => {
      const last = s.undoStack.at(-1);
      return last ? { ...last, undoStack: s.undoStack.slice(0, -1) } : s;
    }),
  clear: () => {
    releasePdfDocs();
    set({ files: {}, pages: [], error: null, undoStack: [] });
  },
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
}));

const pushUndo = (s: MergeState) => [...s.undoStack.slice(-49), { files: s.files, pages: s.pages }];

export type Segment = { file: number; pages: string; rotate?: number } | { blank: true } | { copy: number };

/**
 * Collapses the page order into per-file runs ("1-3") so the server copies each run in one go. A duplicate
 * whose source comes earlier with the same rotation becomes {copy: position}, sharing its content.
 */
export function toSegments(pages: PageItem[], fileOrder: string[]): Segment[] {
  const segments: Segment[] = [];
  let run: { fileId: string; start: number; end: number; rotate: number } | null = null;
  const flush = () => {
    if (!run) return;
    const n = (i: number) => i + 1;
    segments.push({ file: fileOrder.indexOf(run.fileId), pages: run.start === run.end ? `${n(run.start)}` : `${n(run.start)}-${n(run.end)}`, ...(run.rotate && { rotate: run.rotate }) });
    run = null;
  };
  for (const [i, p] of pages.entries()) {
    const src = p.copyOf === undefined ? -1 : pages.findIndex((q) => q.key === p.copyOf);
    if (src >= 0 && src < i && pages[src]!.rotate === p.rotate) {
      flush();
      segments.push({ copy: src });
      continue;
    }
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
