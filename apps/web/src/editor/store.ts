import { create } from 'zustand';
import { displayOrder, type ArrangePages, type CellSpan, type EditOperation, type EditResult, type PageModel, type PageOverflow, type Point, type Rect, type Ruling, type StrategyReport, type TableSetup } from '@pdf-toolkit/shared';
import { postEdits } from '../lib/api.ts';
import { measureScanLayouts, moveOp } from './background.ts';

export type Tool = 'select' | 'addText' | 'table';
/**
 * Table setup in progress (Table tool), with the Step 1 defaults. `grid`: detected or proposed row lines
 * (top→bottom) and column lines; `setup`: the table's confirmed setup, when it has one.
 */
export type SetupDraft = {
  pageIndex: number;
  tableId: string;
  rect: Rect;
  rows: number;
  cols: number;
  borderWidth: number;
  headerRows: number;
  /** Detected grid; `spans`: merges detection proposes where inner borders are not drawn. */
  grid?: { ys: number[]; xs: number[]; spans?: CellSpan[] };
  setup?: TableSetup;
  /** Scanned table: border lines and junctions found in the rendered pixels (the page has no vector rulings there). */
  raster?: { rulings: Ruling[]; junctions: Point[] };
};
export type CellRef = { tableId: string; row: number; col: number };
export type NewTextStyle = { fontFamily: string; fontSize: number };
/**
 * Question shown over the editor: content pushed past the page bottom by the last edit (`count` ops,
 * Cancel takes them back), or a column insert that would leave the page (shrink the others or cancel).
 */
export type Prompt =
  | { kind: 'newPage'; pageIndex: number; by: number; count: number; pageNumber?: string; tableIds: string[] }
  | { kind: 'continuation'; pageIndex: number; tableIds: string[] }
  | { kind: 'colFit'; by: number; op: Extract<EditOperation, { type: 'tableInsertCol' }> };
export type Activity = { id: number; label: string; since: number };
let activityId = 0;

/** Runs `fn` as a named activity, so a long wait shows progress. */
export async function track<T>(label: string, fn: (step: (label: string) => void) => Promise<T>): Promise<T> {
  const st = useEditor.getState();
  const id = st.begin(label);
  try {
    return await fn((l) => useEditor.getState().progress(id, l));
  } finally {
    useEditor.getState().end(id);
  }
}

/** Arrow-key moves not yet sent, in PDF user space. */
export const arrangement = (ops: EditOperation[]): ArrangePages | undefined => ops.findLast((op) => op.type === 'arrangePages');

/** Edit page indices in the order the pages are shown and downloaded. */
export const pageOrder = (ops: EditOperation[], pages: PageModel[]): number[] => displayOrder(arrangement(ops), pages.length, pages.filter((p) => !p.added).length);

/** 1-based number of edit page `k` as shown. */
/** Edits made since the last download. */
export const hasUnsaved = (s: { ops: EditOperation[]; revision: number; downloadedRevision: number }) => s.ops.length > 0 && s.revision !== s.downloadedRevision;

export const pageNo = (s: { ops: EditOperation[]; pages: PageModel[] }, k: number): number => pageOrder(s.ops, s.pages).indexOf(k) + 1;

export type Nudge = { id: string; dx: number; dy: number };

/** A page's scanLayout is measured on the straightened page, so it goes when the page's deskew changes. */
const withoutStaleLayouts = (ops: EditOperation[], pageIndexes: number[]) => ops.filter((o) => o.type !== 'scanLayout' || !pageIndexes.includes(o.pageIndex));
const deskewedPages = (ops: EditOperation[]) => ops.flatMap((o) => (o.type === 'deskewPage' ? [o.pageIndex] : []));

export type EditorState = {
  docId: string | null;
  fileName: string;
  pages: PageModel[];
  /** Page models of the unedited document, to locate deleted elements. */
  origPages: PageModel[];
  revision: number;
  /** Revision last downloaded; leaving the page asks first when edits are newer. */
  downloadedRevision: number;
  pageIndex: number;
  zoom: number;
  hoveredId: string | null;
  selectedId: string | null;
  editingId: string | null;
  ops: EditOperation[];
  redoStack: EditOperation[][];
  reports: StrategyReport[];
  warnings: string[];
  overflows: PageOverflow[];
  /** Cut tables with header rows still waiting for a tableContinuation answer. */
  continuations: EditResult['continuations'];
  prompt: Prompt | null;
  busy: boolean;
  /** Running operations, oldest first; the editor shows the latest once it has run 1.5 s. */
  activities: Activity[];
  begin: (label: string) => number;
  progress: (id: number, label: string) => void;
  end: (id: number) => void;
  error: string | null;
  showChanges: boolean;
  tool: Tool;
  cell: CellRef | null;
  editingCell: CellRef | null;
  newText: NewTextStyle;
  nudge: Nudge | null;
  tableSetup: SetupDraft | null;
  /** Bumped after each page render, so pixel-based colour detection re-reads the canvas. */
  renderCount: number;
  /** A file handed over from another tab (Merge's "Edit result"), opened by the editor when it mounts. */
  incoming: File | null;
  setIncoming: (f: File | null) => void;
  setDocument: (d: { docId: string; fileName: string; pages: PageModel[] }) => void;
  setPage: (i: number) => void;
  setZoom: (z: number) => void;
  hover: (id: string | null) => void;
  select: (id: string | null) => void;
  startEditing: (id: string | null) => void;
  applyResult: (r: EditResult) => void;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  toggleChanges: () => void;
  reset: () => void;
  setTool: (t: Tool) => void;
  selectCell: (c: CellRef | null) => void;
  editCell: (c: CellRef | null) => void;
  setNewText: (s: Partial<NewTextStyle>) => void;
  startSetup: (d: SetupDraft | null) => void;
  /** Appends ops on the server; `then` runs with the new state (e.g. to start editing a new box). */
  edit: (ops: EditOperation[], then?: () => void) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** Appends deskewPage ops (the last one per page wins; angle 0 straightens nothing). */
  deskew: (ops: Extract<EditOperation, { type: 'deskewPage' }>[]) => Promise<void>;
  /** Undoes one op anywhere in the list (later ops that depend on it make the server reject the change). */
  /** Undoes the op at `index`, together with the ops at `also` (later ops that depend on it). */
  removeOp: (index: number, also?: number[]) => Promise<void>;
  /** Undoes every op; one redo brings them all back. */
  revertAll: () => Promise<void>;
  /** Moves the selected box by (dx, dy); consecutive nudges are sent as one moveElement. */
  nudgeBy: (dx: number, dy: number) => void;
  rendered: () => void;
  setPrompt: (p: Prompt | null) => void;
  /** Takes back the last `count` ops (not redoable). */
  revert: (count: number) => Promise<void>;
  /** Sends a pending nudge now and resolves once every queued or running change has been applied. */
  settle: () => Promise<void>;
  setDownloaded: (revision: number) => void;
};

const initial = {
  docId: null,
  fileName: '',
  pages: [],
  origPages: [],
  revision: 0,
  downloadedRevision: 0,
  pageIndex: 0,
  zoom: 1.25,
  hoveredId: null,
  selectedId: null,
  editingId: null,
  ops: [],
  redoStack: [],
  reports: [],
  warnings: [],
  overflows: [] as PageOverflow[],
  continuations: [] as EditResult['continuations'],
  prompt: null as Prompt | null,
  activities: [] as Activity[],
  busy: false,
  error: null,
  showChanges: false,
  tool: 'select' as Tool,
  cell: null,
  editingCell: null,
  newText: { fontFamily: 'Helvetica', fontSize: 12 },
  nudge: null,
  tableSetup: null,
  renderCount: 0,
  incoming: null as File | null,
};

let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
/** Nudge amounts handed to `send` (queued or in flight) per element, not yet applied to `nudge`. */
const pendingNudges = new Map<string, { dx: number; dy: number }>();
const addPending = (n: Nudge, sign: 1 | -1) => {
  const p = pendingNudges.get(n.id) ?? { dx: 0, dy: 0 };
  const next = { dx: p.dx + sign * n.dx, dy: p.dy + sign * n.dy };
  if (Math.abs(next.dx) < 1e-6 && Math.abs(next.dy) < 1e-6) pendingNudges.delete(n.id);
  else pendingNudges.set(n.id, next);
};

/** Sends `n` as one moveElement; nudges made while the request runs stay pending. */
async function sendNudge(get: () => EditorState, set: (p: Partial<EditorState>) => void, n: Nudge): Promise<void> {
  addPending(n, 1);
  const ok = await send(get, () => {
    const st = get();
    const model = st.pages.find((p) => p.textBoxes.some((b) => b.id === n.id) || p.tables.some((t) => t.id === n.id));
    return [model ? moveOp(model, st.ops, n.id, n.dx, n.dy) : { type: 'moveElement', elementId: n.id, dx: n.dx, dy: n.dy }];
  }, 'append');
  addPending(n, -1);
  const after = get().nudge;
  if (!ok) return set({ nudge: after?.id === n.id ? null : after });
  set({ redoStack: [] });
  const rest = after && after.id === n.id ? { id: n.id, dx: after.dx - n.dx, dy: after.dy - n.dy } : after;
  set({ nudge: rest && (Math.abs(rest.dx) > 1e-6 || Math.abs(rest.dy) > 1e-6) ? rest : null });
}

let queue: Promise<boolean> = Promise.resolve(true);
/** edit() calls still running: after their first request they may measure scans and send more. */
const running = new Set<Promise<void>>();

/**
 * Requests run one at a time, in call order, so appends never overlap. `ops` as a function is
 * evaluated when the request starts, against the state the earlier requests left (null = skip).
 */
function send(get: () => EditorState, ops: EditOperation[] | (() => EditOperation[] | null), mode: 'append' | 'replace'): Promise<boolean> {
  const run = async () => {
    const st = get();
    const list = typeof ops === 'function' ? ops() : ops;
    if (!st.docId || !list) return false;
    st.setBusy(true);
    st.setError(null);
    try {
      st.applyResult(await track('Applying changes…', () => postEdits(st.docId!, list, mode)));
      return true;
    } catch (e) {
      st.setError((e as Error).message);
      return false;
    } finally {
      st.setBusy(false);
    }
  };
  queue = queue.then(run);
  return queue;
}

export const useEditor = create<EditorState>((set, get) => ({
  ...initial,
  setDocument: (d) => set({ ...initial, ...d, origPages: d.pages }),
  setPage: (pageIndex) => set({ pageIndex, selectedId: null, editingId: null, cell: null, editingCell: null, tableSetup: null }),
  setZoom: (zoom) => set({ zoom: Math.min(4, Math.max(0.25, zoom)) }),
  hover: (hoveredId) => set({ hoveredId }),
  select: (selectedId) => set((s) => ({ selectedId, editingId: s.editingId === selectedId ? s.editingId : null, cell: null, editingCell: null })),
  startEditing: (editingId) => set({ editingId, selectedId: editingId, cell: null, editingCell: null }),
  applyResult: (r) =>
    set((s) => {
      const order = pageOrder(r.ops, r.pages);
      const pageIndex = order.includes(s.pageIndex) ? s.pageIndex : (order.find((k) => k > s.pageIndex) ?? order[order.length - 1]!);
      return { revision: r.revision, ops: r.ops, reports: r.reports, warnings: r.warnings, overflows: r.overflows, continuations: r.continuations, pages: r.pages, editingId: null, editingCell: null, pageIndex };
    }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
  toggleChanges: () => set((s) => ({ showChanges: !s.showChanges })),
  reset: () => set(initial),
  setTool: (tool) => set({ tool, selectedId: null, editingId: null, cell: null, editingCell: null, tableSetup: null }),
  selectCell: (cell) => set({ cell, selectedId: null, editingId: null, editingCell: null }),
  editCell: (editingCell) => set({ editingCell, cell: editingCell ?? get().cell }),
  setNewText: (s) => set((st) => ({ newText: { ...st.newText, ...s } })),
  startSetup: (tableSetup) => set({ tableSetup }),
  edit: (ops, then) => {
    const p = (async () => {
      const before = get().overflows;
      if (await send(get, ops, 'append')) {
        set({ redoStack: [] });
        let count = ops.length;
        // The flow reached scanned pages: measure their layout (on the original) and send it with this change.
        for (let round = 0; round < 3; round++) {
          const need = get().overflows.find((o) => o.needsLayout?.length)?.needsLayout;
          const docId = get().docId;
          if (!need || !docId) break;
          // A page copy has no original model; its current one shows the copied page.
          const models = need.map((i) => get().origPages[i] ?? get().pages[i]!);
          let layouts: EditOperation[];
          try {
            layouts = await track('Measuring scanned page layout…', (step) => measureScanLayouts(docId, models, (i, n) => step(`Measuring scanned page layout ${i}/${n}…`)));
          } catch (e) {
            set({ error: (e as Error).message });
            break;
          }
          if (!layouts.length || !(await send(get, layouts, 'append'))) break;
          count += layouts.length;
        }
        // Content newly pushed past the last page: ask how to continue (new page copying the header/footer, empty, or cancel).
        const worse = get().overflows.find((o) => o.needsPage && o.by > (before.find((b) => b.pageIndex === o.pageIndex)?.by ?? 0) + 0.05);
        const tableIds = get().continuations.map((c) => c.tableId);
        if (worse) set({ prompt: { kind: 'newPage', pageIndex: worse.pageIndex, by: worse.by, count, ...(worse.pageNumber && { pageNumber: worse.pageNumber }), tableIds } });
        // A table cut onto an existing page: ask whether its header rows repeat there.
        else if (tableIds.length) set({ prompt: { kind: 'continuation', pageIndex: get().continuations[0]!.pageIndex, tableIds } });
        then?.();
      }
    })().finally(() => running.delete(p));
    running.add(p);
    return p;
  },
  settle: async () => {
    for (;;) {
      const { nudge } = get();
      if (nudge) {
        clearTimeout(nudgeTimer);
        const p = pendingNudges.get(nudge.id) ?? { dx: 0, dy: 0 };
        const rest = { id: nudge.id, dx: nudge.dx - p.dx, dy: nudge.dy - p.dy };
        if (Math.abs(rest.dx) > 1e-6 || Math.abs(rest.dy) > 1e-6) void sendNudge(get, set, rest);
      }
      const q = queue;
      await Promise.all([q, ...running]);
      if (q === queue && !running.size && !pendingNudges.size && !get().nudge) return;
    }
  },
  setDownloaded: (downloadedRevision) => set({ downloadedRevision }),
  setIncoming: (incoming) => set({ incoming }),
  setPrompt: (prompt) => set({ prompt }),
  revert: async (count) => {
    set({ prompt: null });
    await send(get, () => get().ops.slice(0, -count), 'replace');
  },
  deskew: async (list) => {
    if (await send(get, () => [...withoutStaleLayouts(get().ops, list.map((o) => o.pageIndex)), ...list], 'replace')) set({ redoStack: [] });
  },
  undo: async () => {
    clearTimeout(nudgeTimer);
    set({ nudge: null });
    let undone: EditOperation[] = [];
    // An op that was appended together with others is undone on its own; the server keeps no batches.
    // Measured scan layouts stay (they describe the original); the change before them is undone.
    const ok = await send(get, () => {
      const { ops } = get();
      const i = ops.findLastIndex((o) => o.type !== 'scanLayout');
      if (i < 0) return null;
      undone = [ops[i]!];
      return withoutStaleLayouts(ops.filter((_, k) => k !== i), deskewedPages(undone));
    }, 'replace');
    if (ok) set((s) => ({ redoStack: [...s.redoStack, undone] }));
  },
  redo: async () => {
    clearTimeout(nudgeTimer);
    set({ nudge: null });
    const ok = await send(get, () => get().redoStack.at(-1) ?? null, 'append');
    if (ok) set((s) => ({ redoStack: s.redoStack.slice(0, -1) }));
  },
  revertAll: async () => {
    clearTimeout(nudgeTimer);
    set({ nudge: null });
    let undone: EditOperation[] = [];
    const ok = await send(get, () => {
      undone = get().ops;
      return undone.length ? [] : null;
    }, 'replace');
    if (ok) set((s) => ({ redoStack: [...s.redoStack, undone] }));
  },
  removeOp: async (index, also = []) => {
    clearTimeout(nudgeTimer);
    set({ nudge: null });
    const { ops } = get();
    const indexes = [index, ...also];
    const targets = indexes.map((i) => JSON.stringify(ops[i]));
    // An earlier queued request may have replaced the list; find the ops again by value.
    const keep = () => {
      const cur = get().ops;
      const found = cur === ops ? indexes : targets.map((t) => cur.findIndex((o) => JSON.stringify(o) === t));
      if (found.some((i) => i < 0)) return null;
      return withoutStaleLayouts(cur.filter((_, k) => !found.includes(k)), deskewedPages(found.map((i) => cur[i]!)));
    };
    if (await send(get, keep, 'replace')) set({ redoStack: [] });
    else set((st) => ({ error: `Change ${index + 1} can't be undone on its own (a later change depends on it): ${st.error}` }));
  },
  nudgeBy: (dx, dy) => {
    const { selectedId, nudge } = get();
    if (!selectedId) return;
    clearTimeout(nudgeTimer);
    // A pending nudge of another element is sent first, on its own, minus what is already being sent.
    if (nudge && nudge.id !== selectedId) {
      const p = pendingNudges.get(nudge.id) ?? { dx: 0, dy: 0 };
      const rest = { id: nudge.id, dx: nudge.dx - p.dx, dy: nudge.dy - p.dy };
      if (Math.abs(rest.dx) > 1e-6 || Math.abs(rest.dy) > 1e-6) void sendNudge(get, set, rest);
    }
    const cur = nudge?.id === selectedId ? nudge : { id: selectedId, dx: 0, dy: 0 };
    set({ nudge: { id: selectedId, dx: cur.dx + dx, dy: cur.dy + dy } });
    const flush = () => {
      const n = get().nudge;
      if (!n) return;
      if (get().busy || pendingNudges.size) nudgeTimer = setTimeout(flush, 200);
      else void sendNudge(get, set, n).then(() => get().nudge && (nudgeTimer = setTimeout(flush, 400)));
    };
    nudgeTimer = setTimeout(flush, 400);
  },
  rendered: () => set((s) => ({ renderCount: s.renderCount + 1 })),
  begin: (label) => {
    const id = ++activityId;
    set((s) => ({ activities: [...s.activities, { id, label, since: Date.now() }] }));
    return id;
  },
  progress: (id, label) => set((s) => ({ activities: s.activities.map((a) => (a.id === id ? { ...a, label } : a)) })),
  end: (id) => set((s) => ({ activities: s.activities.filter((a) => a.id !== id) })),
}));

// The document lives on the server only for the session's TTL and the page keeps no handle to it.
window.addEventListener('beforeunload', (e) => {
  const s = useEditor.getState();
  if (!hasUnsaved(s)) return;
  e.preventDefault();
  // Older Chrome/Safari only show the prompt when returnValue is set.
  e.returnValue = '';
});
