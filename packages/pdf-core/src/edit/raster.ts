import { cellAnchor, edgeRole, junctionType, meshEdges, type CellSpan, type Color, type EdgeRole, type Matrix, type Mesh, type RasterLook, type Rect } from '@pdf-toolkit/shared';

/** A scanned table's grid: row lines top→bottom, column lines left→right, merges, header rows. */
export type RasterGrid = { ys: number[]; xs: number[]; spans: CellSpan[]; headerRows: number; snapped?: boolean[][] };

/** Anchor cell of the new grid: the original cell it shows (`src`), or none; `blank`: its scan is replaced (new text or emptied); `fill`: a fill set for it (null = paper). */
export type RasterCell = { r: number; c: number; src?: { row: number; col: number }; blank: boolean; fill?: Color | null };

export type RasterInput = {
  /**
   * The scan: its CTM at the Do and its resource name in the page resources. `crop`: a piece of the
   * scan holding the area `src` (resource name and CTM); null = draw the whole scan under the clip.
   */
  image: { ctm: Matrix; key: string; bbox: Rect; crop?: (src: Rect) => { key: string; ctm: Matrix } | null };
  orig: RasterGrid;
  /** `null`: the table was deleted. */
  next: RasterGrid | null;
  cells: RasterCell[];
  borderWidth: number;
  look: RasterLook;
  /** Shift of the scan under the table (the change of its bottom edge). */
  belowShift: number;
};

const num = (n: number) => String(Number(n.toPrecision(12)) || 0);

export function fillOp(c: Color): string {
  const v = c.values.map(num).join(' ');
  return c.space === 'rgb' ? `${v} rg` : c.space === 'cmyk' ? `${v} k` : c.space === 'gray' ? `${v} g` : '1 g';
}

const rectOp = (r: Rect) => `${num(r.x0)} ${num(r.y0)} ${num(r.x1 - r.x0)} ${num(r.y1 - r.y0)} re`;
const meshOf = (g: RasterGrid): Mesh => ({ vertices: g.ys.map((y, r) => g.xs.map((x, c) => ({ x, y, snapped: g.snapped?.[r]?.[c] ?? true }))), spans: g.spans });
const intersect = (a: Rect, b: Rect): Rect | null => {
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return r.x1 - r.x0 > 1e-6 && r.y1 - r.y0 > 1e-6 ? r : null;
};
const inset = (r: Rect, d: number): Rect => ({ x0: r.x0 + d, y0: r.y0 + d, x1: r.x1 - d, y1: r.y1 - d });
const cellRect = (g: RasterGrid, s: CellSpan): Rect => ({ x0: g.xs[s.col]!, y0: g.ys[s.row + s.rowSpan]!, x1: g.xs[s.col + s.colSpan]!, y1: g.ys[s.row]! });

/**
 * Redraw of a scanned table after a structural edit, appended at the end of the page: the scan is
 * never resampled. Paper over the old and new area; the scan under the table, shifted; every kept
 * cell as a crop of its original interior at the original size (top-left aligned, clipped to the new
 * cell); borders tiled along their length from a clean piece of an original edge of the same role;
 * junction squares cut from an original junction of the same type (snapped vertices first).
 */
export function rasterTableContent(o: RasterInput): string {
  const { image, orig, next, look } = o;
  // Half the band: the border plus a margin for the blur of a scanned line.
  const e = o.borderWidth / 2 + Math.max(1, o.borderWidth / 2);
  /** The scan's area `src` (default: under the clip) shifted by dx, dy and clipped. */
  const draw = (clip: Rect, dx: number, dy: number, src: Rect = { x0: clip.x0 - dx, y0: clip.y0 - dy, x1: clip.x1 - dx, y1: clip.y1 - dy }) => {
    const piece = image.crop?.(src) ?? image;
    return `q ${rectOp(clip)} W n 1 0 0 1 ${num(dx)} ${num(dy)} cm ${piece.ctm.map(num).join(' ')} cm /${piece.key} Do Q`;
  };
  const out: string[] = ['q'];
  const origBox = inset(cellRect(orig, { row: 0, col: 0, rowSpan: orig.ys.length - 1, colSpan: orig.xs.length - 1 }), -e);
  const covers = [origBox];
  // The whole width under the table moves, like the vector content there; past the page bottom it is kept for the page flow.
  const strip = intersect({ x0: image.bbox.x0, x1: image.bbox.x1, y0: image.bbox.y0, y1: origBox.y0 }, image.bbox);
  const shift = next ? o.belowShift : 0;
  if (strip && Math.abs(shift) > 1e-6) covers.push(strip);
  if (next) covers.push(inset(cellRect(next, { row: 0, col: 0, rowSpan: next.ys.length - 1, colSpan: next.xs.length - 1 }), -e));
  out.push(`${fillOp(look.paper)} ${covers.map(rectOp).join(' ')} f`);
  if (strip && Math.abs(shift) > 1e-6) {
    out.push(draw({ ...strip, y0: strip.y0 + shift, y1: Math.min(strip.y1 + shift, origBox.y0 + shift) }, 0, shift));
  }
  if (!next) return [...out, 'Q'].join('\n');

  const om = meshOf(orig);
  const nm = meshOf(next);
  const fillOf = (s?: { row: number; col: number }) => (s && look.fills?.[s.row]?.[s.col]) || null;
  const header = (g: RasterGrid, r: number) => r < g.headerRows;
  for (const cell of o.cells) {
    const span = cellAnchor(nm, cell.r, cell.c);
    const nb = cellRect(next, span);
    // Inserted cells take the fill of the nearest kept cell of their column on the same side of the header.
    const peer = cell.src ? undefined : o.cells.filter((k) => k.src && k.c === cell.c && header(next, k.r) === header(next, cell.r)).sort((a, b) => Math.abs(a.r - cell.r) - Math.abs(b.r - cell.r))[0];
    const fill = cell.fill !== undefined ? cell.fill : fillOf(cell.src ?? peer?.src);
    if (fill) out.push(`${fillOp(fill)} ${rectOp(nb)} f`);
    if (!cell.src || cell.blank) continue;
    const ob = cellRect(orig, cellAnchor(om, cell.src.row, cell.src.col));
    const dx = nb.x0 - ob.x0;
    const dy = nb.y1 - ob.y1;
    const inner = inset(ob, e);
    const clip = intersect({ x0: inner.x0 + dx, y0: inner.y0 + dy, x1: inner.x1 + dx, y1: inner.y1 + dy }, inset(nb, e));
    if (clip) out.push(draw(clip, dx, dy));
  }

  const role = (g: RasterGrid, dir: 'h' | 'v', line: number) => edgeRole(dir, line, dir === 'h' ? g.ys.length - 1 : g.xs.length - 1, g.headerRows);
  // Longest clean piece (clear of both junctions) of an original edge per role, and per role and side
  // of the header for vertical edges (header cells may have their own fill beside the line).
  const pieces = new Map<string, { line: number; a: number; b: number }>();
  const pieceKeys = (dir: 'h' | 'v', r: EdgeRole, inHeader: boolean) => (dir === 'v' ? [`v|${r}|${inHeader}`, `v|${r}`] : [`h|${r}`]);
  for (const ed of meshEdges(om)) {
    const line = ed.dir === 'h' ? orig.ys[ed.row]! : orig.xs[ed.col]!;
    const [a, b] = ed.dir === 'h' ? [ed.a.x, ed.b.x] : [ed.b.y, ed.a.y];
    const piece = { line, a: Math.min(a, b) + e + 1, b: Math.max(a, b) - e - 1 };
    if (piece.b - piece.a < 1) continue;
    for (const k of pieceKeys(ed.dir, role(orig, ed.dir, ed.dir === 'h' ? ed.row : ed.col), ed.row < orig.headerRows)) {
      const cur = pieces.get(k);
      if (!cur || piece.b - piece.a > cur.b - cur.a) pieces.set(k, piece);
    }
  }
  const pieceFor = (dir: 'h' | 'v', r: EdgeRole, inHeader = false) =>
    pieceKeys(dir, r, inHeader).map((k) => pieces.get(k)).find(Boolean) ?? pieces.get(`${dir}|${dir === 'h' ? 'bodyRow' : 'innerVertical'}`) ?? [...pieces].find(([k]) => k.startsWith(dir))?.[1];
  // Neighbouring pieces overlap by OV, the later one on top: two clips that only abut would each be
  // antialiased at the join and leave a light seam wherever it falls between device pixels.
  const OV = 0.5;
  /** Tiles piece `p` along [from, to] of the line at `at` (the piece repeats, never stretches). */
  const tile = (dir: 'h' | 'v', p: { line: number; a: number; b: number }, at: number, from: number, to: number) => {
    const len = p.b - p.a - OV;
    for (let s = from; s < to - 1e-6; s += len) {
      const t = Math.min(s + len + OV, to);
      // The whole piece is the source, so every tile of a line shares one crop.
      if (dir === 'h') out.push(draw({ x0: s, x1: t, y0: at - e, y1: at + e }, s - p.a, at - p.line, { x0: p.a, x1: p.b, y0: p.line - e, y1: p.line + e }));
      else out.push(draw({ x0: at - e, x1: at + e, y0: s, y1: t }, at - p.line, s - p.a, { x0: p.line - e, x1: p.line + e, y0: p.a, y1: p.b }));
    }
  };

  // Source junction per type and per type + roles of the lines meeting there (a cross on the header
  // separator has the header fill in its upper half, one between body rows does not).
  const junctions = new Map<string, { x: number; y: number }>();
  const jKeys = (g: RasterGrid, m: Mesh, r: number, c: number) => {
    const t = junctionType(m, r, c);
    return t ? [`${t}|${role(g, 'h', r)}|${role(g, 'v', c)}`, t] : [];
  };
  for (let pass = 0; pass < 2; pass++) {
    om.vertices.forEach((row, r) =>
      row.forEach((v, c) => {
        for (const k of jKeys(orig, om, r, c)) if (!junctions.has(k) && (pass === 1 || v.snapped)) junctions.set(k, { x: orig.xs[c]!, y: orig.ys[r]! });
      }),
    );
  }
  const junctionAt = (r: number, c: number) => jKeys(next, nm, r, c).map((k) => junctions.get(k)).find(Boolean);
  // Runs break at every junction square and stop inside it, so the band of a crossing line (which
  // carries the paper beside that line) never paints over this one.
  const endTrim = (r: number, c: number) => (junctionAt(r, c) ? e - OV : 0);
  const drawn = new Set(meshEdges(nm).map((ed) => `${ed.dir}${ed.row},${ed.col}`));
  const rows = next.ys.length - 1;
  const cols = next.xs.length - 1;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c < cols; ) {
      if (!drawn.has(`h${r},${c}`)) {
        c++;
        continue;
      }
      let end = c + 1;
      while (end < cols && drawn.has(`h${r},${end}`) && !junctionAt(r, end)) end++;
      const p = pieceFor('h', role(next, 'h', r));
      if (p) tile('h', p, next.ys[r]!, next.xs[c]! + endTrim(r, c), next.xs[end]! - endTrim(r, end));
      c = end;
    }
  }
  for (let c = 0; c <= cols; c++) {
    for (let r = 0; r < rows; ) {
      if (!drawn.has(`v${r},${c}`)) {
        r++;
        continue;
      }
      let end = r + 1;
      while (end < rows && drawn.has(`v${end},${c}`) && !junctionAt(end, c)) end++;
      const p = pieceFor('v', role(next, 'v', c), r < next.headerRows);
      if (p) tile('v', p, next.xs[c]!, next.ys[end]! + endTrim(end, c), next.ys[r]! - endTrim(r, c));
      r = end;
    }
  }
  nm.vertices.forEach((row, r) =>
    row.forEach((_, c) => {
      const src = junctionAt(r, c);
      if (!src) return;
      const [x, y] = [next.xs[c]!, next.ys[r]!];
      out.push(draw({ x0: x - e, y0: y - e, x1: x + e, y1: y + e }, x - src.x, y - src.y));
    }),
  );
  out.push('Q');
  return out.join('\n');
}
