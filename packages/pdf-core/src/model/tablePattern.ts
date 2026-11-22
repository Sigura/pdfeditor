import { edgeRole, junctionType, type BorderStroke, type CellSpan, type Color, type EdgeRole, type Mesh, type Table, type TablePattern } from '@pdf-toolkit/shared';

/** Drawn border segment: centre line at `pos` from a to b, thickness, colour. */
export type PatternLine = { dir: 'h' | 'v'; pos: number; a: number; b: number; width: number; color: Color };

const r2 = (n: number) => Math.round(n * 100) / 100;
const styleKey = (s: BorderStroke[]) => JSON.stringify(s.map((x) => [r2(x.offset), r2(x.width), x.color.space, x.color.values.map(r2)]));

/**
 * Strokes along one mesh edge: parallel lines within the band (or 1.5 pt when the band is thinner)
 * covering ≥ 80% of the edge between the junction areas at its ends.
 */
function edgeStrokes(lines: PatternLine[], dir: 'h' | 'v', pos: number, a: number, b: number, borderWidth: number): BorderStroke[] {
  const reach = Math.max(borderWidth, 1.5);
  const inner0 = a + reach;
  const inner1 = b - reach;
  const len = Math.max(inner1 - inner0, (b - a) * 0.5);
  const [lo, hi] = inner1 > inner0 ? [inner0, inner1] : [a + (b - a) * 0.25, b - (b - a) * 0.25];
  const out = new Map<string, BorderStroke>();
  for (const l of lines) {
    if (l.dir !== dir || Math.abs(l.pos - pos) > reach) continue;
    const cover = Math.min(hi, l.b) - Math.max(lo, l.a);
    if (cover < 0.8 * len) continue;
    const s = { offset: r2(l.pos - pos), width: r2(l.width), color: l.color };
    out.set(styleKey([s]), s);
  }
  return [...out.values()].sort((p, q) => p.offset - q.offset);
}

/** Most frequent value; the first one seen wins ties. */
function mode<T>(items: T[], key: (t: T) => string): T | undefined {
  const counts = new Map<string, { t: T; n: number }>();
  for (const t of items) {
    const k = key(t);
    const c = counts.get(k);
    if (c) c.n++;
    else counts.set(k, { t, n: 1 });
  }
  let best: { t: T; n: number } | undefined;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best?.t;
}

/** Header rows of a table: from its setup, else the first row (Step 1 default). */
export const headerRowsOf = (t: Pick<Table, 'setup' | 'rows'>) => t.setup?.headerRows ?? Math.min(1, t.rows.length - 1);

/** Body rows that repeat: rows under the header with no merged cell in them. */
export const zebraRows = (rows: number, headerRows: number, spans: CellSpan[]) =>
  Array.from({ length: rows }, (_, r) => r).filter((r) => r >= headerRows && !spans.some((s) => r >= s.row && r < s.row + s.rowSpan));

/** Shortest period p with fill(row i) = fill(row i+p), seen repeating at least once; null when the fills don't repeat. */
function zebra(fills: (Color | null)[][]): (Color | null)[][] | null {
  const key = (row: (Color | null)[]) => JSON.stringify(row);
  for (let p = 1; p < fills.length; p++) {
    if (fills.every((row, i) => i + p >= fills.length || key(row) === key(fills[i + p]!))) return fills.slice(0, p);
  }
  return null;
}

/**
 * Cuts the border look of a vector table at its mesh. `ys`/`xs` are the row and column lines, `snapped`
 * tells whether vertex r,c sat on a junction. Pieces cut at an off-junction vertex are used only when a
 * role has no clean piece.
 */
export function extractPattern(lines: PatternLine[], table: Pick<Table, 'cells'>, mesh: Mesh, ys: number[], xs: number[], borderWidth: number, headerRows: number): TablePattern {
  const rows = ys.length - 1;
  const cols = xs.length - 1;
  const snapped = (r: number, c: number) => mesh.vertices[r]?.[c]?.snapped ?? false;
  const pieces = new Map<EdgeRole, { strokes: BorderStroke[]; clean: boolean }[]>();
  const add = (role: EdgeRole, strokes: BorderStroke[], clean: boolean) => pieces.set(role, [...(pieces.get(role) ?? []), { strokes, clean }]);
  const covered = (dir: 'h' | 'v', r: number, c: number) =>
    mesh.spans.some((s) => (dir === 'h' ? r > s.row && r < s.row + s.rowSpan && c >= s.col && c < s.col + s.colSpan : c > s.col && c < s.col + s.colSpan && r >= s.row && r < s.row + s.rowSpan));
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (covered('h', r, c)) continue;
      add(edgeRole('h', r, rows, headerRows), edgeStrokes(lines, 'h', ys[r]!, xs[c]!, xs[c + 1]!, borderWidth), snapped(r, c) && snapped(r, c + 1));
    }
  }
  for (let c = 0; c <= cols; c++) {
    for (let r = 0; r < rows; r++) {
      if (covered('v', r, c)) continue;
      add(edgeRole('v', c, cols, headerRows), edgeStrokes(lines, 'v', xs[c]!, ys[r + 1]!, ys[r]!, borderWidth), snapped(r, c) && snapped(r + 1, c));
    }
  }
  const edges: TablePattern['edges'] = {};
  for (const [role, list] of pieces) {
    const clean = list.filter((p) => p.clean);
    edges[role] = mode(clean.length ? clean : list, (p) => styleKey(p.strokes))!.strokes;
  }
  const junctions: TablePattern['junctions'] = {};
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const t = junctionType(mesh, r, c);
      if (t) junctions[t] = { flagged: (junctions[t]?.flagged ?? true) && !snapped(r, c) };
    }
  }
  const fillOf = (r: number, c: number) => table.cells.find((x) => x.row === r && x.col === c)?.fill ?? null;
  const body = zebraRows(rows, headerRows, mesh.spans).map((r) => Array.from({ length: cols }, (_, c) => fillOf(r, c)));
  return { edges, junctions, zebra: zebra(body) };
}

/** Stroke set for an edge role; a missing header separator draws like a body row. */
export function roleStrokes(p: TablePattern, role: EdgeRole): BorderStroke[] {
  return p.edges[role] ?? (role === 'headerSeparator' ? p.edges.bodyRow : undefined) ?? [];
}
