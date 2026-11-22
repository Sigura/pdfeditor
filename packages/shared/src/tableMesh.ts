import { z } from 'zod';
import { ColorSchema, RectSchema, type Rect } from './geometry.ts';

/**
 * Shares of the font size that a scanned line of text covers, measured on a 4 px/pt render (antialiasing included):
 * from the top of its ink to the bottom of its descenders, and from the top to its baseline. Set for Helvetica-like
 * sans: Liberation Sans reads 0.68 (caps) to 0.73 (ascenders) and ≈0.93 for a full line, Helvetica ≈0.72 and 0.925.
 */
export const INK_LINE_EM = 0.93;
export const INK_ASCENT_EM = 0.705;

/**
 * Font size of a scanned text line. The ascent alone is right with or without descenders, but a sparse baseline
 * (a lone "4") reads as a descender and makes it short; the full line is short when there are no descenders.
 * Both only ever underestimate, so the larger one wins.
 */
export const inkFontSize = (b: { line: number; ascent: number }) => Math.max(b.ascent / INK_ASCENT_EM, b.line / INK_LINE_EM);

/**
 * Colours of a scanned table, measured on the rendered page: `paper` the page background, `ink` the
 * text colour, `fills` the background of each grid cell ([row][col], null = paper), `inkBoxes` the
 * box of the dark pixels in each cell interior (page space) with the height of its tallest text line and
 * that line's ascent, top to baseline (null = empty or covered cell).
 */
export const RasterLookSchema = z.object({
  paper: ColorSchema,
  ink: ColorSchema.optional(),
  fills: z.array(z.array(ColorSchema.nullable()).max(200)).max(500).optional(),
  inkBoxes: z.array(z.array(RectSchema.extend({ line: z.number().positive(), ascent: z.number().positive() }).nullable()).max(200)).max(500).optional(),
});
export type RasterLook = z.infer<typeof RasterLookSchema>;

export const PointSchema = z.object({ x: z.number(), y: z.number() });
export type Point = z.infer<typeof PointSchema>;

/** Drawn border segment (stroked line or thin filled rectangle), centre line + thickness, page user space. */
export const RulingSchema = z.object({ dir: z.enum(['h', 'v']), pos: z.number(), a: z.number(), b: z.number(), width: z.number() });
export type Ruling = z.infer<typeof RulingSchema>;

export const MeshVertexSchema = z.object({ x: z.number().finite(), y: z.number().finite(), snapped: z.boolean() });
export type MeshVertex = z.infer<typeof MeshVertexSchema>;

export const CellSpanSchema = z.object({
  row: z.number().int().min(0),
  col: z.number().int().min(0),
  rowSpan: z.number().int().min(1),
  colSpan: z.number().int().min(1),
});
export type CellSpan = z.infer<typeof CellSpanSchema>;

/**
 * Confirmed table setup. `vertices` is (rows+1) × (cols+1), top row first, left to right, in
 * original-page coordinates. Vertices hidden by merged cells lie on the line between their visible
 * neighbours (see `normalizeMesh`).
 */
export const TableSetupSchema = z.object({
  vertices: z.array(z.array(MeshVertexSchema).min(2).max(201)).min(2).max(501),
  spans: z.array(CellSpanSchema).max(10_000),
  borderWidth: z.number().finite().min(0).max(50),
  headerRows: z.number().int().min(0),
  origin: z.enum(['vector', 'raster', 'mixed']),
  raster: RasterLookSchema.optional(),
});
export type TableSetup = z.infer<typeof TableSetupSchema>;

export type Mesh = { vertices: MeshVertex[][]; spans: CellSpan[] };
export type MeshEdge = { dir: 'h' | 'v'; row: number; col: number; a: MeshVertex; b: MeshVertex };
export type EdgeStatus = 'ok' | 'off' | 'none';

const meshRows = (m: Mesh) => m.vertices.length - 1;
const meshCols = (m: Mesh) => m.vertices[0]!.length - 1;

/** Problem with the setup's shape, or null when it is consistent. */
export function setupError(s: Pick<TableSetup, 'vertices' | 'spans' | 'headerRows'>): string | null {
  const cols = s.vertices[0]!.length;
  if (s.vertices.some((r) => r.length !== cols)) return 'vertex rows have different lengths';
  const rows = s.vertices.length - 1;
  if (s.headerRows > rows) return `headerRows ${s.headerRows} exceeds ${rows} rows`;
  const taken = new Set<string>();
  for (const sp of s.spans) {
    if (sp.row + sp.rowSpan > rows || sp.col + sp.colSpan > cols - 1) return `span at ${sp.row},${sp.col} leaves the table`;
    for (let r = sp.row; r < sp.row + sp.rowSpan; r++) {
      for (let c = sp.col; c < sp.col + sp.colSpan; c++) {
        if (taken.has(`${r},${c}`)) return `spans overlap at ${r},${c}`;
        taken.add(`${r},${c}`);
      }
    }
  }
  return null;
}

const spanAt = (m: Mesh, row: number, col: number) => m.spans.find((s) => row >= s.row && row < s.row + s.rowSpan && col >= s.col && col < s.col + s.colSpan);

/** Anchor (top-left cell) of the merged cell containing cell row,col. */
export function cellAnchor(m: Mesh, row: number, col: number): CellSpan {
  return spanAt(m, row, col) ?? { row, col, rowSpan: 1, colSpan: 1 };
}

/** Horizontal edge `row` (0 = top border) between vertex columns col and col+1 lies inside a merged cell. */
const hInterior = (m: Mesh, row: number, col: number) => m.spans.some((s) => row > s.row && row < s.row + s.rowSpan && col >= s.col && col < s.col + s.colSpan);
const vInterior = (m: Mesh, row: number, col: number) => m.spans.some((s) => col > s.col && col < s.col + s.colSpan && row >= s.row && row < s.row + s.rowSpan);

/** Drawn edges of the mesh, between neighbouring vertices; edges inside merged cells are left out. */
export function meshEdges(m: Mesh): MeshEdge[] {
  const out: MeshEdge[] = [];
  const v = m.vertices;
  for (let r = 0; r <= meshRows(m); r++) for (let c = 0; c < meshCols(m); c++) if (!hInterior(m, r, c)) out.push({ dir: 'h', row: r, col: c, a: v[r]![c]!, b: v[r]![c + 1]! });
  for (let r = 0; r < meshRows(m); r++) for (let c = 0; c <= meshCols(m); c++) if (!vInterior(m, r, c)) out.push({ dir: 'v', row: r, col: c, a: v[r]![c]!, b: v[r + 1]![c]! });
  return out;
}

function incident(m: Mesh, r: number, c: number) {
  return {
    up: r > 0 && !vInterior(m, r - 1, c),
    down: r < meshRows(m) && !vInterior(m, r, c),
    left: c > 0 && !hInterior(m, r, c - 1),
    right: c < meshCols(m) && !hInterior(m, r, c),
  };
}

/** A vertex is a handle only where edges meet at a corner, tee or cross; straight runs and merged interiors hide it. */
export function vertexVisible(m: Mesh, r: number, c: number): boolean {
  const e = incident(m, r, c);
  const n = +e.up + +e.down + +e.left + +e.right;
  return n >= 3 || (n === 2 && !(e.up && e.down) && !(e.left && e.right));
}

const lerpY = (a: Point, b: Point, x: number) => (Math.abs(b.x - a.x) < 1e-9 ? a.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x));
const lerpX = (a: Point, b: Point, y: number) => (Math.abs(b.y - a.y) < 1e-9 ? a.x : a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y));

/** Puts hidden vertices on the straight edge they lie on (or keeps them, inside merged cells); they are never "snapped". */
export function normalizeMesh(m: Mesh): Mesh {
  const v = m.vertices.map((row) => row.map((p) => ({ ...p })));
  const out = { vertices: v, spans: m.spans };
  for (let r = 0; r <= meshRows(m); r++) {
    for (let c = 0; c <= meshCols(m); c++) {
      if (vertexVisible(m, r, c)) continue;
      const p = v[r]![c]!;
      p.snapped = false;
      const e = incident(m, r, c);
      if (e.left && e.right) {
        let l = c - 1;
        while (!vertexVisible(m, r, l)) l--;
        let k = c + 1;
        while (!vertexVisible(m, r, k)) k++;
        p.y = lerpY(v[r]![l]!, v[r]![k]!, p.x);
      } else if (e.up && e.down) {
        let u = r - 1;
        while (!vertexVisible(m, u, c)) u--;
        let d = r + 1;
        while (!vertexVisible(m, d, c)) d++;
        p.x = lerpX(v[u]![c]!, v[d]![c]!, p.y);
      }
    }
  }
  return out;
}

/** Nearest junction within `radius`, else the point itself (not snapped). */
export function snapPoint(p: Point, junctions: Point[], radius: number): MeshVertex {
  let best: Point | null = null;
  let bd = radius;
  for (const j of junctions) {
    const d = Math.hypot(j.x - p.x, j.y - p.y);
    if (d <= bd) {
      bd = d;
      best = j;
    }
  }
  return best ? { x: best.x, y: best.y, snapped: true } : { x: p.x, y: p.y, snapped: false };
}

/** Grid mesh from row lines (top→bottom) and column lines (left→right), every vertex snapped to a junction when one is within `radius`. */
export function meshFromGrid(ys: number[], xs: number[], junctions: Point[], radius: number): Mesh {
  return { vertices: ys.map((y) => xs.map((x) => snapPoint({ x, y }, junctions, radius))), spans: [] };
}

/** `n` evenly spaced lines from a to b (inclusive). */
export const evenLines = (a: number, b: number, n: number) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

const merge = (iv: [number, number][]) => {
  const s = iv.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of s) {
    if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    }
  }
  return total + (cur ? cur[1] - cur[0] : 0);
};

/**
 * Checks one edge against the drawn rulings. `ok`: rulings lying fully inside the band (edge line ±
 * borderWidth/2) cover ≥ 80% of it. `none`: hardly anything is drawn near it (borderless edge).
 * `off`: a border is drawn there but not inside the band (vertices or border width need fixing).
 */
export function edgeStatus(e: Pick<MeshEdge, 'a' | 'b'>, rulings: Ruling[], borderWidth: number): EdgeStatus {
  const dx = e.b.x - e.a.x;
  const dy = e.b.y - e.a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return 'none';
  const ux = dx / len;
  const uy = dy / len;
  const dir = Math.abs(ux) >= Math.abs(uy) ? 'h' : 'v';
  const half = borderWidth / 2;
  const tol = 0.05;
  const inBand: [number, number][] = [];
  const near: [number, number][] = [];
  for (const r of rulings) {
    if (r.dir !== dir) continue;
    const [p, q] = dir === 'h' ? [{ x: r.a, y: r.pos }, { x: r.b, y: r.pos }] : [{ x: r.pos, y: r.a }, { x: r.pos, y: r.b }];
    const tp = (p.x - e.a.x) * ux + (p.y - e.a.y) * uy;
    const tq = (q.x - e.a.x) * ux + (q.y - e.a.y) * uy;
    const t0 = Math.max(0, Math.min(tp, tq));
    const t1 = Math.min(len, Math.max(tp, tq));
    if (t1 <= t0) continue;
    // Distance of the ruling's centre line from the edge line, at both ends of the overlap.
    const dist = (t: number) => {
      const f = (t - tp) / (tq - tp || 1);
      const x = p.x + (q.x - p.x) * f;
      const y = p.y + (q.y - p.y) * f;
      return Math.abs((x - e.a.x) * uy - (y - e.a.y) * ux);
    };
    const d = Math.max(dist(t0), dist(t1));
    if (d + r.width / 2 <= half + tol) inBand.push([t0, t1]);
    else if (d <= half + Math.max(4, 2 * borderWidth)) near.push([t0, t1]);
  }
  const ok = merge(inBand);
  if (ok >= 0.8 * len) return 'ok';
  return ok + merge(near) < 0.2 * len ? 'none' : 'off';
}

export function bandCheck(m: Mesh, rulings: Ruling[], borderWidth: number): (MeshEdge & { status: EdgeStatus })[] {
  return meshEdges(m).map((e) => ({ ...e, status: edgeStatus(e, rulings, borderWidth) }));
}

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function inQuad(q: Point[], p: Point): boolean {
  let pos = false;
  let neg = false;
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i]!, q[(i + 1) % 4]!, p);
    if (c > 1e-9) pos = true;
    if (c < -1e-9) neg = true;
  }
  return !(pos && neg);
}

/** Merged cell (as its span) that contains the point, or null outside the table. */
export function cellAt(m: Mesh, p: Point): CellSpan | null {
  const v = m.vertices;
  for (let r = 0; r < meshRows(m); r++) {
    for (let c = 0; c < meshCols(m); c++) {
      if (inQuad([v[r]![c]!, v[r]![c + 1]!, v[r + 1]![c + 1]!, v[r + 1]![c]!], p)) return cellAnchor(m, r, c);
    }
  }
  return null;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Cell a content box belongs to (by its centre), and whether it crosses a band or leaves that cell. */
export function placeContent(m: Mesh, r: Rect, borderWidth: number): { cell: CellSpan | null; bad: boolean } {
  const cell = cellAt(m, { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });
  if (!cell) return { cell, bad: true };
  const corners = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
  const key = (s: CellSpan | null) => (s ? `${s.row},${s.col}` : '');
  if (corners.some((p) => key(cellAt(m, p)) !== key(cell))) return { cell, bad: true };
  const half = borderWidth / 2;
  const bad = meshEdges(m).some((e) => corners.some((p) => distToSegment(p, e.a, e.b) < half));
  return { cell, bad };
}

/** Cell range [r0..r1] × [c0..c1] grown until no merged cell sticks out of it. */
function coverRange(m: Mesh, r0: number, c0: number, r1: number, c1: number) {
  let grown = true;
  while (grown) {
    grown = false;
    for (const s of m.spans) {
      const hit = s.row <= r1 && s.row + s.rowSpan - 1 >= r0 && s.col <= c1 && s.col + s.colSpan - 1 >= c0;
      if (!hit) continue;
      const nr0 = Math.min(r0, s.row);
      const nc0 = Math.min(c0, s.col);
      const nr1 = Math.max(r1, s.row + s.rowSpan - 1);
      const nc1 = Math.max(c1, s.col + s.colSpan - 1);
      if (nr0 !== r0 || nc0 !== c0 || nr1 !== r1 || nc1 !== c1) {
        [r0, c0, r1, c1] = [nr0, nc0, nr1, nc1];
        grown = true;
      }
    }
  }
  return { r0, c0, r1, c1 };
}

/** Merges the cells of the range (inclusive) into one cell. */
export function mergeCells(m: Mesh, ra: number, ca: number, rb: number, cb: number): Mesh {
  const { r0, c0, r1, c1 } = coverRange(m, Math.min(ra, rb), Math.min(ca, cb), Math.max(ra, rb), Math.max(ca, cb));
  const spans = m.spans.filter((s) => !(s.row >= r0 && s.row <= r1 && s.col >= c0 && s.col <= c1));
  if (r1 > r0 || c1 > c0) spans.push({ row: r0, col: c0, rowSpan: r1 - r0 + 1, colSpan: c1 - c0 + 1 });
  return normalizeMesh({ vertices: m.vertices, spans });
}

/** Splits every merged cell touching the range; vertices shown again snap to junctions near them. */
export function splitCells(m: Mesh, ra: number, ca: number, rb: number, cb: number, junctions: Point[], radius: number): Mesh {
  const { r0, c0, r1, c1 } = coverRange(m, Math.min(ra, rb), Math.min(ca, cb), Math.max(ra, rb), Math.max(ca, cb));
  const out: Mesh = { vertices: m.vertices, spans: m.spans.filter((s) => !(s.row >= r0 && s.row <= r1 && s.col >= c0 && s.col <= c1)) };
  const vertices = m.vertices.map((row, r) => row.map((p, c) => (!vertexVisible(m, r, c) && vertexVisible(out, r, c) ? snapPoint(p, junctions, radius) : p)));
  return normalizeMesh({ vertices, spans: out.spans });
}

/**
 * Splits row `row` in two (`delta` 1) or removes the line under it, joining it with the next row
 * (`delta` -1, the last row joins the one above). Other vertices stay where they are; spans adjust.
 */
export function changeRows(m: Mesh, row: number, delta: 1 | -1, junctions: Point[], radius: number): Mesh {
  const v = m.vertices;
  if (delta === 1) {
    const mid = v[row]!.map((p, c) => snapPoint({ x: (p.x + v[row + 1]![c]!.x) / 2, y: (p.y + v[row + 1]![c]!.y) / 2 }, junctions, radius));
    const vertices = [...v.slice(0, row + 1), mid, ...v.slice(row + 1)];
    const spans = m.spans.map((s) => (s.row > row ? { ...s, row: s.row + 1 } : s.row + s.rowSpan - 1 >= row ? { ...s, rowSpan: s.rowSpan + 1 } : s));
    return normalizeMesh({ vertices, spans });
  }
  if (meshRows(m) < 2) return m;
  const line = Math.min(row + 1, meshRows(m) - 1);
  const vertices = v.filter((_, i) => i !== line);
  const spans = m.spans
    .map((s) => (s.row >= line ? { ...s, row: s.row - 1 } : s.row + s.rowSpan > line ? { ...s, rowSpan: s.rowSpan - 1 } : s))
    .filter((s) => s.rowSpan > 1 || s.colSpan > 1);
  return normalizeMesh({ vertices, spans: dedupe(spans) });
}

const transpose = (m: Mesh): Mesh => ({
  vertices: m.vertices[0]!.map((_, c) => m.vertices.map((row) => row[c]!)),
  spans: m.spans.map((s) => ({ row: s.col, col: s.row, rowSpan: s.colSpan, colSpan: s.rowSpan })),
});

/** Column counterpart of `changeRows`. */
export function changeCols(m: Mesh, col: number, delta: 1 | -1, junctions: Point[], radius: number): Mesh {
  return normalizeMesh(transpose(changeRows(transpose(m), col, delta, junctions, radius)));
}

/** Removing a line can make two spans start at the same cell; the larger one wins. */
function dedupe(spans: CellSpan[]): CellSpan[] {
  const out: CellSpan[] = [];
  for (const s of [...spans].sort((a, b) => b.rowSpan * b.colSpan - a.rowSpan * a.colSpan)) {
    const overlaps = out.some((o) => s.row < o.row + o.rowSpan && o.row < s.row + s.rowSpan && s.col < o.col + o.colSpan && o.col < s.col + s.colSpan);
    if (!overlaps) out.push(s);
  }
  return out;
}

/** Visible vertices not on a junction, as [row, col]; Confirm lists them. */
export function unsnappedVertices(m: Mesh): [number, number][] {
  const out: [number, number][] = [];
  m.vertices.forEach((row, r) => row.forEach((p, c) => !p.snapped && vertexVisible(m, r, c) && out.push([r, c])));
  return out;
}

const ON_JUNCTION = 0.5;

/** Rectangular mesh from row lines (top→bottom) and column lines; a vertex is snapped when a junction lies within 0.5 pt. */
export function gridMesh(ys: number[], xs: number[], spans: CellSpan[], junctions: Point[]): Mesh {
  const vertices = ys.map((y) => xs.map((x) => ({ x, y, snapped: junctions.some((j) => Math.abs(j.x - x) <= ON_JUNCTION && Math.abs(j.y - y) <= ON_JUNCTION) })));
  return normalizeMesh({ vertices, spans });
}

/** Row and column lines of a mesh: per line, the mean of its snapped visible vertices (all vertices when none is snapped). */
export function meshLines(m: Mesh): { ys: number[]; xs: number[] } {
  const pick = (pts: { p: MeshVertex; vis: boolean }[], k: 'x' | 'y') => {
    const good = pts.filter((q) => q.vis && q.p.snapped);
    const use = good.length ? good : pts;
    return use.reduce((s, q) => s + q.p[k], 0) / use.length;
  };
  const ys = m.vertices.map((row, r) => pick(row.map((p, c) => ({ p, vis: vertexVisible(m, r, c) })), 'y'));
  const xs = m.vertices[0]!.map((_, c) => pick(m.vertices.map((row, r) => ({ p: row[c]!, vis: vertexVisible(m, r, c) })), 'x'));
  return { ys, xs };
}

/** Every cell a rectangle: vertices aligned to their row and column lines. */
export const rectifyMesh = (m: Mesh, junctions: Point[]): Mesh => {
  const { ys, xs } = meshLines(m);
  return gridMesh(ys, xs, m.spans, junctions);
};

/** Moves vertex r,c to p by moving its whole row line and column line, so all cells stay rectangles. */
export function moveGridVertex(m: Mesh, r: number, c: number, p: Point, junctions: Point[]): Mesh {
  const { ys, xs } = meshLines(m);
  ys[r] = p.y;
  xs[c] = p.x;
  return gridMesh(ys, xs, m.spans, junctions);
}

/** One stroke of a border edge: `offset` of its centre line from the edge (up / right positive), thickness, colour. */
export const BorderStrokeSchema = z.object({ offset: z.number(), width: z.number(), color: ColorSchema });
export const EdgeRoleSchema = z.enum(['outerTop', 'headerSeparator', 'bodyRow', 'outerBottom', 'outerLeft', 'innerVertical', 'outerRight']);
export type EdgeRole = z.infer<typeof EdgeRoleSchema>;
export const JunctionTypeSchema = z.enum(['cornerTL', 'cornerTR', 'cornerBL', 'cornerBR', 'teeTop', 'teeBottom', 'teeLeft', 'teeRight', 'cross']);
export type JunctionType = z.infer<typeof JunctionTypeSchema>;

/**
 * Border look of a vector table, cut from the original at the mesh. `edges`: stroke set per edge role
 * (empty = no border there), regenerated to any length. `junctions`: types seen in the original;
 * `flagged` when every piece of that type was cut at a vertex off its junction. `zebra`: fill per
 * column of the repeating body rows (rows without merged cells), `period` rows long.
 */
export const TablePatternSchema = z.object({
  edges: z.record(EdgeRoleSchema, z.array(BorderStrokeSchema)),
  junctions: z.record(JunctionTypeSchema, z.object({ flagged: z.boolean() })),
  zebra: z.array(z.array(ColorSchema.nullable())).nullable(),
});
export type TablePattern = z.infer<typeof TablePatternSchema>;
export type BorderStroke = z.infer<typeof BorderStrokeSchema>;

/** Table model stored in the page's /PieceInfo, restored when the saved file is opened again. */
export const StoredTableSchema = z.object({ tableId: z.string(), bbox: RectSchema, setup: TableSetupSchema, pattern: TablePatternSchema.optional() });
export type StoredTable = z.infer<typeof StoredTableSchema>;

/** Role of horizontal edge line `row` (0 = top) or vertical edge line `col`. */
export function edgeRole(dir: 'h' | 'v', line: number, count: number, headerRows: number): EdgeRole {
  if (dir === 'v') return line === 0 ? 'outerLeft' : line === count ? 'outerRight' : 'innerVertical';
  if (line === 0) return 'outerTop';
  if (line === count) return 'outerBottom';
  return line === headerRows ? 'headerSeparator' : 'bodyRow';
}

/** Junction type of vertex r,c from the drawn edges meeting there, or null (straight run, inside a merged cell). */
export function junctionType(m: Mesh, r: number, c: number): JunctionType | null {
  const e = incident(m, r, c);
  const n = +e.up + +e.down + +e.left + +e.right;
  if (n === 4) return 'cross';
  if (n === 3) return !e.up ? 'teeTop' : !e.down ? 'teeBottom' : !e.left ? 'teeLeft' : 'teeRight';
  if (n !== 2 || (e.up && e.down) || (e.left && e.right)) return null;
  return e.down ? (e.right ? 'cornerTL' : 'cornerTR') : e.right ? 'cornerBL' : 'cornerBR';
}

/** Spans after inserting a row at `at` (the new row's index): spans across it grow, spans below move down. */
export function spansInsertRow(spans: CellSpan[], at: number): CellSpan[] {
  return spans.map((s) => (s.row >= at ? { ...s, row: s.row + 1 } : s.row + s.rowSpan > at ? { ...s, rowSpan: s.rowSpan + 1 } : s));
}

/** Spans after deleting row `index`: spans across it shrink (1×1 ones are dropped), spans below move up. */
export function spansDeleteRow(spans: CellSpan[], index: number): CellSpan[] {
  return spans
    .map((s) => (s.row > index ? { ...s, row: s.row - 1 } : s.row + s.rowSpan > index ? { ...s, rowSpan: s.rowSpan - 1 } : s))
    .filter((s) => s.rowSpan > 0 && (s.rowSpan > 1 || s.colSpan > 1));
}

const flip = (spans: CellSpan[]) => spans.map((s) => ({ row: s.col, col: s.row, rowSpan: s.colSpan, colSpan: s.rowSpan }));
export const spansInsertCol = (spans: CellSpan[], at: number) => flip(spansInsertRow(flip(spans), at));
export const spansDeleteCol = (spans: CellSpan[], index: number) => flip(spansDeleteRow(flip(spans), index));
/** Content of the page's /PieceInfo private data. */
export const StoredTablesSchema = z.object({ version: z.literal(1), tables: z.array(StoredTableSchema) });
