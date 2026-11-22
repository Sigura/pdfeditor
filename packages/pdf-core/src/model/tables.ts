import { cellAnchor, gridMesh, type CellSpan, type StoredTable, type BorderStyle, type Cell, type Color, type Point, type Rect, type Ruling, type Table, type TableSetup } from '@pdf-toolkit/shared';
import { rectFromPoints } from '../math.ts';
import { groupLines, toBox, type BoxInternal } from './group.ts';
import { extractPattern, headerRowsOf } from './tablePattern.ts';
import type { ImageItem, PathItem, RunInternal } from './interpreter.ts';

export type TableInternal = {
  table: Table;
  /** Ruling lines and cell fills, removed when the table is regenerated. */
  paths: PathItem[];
  /** Text of each cell as one box, keyed by `row,col`. */
  cellBoxes: Map<string, BoxInternal>;
  runs: RunInternal[];
  /** Images that lie inside a cell, keyed by `row,col` like `cellBoxes`. */
  cellImages: Map<string, ImageItem[]>;
};

export type TableDefinition = TableSetup & { tableId: string };

type Line = { dir: 'h' | 'v'; pos: number; a: number; b: number; path: PathItem; width: number; color: Color };

const TOL = 2;
const MAX_RULE = 3;

const center = (r: Rect): [number, number] => [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
const inside = (r: Rect, x: number, y: number, tol = 0) => x >= r.x0 - tol && x <= r.x1 + tol && y >= r.y0 - tol && y <= r.y1 + tol;
const color = (c: Color): Color => ({ space: c.space, values: c.values });

/** Filled path that is one axis-aligned rectangle (re, or m/l/h without curves). */
function fillRect(p: PathItem): Rect | null {
  if (p.curves) return null;
  if (p.rects.length === 1) return p.rects[0]!;
  if (p.rects.length || p.segments.length < 3 || p.segments.length > 5) return null;
  if (!p.segments.every((s) => Math.abs(s.x0 - s.x1) < 0.01 || Math.abs(s.y0 - s.y1) < 0.01)) return null;
  return rectFromPoints(p.segments.flatMap((s): [number, number][] => [[s.x0, s.y0], [s.x1, s.y1]]));
}

function collectLines(paths: PathItem[]): { lines: Line[]; fills: { rect: Rect; path: PathItem }[] } {
  const lines: Line[] = [];
  const fills: { rect: Rect; path: PathItem }[] = [];
  for (const p of paths) {
    if (p.paint === 'stroke' || p.paint === 'fillStroke') {
      for (const s of p.segments) {
        if (Math.abs(s.y0 - s.y1) < 0.5 && Math.abs(s.x1 - s.x0) > 4) lines.push({ dir: 'h', pos: (s.y0 + s.y1) / 2, a: Math.min(s.x0, s.x1), b: Math.max(s.x0, s.x1), path: p, width: p.lineWidth, color: color(p.stroke) });
        else if (Math.abs(s.x0 - s.x1) < 0.5 && Math.abs(s.y1 - s.y0) > 4) lines.push({ dir: 'v', pos: (s.x0 + s.x1) / 2, a: Math.min(s.y0, s.y1), b: Math.max(s.y0, s.y1), path: p, width: p.lineWidth, color: color(p.stroke) });
      }
    }
    if (p.paint === 'fill' || p.paint === 'fillStroke') {
      const r = fillRect(p);
      if (!r) continue;
      const w = r.x1 - r.x0;
      const h = r.y1 - r.y0;
      // Thin filled rectangles are ruling lines drawn as fills.
      if (h <= MAX_RULE && w > 4) lines.push({ dir: 'h', pos: (r.y0 + r.y1) / 2, a: r.x0, b: r.x1, path: p, width: h, color: color(p.fill) });
      else if (w <= MAX_RULE && h > 4) lines.push({ dir: 'v', pos: (r.x0 + r.x1) / 2, a: r.y0, b: r.y1, path: p, width: w, color: color(p.fill) });
      else if (p.paint === 'fill') fills.push({ rect: r, path: p });
    }
  }
  return { lines, fills };
}

function cluster(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[][] = [];
  for (const v of sorted) {
    const last = out[out.length - 1];
    if (last && v - last[last.length - 1]! <= tol) last.push(v);
    else out.push([v]);
  }
  return out.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}

function components(lines: Line[]): Line[][] {
  const parent = lines.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]!;
      const b = lines[j]!;
      let touch: boolean;
      if (a.dir === b.dir) touch = Math.abs(a.pos - b.pos) <= TOL && a.a <= b.b + TOL && b.a <= a.b + TOL;
      else {
        const [h, v] = a.dir === 'h' ? [a, b] : [b, a];
        touch = v.pos >= h.a - TOL && v.pos <= h.b + TOL && h.pos >= v.a - TOL && h.pos <= v.b + TOL;
      }
      if (touch) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Line[]>();
  lines.forEach((l, i) => {
    const g = groups.get(find(i)) ?? [];
    g.push(l);
    groups.set(find(i), g);
  });
  return [...groups.values()];
}

/**
 * Assigns runs to cells and builds the public table from a grid (ys top→bottom, xs left→right).
 * With a setup, merged cells take the runs of their whole area and the covered cells stay empty.
 */
function buildTable(
  id: string,
  pageIndex: number,
  ys: number[],
  xs: number[],
  runs: RunInternal[],
  fills: { rect: Rect; path: PathItem }[],
  border: BorderStyle | null,
  confidence: number,
  setup?: TableSetup,
  proposed: CellSpan[] = [],
  images: ImageItem[] = [],
): Omit<TableInternal, 'paths'> {
  const bbox: Rect = { x0: xs[0]!, y0: ys[ys.length - 1]!, x1: xs[xs.length - 1]!, y1: ys[0]! };
  const taken = runs.filter((r) => inside(bbox, ...center(r.bbox)));
  const cellBoxes = new Map<string, BoxInternal>();
  const cellImages = new Map<string, ImageItem[]>();
  const cells: Cell[] = [];
  const spans = { vertices: setup?.vertices ?? [], spans: setup?.spans ?? proposed };
  for (let r = 0; r < ys.length - 1; r++) {
    for (let c = 0; c < xs.length - 1; c++) {
      const own: Rect = { x0: xs[c]!, y0: ys[r + 1]!, x1: xs[c + 1]!, y1: ys[r]! };
      const span = cellAnchor(spans, r, c);
      if (span.row !== r || span.col !== c) {
        cells.push({ row: r, col: c, bbox: own, text: '', runIds: [], fill: null, covered: true });
        continue;
      }
      const merged = span.rowSpan > 1 || span.colSpan > 1;
      const cb: Rect = merged ? { x0: xs[c]!, y0: ys[r + span.rowSpan]!, x1: xs[c + span.colSpan]!, y1: ys[r]! } : own;
      const inCell = taken.filter((run) => {
        const [x, y] = center(run.bbox);
        return x >= cb.x0 && x < cb.x1 && y > cb.y0 && y <= cb.y1;
      });
      const lines = groupLines(inCell).sort((a, b) => b.baseline - a.baseline);
      const box = lines.length ? toBox(lines) : undefined;
      if (box) cellBoxes.set(`${r},${c}`, box);
      // Only images that fit in the cell belong to it; a picture behind the whole table does not.
      const imgs = images.filter((im) => im.bbox.x0 >= cb.x0 - 1 && im.bbox.x1 <= cb.x1 + 1 && im.bbox.y0 >= cb.y0 - 1 && im.bbox.y1 <= cb.y1 + 1);
      if (imgs.length) cellImages.set(`${r},${c}`, imgs);
      const [cx, cy] = center(cb);
      const fill = fills.find((f) => inside(f.rect, cx, cy));
      const ink = setup?.origin === 'raster' ? setup.raster?.inkBoxes?.[r]?.[c] : undefined;
      cells.push({
        row: r,
        col: c,
        bbox: cb,
        text: box?.text ?? '',
        runIds: box?.runs.map((x) => x.id) ?? [],
        fill: fill ? color(fill.path.fill) : null,
        ...(box && { runBoxes: box.runs.map((x) => x.bbox) }),
        ...(imgs.length ? imageFit(cb, imgs.map((im) => im.bbox)) : ink ? inkFit(cb, ink) : {}),
        ...(merged && { rowSpan: span.rowSpan, colSpan: span.colSpan }),
      });
    }
  }
  const table: Table = {
    id,
    pageIndex,
    bbox,
    rows: ys.slice(0, -1).map((y, i) => ({ index: i, y0: ys[i + 1]!, y1: y })),
    cols: xs.slice(0, -1).map((x, i) => ({ index: i, x0: x, x1: xs[i + 1]! })),
    cells,
    borderStyle: border,
    bordered: !!border,
    confidence,
    ...(setup && { setup }),
  };
  return { table, cellBoxes, cellImages, runs: [...cellBoxes.values()].flatMap((b) => b.runs) };
}

const IMAGE_CLEARANCE = 2;

/** Scanned cells are redrawn as crops anchored at their top-left corner: the smallest cell that still shows all the ink, with the same clearance as images. */
function inkFit(cell: Rect, ink: Rect): Pick<Cell, 'minSize'> {
  const padX = Math.max(0, Math.min(IMAGE_CLEARANCE, cell.x1 - ink.x1));
  const padY = Math.max(0, Math.min(IMAGE_CLEARANCE, ink.y0 - cell.y0));
  return { minSize: { width: ink.x1 - cell.x0 + padX, height: cell.y1 - ink.y0 + padY } };
}

/** Image boxes of a cell and the smallest cell that holds them, with up to 2 pt clearance (less if the original had less). */
function imageFit(cell: Rect, boxes: Rect[]): Pick<Cell, 'images' | 'minSize'> {
  const u = { x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)), x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)) };
  const padX = Math.max(0, Math.min(IMAGE_CLEARANCE, u.x0 - cell.x0, cell.x1 - u.x1));
  const padY = Math.max(0, Math.min(IMAGE_CLEARANCE, u.y0 - cell.y0, cell.y1 - u.y1));
  return { images: boxes, minSize: { width: u.x1 - u.x0 + 2 * padX, height: u.y1 - u.y0 + 2 * padY } };
}

/** Merges where an inner vertical border is not drawn (e.g. a "Total" row): runs of cells in a row joined by undrawn edges. */
function proposeSpans(vs: Line[], ys: number[], xs: number[]): CellSpan[] {
  const out: CellSpan[] = [];
  const drawn = (x: number, y0: number, y1: number) => vs.some((l) => Math.abs(l.pos - x) <= TOL && Math.min(l.b, y1) - Math.max(l.a, y0) >= 0.5 * (y1 - y0));
  for (let r = 0; r < ys.length - 1; r++) {
    let c = 0;
    while (c < xs.length - 1) {
      let e = c + 1;
      while (e < xs.length - 1 && !drawn(xs[e]!, ys[r + 1]!, ys[r]!)) e++;
      if (e - c > 1) out.push({ row: r, col: c, rowSpan: 1, colSpan: e - c });
      c = e;
    }
  }
  return out;
}

/** Row lines (top→bottom) and column lines of a setup: the mean of each vertex row / column. */
function setupGrid(s: TableSetup): { ys: number[]; xs: number[] } {
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  return { ys: s.vertices.map((row) => mean(row.map((p) => p.y))), xs: s.vertices[0]!.map((_, c) => mean(s.vertices.map((row) => row[c]!.x))) };
}

const setupOf = ({ tableId: _, ...s }: TableDefinition): TableSetup => s;

/** Drawn border segments of the page, for the table setup's band check. */
export function pageRulings(paths: PathItem[]): Ruling[] {
  return collectLines(paths).lines.map((l) => ({ dir: l.dir, pos: l.pos, a: l.a, b: l.b, width: l.width }));
}

/** Points where a horizontal and a vertical ruling meet or touch (cross, tee, corner), merged within 1 pt. */
export function pageJunctions(rulings: Ruling[]): Point[] {
  const hs = rulings.filter((l) => l.dir === 'h');
  const vs = rulings.filter((l) => l.dir === 'v');
  const out: Point[] = [];
  for (const h of hs) {
    for (const v of vs) {
      // A ruling's ends reach half the other's width past its centre line, e.g. butt-capped corners.
      const th = TOL + v.width / 2;
      const tv = TOL + h.width / 2;
      if (v.pos < h.a - th || v.pos > h.b + th || h.pos < v.a - tv || h.pos > v.b + tv) continue;
      if (!out.some((p) => Math.abs(p.x - v.pos) <= 1 && Math.abs(p.y - h.pos) <= 1)) out.push({ x: v.pos, y: h.pos });
    }
  }
  return out;
}

/**
 * Bordered tables: connected sets of horizontal and vertical ruling lines that form a grid of at
 * least two cells. Rows and columns come from the distinct line positions; merged cells are not
 * detected. `defs` (defineTable) replace a detected table with the same id or define a new one.
 * `stored` (models saved in /PieceInfo) apply to the detected table they overlap most, unless a def
 * redefines that table; their saved pattern is used as is.
 */
export function detectTables(pageIndex: number, paths: PathItem[], runs: RunInternal[], defs: TableDefinition[] = [], stored: StoredTable[] = [], images: ImageItem[] = []): TableInternal[] {
  const { lines, fills } = collectLines(paths);
  const out: TableInternal[] = [];
  const unusedStored = new Set(stored);
  const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const storedFor = (bbox: Rect) => {
    let best: StoredTable | undefined;
    for (const st of unusedStored) if (overlap(st.bbox, bbox) > 0 && (!best || overlap(st.bbox, bbox) > overlap(best.bbox, bbox))) best = st;
    if (best) unusedStored.delete(best);
    return best;
  };
  for (const comp of components(lines)) {
    const hs = comp.filter((l) => l.dir === 'h');
    const vs = comp.filter((l) => l.dir === 'v');
    if (!hs.length || !vs.length) continue;
    const ys = cluster(hs.map((l) => l.pos), TOL).reverse();
    const xs = cluster(vs.map((l) => l.pos), TOL);
    if (ys.length < 2 || xs.length < 2 || (ys.length - 1) * (xs.length - 1) < 2) continue;
    const bbox: Rect = { x0: xs[0]!, y0: ys[ys.length - 1]!, x1: xs[xs.length - 1]!, y1: ys[0]! };
    // Share of grid boundaries that are actually drawn across the full table span.
    const spans = (set: Line[], pos: number, from: number, to: number) => {
      const segs = set.filter((l) => Math.abs(l.pos - pos) <= TOL).sort((a, b) => a.a - b.a);
      let reach = from;
      for (const s of segs) if (s.a <= reach + TOL) reach = Math.max(reach, s.b);
      return reach >= to - TOL;
    };
    const drawn = ys.filter((y) => spans(hs, y, bbox.x0, bbox.x1)).length + xs.filter((x) => spans(vs, x, bbox.y0, bbox.y1)).length;
    const confidence = Math.round((drawn / (ys.length + xs.length)) * 100) / 100;
    const tableFills = fills.filter((f) => f.rect.x0 >= bbox.x0 - TOL && f.rect.x1 <= bbox.x1 + TOL && f.rect.y0 >= bbox.y0 - TOL && f.rect.y1 <= bbox.y1 + TOL);
    const border: BorderStyle = { width: hs[0]!.width, color: hs[0]!.color };
    const id = `t-p${pageIndex}-${out.length}`;
    const st = storedFor(bbox);
    const def = defs.find((g) => g.tableId === id) ?? (st && { ...st.setup, tableId: id });
    const grid = def ? setupGrid(def) : { ys, xs };
    const proposed = def ? [] : proposeSpans(vs, ys, xs);
    const built = buildTable(id, pageIndex, grid.ys, grid.xs, runs, tableFills, border, def ? 1 : confidence, def && setupOf(def), proposed, images);
    const mesh = def ? { vertices: def.vertices, spans: def.spans } : gridMesh(grid.ys, grid.xs, proposed, pageJunctions(pageRulings(comp.map((l) => l.path))));
    const keepStored = st?.pattern && !defs.some((g) => g.tableId === id);
    built.table.pattern = keepStored ? st.pattern : extractPattern(comp, built.table, mesh, grid.ys, grid.xs, def?.borderWidth ?? border.width, headerRowsOf(built.table));
    out.push({ ...built, paths: [...new Set([...comp.map((l) => l.path), ...tableFills.map((f) => f.path)])] });
  }
  for (const st of unusedStored) if (!defs.some((d) => d.tableId === st.tableId)) defs = [...defs, { ...st.setup, tableId: st.tableId }];
  for (const d of defs) {
    if (out.some((t) => t.table.id === d.tableId)) continue;
    const { ys, xs } = setupGrid(d);
    out.push({ ...buildTable(d.tableId, pageIndex, ys, xs, runs, [], null, 1, setupOf(d), [], images), paths: [] });
  }
  // A run belongs to one table only (the first that claims it); so does an image.
  const claimed = new Set<RunInternal>();
  const claimedImages = new Set<ImageItem>();
  return out.filter((t) => {
    if (t.runs.some((r) => claimed.has(r))) return false;
    t.runs.forEach((r) => claimed.add(r));
    for (const [key, list] of t.cellImages) {
      const free = list.filter((im) => !claimedImages.has(im));
      free.forEach((im) => claimedImages.add(im));
      if (free.length) t.cellImages.set(key, free);
      else t.cellImages.delete(key);
    }
    return true;
  });
}
