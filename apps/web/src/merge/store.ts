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
  /** Keys of the selected pages, in page order; `anchor` is where a Shift+click range starts. */
  selected: string[];
  anchor: string | null;
  /** only: just this page; toggle: add or remove it (Ctrl+click); range: from the anchor to it (Shift+click). */
  selectPage: (key: string, mode: 'only' | 'toggle' | 'range') => void;
  selectAll: () => void;
  clearSelection: () => void;
  removePages: (keys: string[]) => void;
  rotatePages: (keys: string[], by: number) => void;
  /** Moves the pages `keys` as a block, keeping their order, to where the page at `to` is (after it when moving forward). */
  movePages: (keys: string[], to: number) => void;
};

const turn = (rotate: number, by: number) => (((rotate + by) % 360) + 360) % 360;
const inOrder = (pages: PageItem[], keys: Iterable<string>) => {
  const set = new Set(keys);
  return pages.filter((p) => set.has(p.key)).map((p) => p.key);
};

export const useMergeStore = create<MergeState>((set) => ({
  files: {},
  pages: [],
  selected: [],
  anchor: null,
  selectPage: (key, mode) =>
    set((s) => {
      if (mode === 'toggle') return { selected: s.selected.includes(key) ? s.selected.filter((k) => k !== key) : inOrder(s.pages, [...s.selected, key]), anchor: key };
      const a = s.pages.findIndex((p) => p.key === s.anchor);
      const b = s.pages.findIndex((p) => p.key === key);
      if (mode === 'range' && a >= 0 && b >= 0) return { selected: s.pages.slice(Math.min(a, b), Math.max(a, b) + 1).map((p) => p.key) };
      return { selected: [key], anchor: key };
    }),
  selectAll: () => set((s) => ({ selected: s.pages.map((p) => p.key) })),
  clearSelection: () => set({ selected: [], anchor: null }),
  removePages: (keys) =>
    set((s) => {
      const gone = new Set(keys);
      return { pages: s.pages.filter((p) => !gone.has(p.key)), selected: s.selected.filter((k) => !gone.has(k)), undoStack: pushUndo(s) };
    }),
  rotatePages: (keys, by) =>
    set((s) => {
      const on = new Set(keys);
      return { pages: s.pages.map((p) => (on.has(p.key) && p.fileId !== BLANK ? { ...p, rotate: turn(p.rotate, by) } : p)), undoStack: pushUndo(s) };
    }),
  movePages: (keys, to) =>
    set((s) => {
      const moving = new Set(keys);
      const first = s.pages.findIndex((p) => moving.has(p.key));
      if (first < 0 || moving.has(s.pages[to]?.key ?? '')) return s;
      const rest = s.pages.filter((p) => !moving.has(p.key));
      const at = s.pages.slice(0, first < to ? to + 1 : to).filter((p) => !moving.has(p.key)).length;
      const pages = [...rest.slice(0, at), ...s.pages.filter((p) => moving.has(p.key)), ...rest.slice(at)];
      return pages.every((p, i) => p === s.pages[i]) ? s : { pages, undoStack: pushUndo(s) };
    }),
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
  removePage: (key) => set((s) => ({ pages: s.pages.filter((p) => p.key !== key), selected: s.selected.filter((k) => k !== key), undoStack: pushUndo(s) })),
  rotatePage: (key, by = 90) => set((s) => ({ pages: s.pages.map((p) => (p.key === key ? { ...p, rotate: turn(p.rotate, by) } : p)), undoStack: pushUndo(s) })),
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
      return { files, pages: s.pages.filter((p) => p.fileId !== fileId), selected: s.selected.filter((k) => s.pages.find((p) => p.key === k)?.fileId !== fileId), undoStack: pushUndo(s) };
    });
  },
  undoStack: [],
  undo: () =>
    set((s) => {
      const last = s.undoStack.at(-1);
      return last ? { ...last, selected: [], anchor: null, undoStack: s.undoStack.slice(0, -1) } : s;
    }),
  clear: () => {
    releasePdfDocs();
    set({ files: {}, pages: [], error: null, undoStack: [], selected: [], anchor: null });
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
