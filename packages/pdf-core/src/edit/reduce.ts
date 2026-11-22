import type { Align, CellSpan, Color, EditOperation, OverflowMode, PageModel, Rect, Table, TextBox } from '@pdf-toolkit/shared';
import { PdfError } from '../errors.ts';
import { cellAnchor, setupError, spansDeleteCol, spansDeleteRow, spansInsertCol, spansInsertRow } from '@pdf-toolkit/shared';
import type { TableDefinition } from '../model/tables.ts';
import { headerRowsOf, zebraRows } from '../model/tablePattern.ts';

export type BoxEdit = {
  boxId: string;
  pageIndex: number;
  deleted: boolean;
  /** Replacement text (lines split by \n); undefined = original text. */
  text?: string;
  overflow?: OverflowMode;
  /** Translation in user space (moveElement, or the reflow under a table that changed height). */
  dx: number;
  dy: number;
  /** New wrap width in user space (moveElement resize). */
  width?: number;
  height?: number;
  style?: TextStyle;
};

/** setTextStyle overrides; `lineSpacing` is the baseline distance as a multiple of the font size; `background` null = no fill. */
export type TextStyle = { color?: Color; align?: Align; lineSpacing?: number; background?: Color | null };

export type AddedBox = {
  id: string;
  pageIndex: number;
  bbox: Rect;
  text: string;
  fontSize: number;
  fontFamily?: string;
  color?: Color;
  align?: Align;
  lineSpacing?: number;
  background?: Color | null;
};

/**
 * `src` is the original cell the content came from (undefined for inserted cells). `edited`: set by setCellText (a scanned cell then shows its new text, even when empty, instead of the scan).
 * `style`/`background`: setCellText overrides (font, size, colour; the cell fill, null = none).
 */
export type CellState = { text: string; src?: { row: number; col: number }; fill: Color | null; edited?: boolean; style?: CellStyle; background?: Color | null };
export type CellStyle = { fontFamily?: string; fontSize?: number; color?: Color };

export type TableEdit = {
  tableId: string;
  pageIndex: number;
  deleted: boolean;
  /** Row boundaries top→bottom and column boundaries left→right, before the move. */
  ys: number[];
  xs: number[];
  /** Text of a merged cell lives in its anchor (top-left) cell; covered cells stay empty. */
  cells: CellState[][];
  spans: CellSpan[];
  headerRows: number;
  /** Zebra fills of the repeating body rows (pattern), kept in step with column inserts and deletes. */
  zebra: (Color | null)[][] | null;
  dx: number;
  dy: number;
};

export type EditState = { boxes: Map<string, BoxEdit>; added: Map<string, AddedBox>; tables: Map<string, TableEdit> };

/** defineTable setups by page (the last one per table wins); they redefine the table before any other op. */
export function tableDefinitions(ops: EditOperation[]): Map<number, TableDefinition[]> {
  const last = new Map<string, Extract<EditOperation, { type: 'defineTable' }>>();
  ops.forEach((op, i) => {
    if (op.type !== 'defineTable') return;
    const err = setupError(op);
    if (err) throw new PdfError('INVALID_EDIT', `Op ${i}: ${err}`);
    last.set(op.tableId, op);
  });
  const out = new Map<number, TableDefinition[]>();
  for (const { type: _, pageIndex, ...def } of last.values()) {
    const list = out.get(pageIndex) ?? [];
    list.push(def);
    out.set(pageIndex, list);
  }
  return out;
}

export const tableBounds = (ys: number[], xs: number[]) => ({ x0: xs[0]!, y0: ys[ys.length - 1]!, x1: xs[xs.length - 1]!, y1: ys[0]! });

/** Row a new row copies: the given row when it is a plain body row, else the nearest one (any row when there is none). */
function templateRow(t: TableEdit, index: number): number {
  const plain = zebraRows(t.cells.length, t.headerRows, t.spans);
  return plain.sort((a, b) => Math.abs(a - index) - Math.abs(b - index) || b - a)[0] ?? index;
}

function initTable(orig: Table): TableEdit {
  return {
    tableId: orig.id,
    pageIndex: orig.pageIndex,
    deleted: false,
    ys: [...orig.rows.map((r) => r.y1), orig.rows[orig.rows.length - 1]!.y0],
    xs: [...orig.cols.map((c) => c.x0), orig.cols[orig.cols.length - 1]!.x1],
    cells: orig.rows.map((r) =>
      orig.cols.map((c) => {
        const cell = orig.cells.find((x) => x.row === r.index && x.col === c.index)!;
        return { text: cell.text, src: { row: r.index, col: c.index }, fill: cell.fill };
      }),
    ),
    spans: orig.cells.flatMap((c) => (c.rowSpan || c.colSpan ? [{ row: c.row, col: c.col, rowSpan: c.rowSpan ?? 1, colSpan: c.colSpan ?? 1 }] : [])),
    headerRows: headerRowsOf(orig),
    zebra: orig.pattern?.zebra?.map((row) => [...row]) ?? null,
    dx: 0,
    dy: 0,
  };
}

/** The original cell's minimum size while the cell still shows that content (a scanned cell set with setCellText no longer shows its scan). */
export function cellMinSize(cell: CellState, orig: Table): { min: NonNullable<Table['cells'][number]['minSize']>; image: boolean } | null {
  const o = cell.src && orig.cells.find((x) => x.row === cell.src!.row && x.col === cell.src!.col);
  if (!o?.minSize || (cell.edited && !o.images)) return null;
  return { min: o.minSize, image: !!o.images };
}

/** Narrowest width of column `c` (single-column cells only): the images or scanned ink its cells hold. */
function colMinWidth(t: TableEdit, orig: Table, c: number): number {
  const mesh = { vertices: [], spans: t.spans };
  return Math.max(
    0,
    ...t.cells.flatMap((row, r) => {
      const a = cellAnchor(mesh, r, c);
      const m = a.row === r && a.col === c && a.colSpan === 1 ? cellMinSize(row[c]!, orig) : null;
      return m ? [m.min.width] : [];
    }),
  );
}

/** `widths` scaled to sum to `total`, keeping each at least its `mins` entry (those at the minimum drop out of the scaling). Null when the minimums alone exceed `total`. */
function shrinkTo(widths: number[], mins: number[], total: number): number[] | null {
  if (mins.reduce((a, b) => a + b, 0) > total + 0.01) return null;
  const fixed = new Set<number>();
  for (;;) {
    const free = total - [...fixed].reduce((s, c) => s + mins[c]!, 0);
    const rest = widths.reduce((s, w, c) => (fixed.has(c) ? s : s + w), 0);
    const out = widths.map((w, c) => (fixed.has(c) ? mins[c]! : (w * free) / rest));
    const under = out.findIndex((w, c) => !fixed.has(c) && w < mins[c]! - 1e-9);
    if (under < 0) return out;
    fixed.add(under);
  }
}

/** Rejects a table state where a cell is smaller than the images or the scanned ink it holds (both are never scaled). */
function checkMinSizes(t: TableEdit, orig: Table, opIndex: number): void {
  const mesh = { vertices: [], spans: t.spans };
  t.cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      const m = cellMinSize(cell, orig);
      if (!m) return;
      const { min } = m;
      const a = cellAnchor(mesh, r, c);
      if (a.row !== r || a.col !== c) return;
      const w = t.xs[c + a.colSpan]! - t.xs[c]!;
      const h = t.ys[r]! - t.ys[r + a.rowSpan]!;
      if (w < min.width - 0.01 || h < min.height - 0.01) {
        throw new PdfError('INVALID_EDIT', `Op ${opIndex}: cell ${r + 1},${c + 1} holds ${m.image ? 'an image' : 'scanned content'} and can't be smaller than ${min.width.toFixed(1)} × ${min.height.toFixed(1)} pt (it would be ${w.toFixed(1)} × ${h.toFixed(1)} pt)`);
      }
    }),
  );
}

/** True when the table renders differently from the original. */
export function tableChanged(t: TableEdit, orig: Table): boolean {
  if (t.deleted || t.dx !== 0 || t.dy !== 0) return true;
  if (t.ys.length !== orig.rows.length + 1 || t.xs.length !== orig.cols.length + 1) return true;
  if (orig.rows.some((r, i) => t.ys[i] !== r.y1) || orig.cols.some((c, i) => t.xs[i] !== c.x0)) return true;
  return t.cells.some((row, r) =>
    row.some((cell, c) => {
      const o = orig.cells.find((x) => x.row === r && x.col === c);
      return !o || cell.src?.row !== r || cell.src.col !== c || cell.text !== o.text || (!!cell.edited && orig.setup?.origin === 'raster') || !!cell.style || cell.background !== undefined;
    }),
  );
}

/** Folds the ordered op list into the final state of every touched element. */
export function reduceEdits(pages: PageModel[], ops: EditOperation[]): EditState {
  const index = new Map<string, { box: TextBox; pageIndex: number }>();
  const tableIndex = new Map<string, Table>();
  for (const p of pages) {
    for (const b of p.textBoxes) index.set(b.id, { box: b, pageIndex: p.pageIndex });
    for (const t of p.tables) tableIndex.set(t.id, t);
  }
  const boxes = new Map<string, BoxEdit>();
  const added = new Map<string, AddedBox>();
  const tables = new Map<string, TableEdit>();
  const removed = new Set<string>();

  const target = (elementId: string, opIndex: number) => {
    const hit = index.get(elementId);
    if (!hit) throw new PdfError('INVALID_EDIT', `Op ${opIndex}: unknown element ${elementId}`);
    const cur = boxes.get(elementId) ?? { boxId: elementId, pageIndex: hit.pageIndex, deleted: false, dx: 0, dy: 0 };
    if (cur.deleted) throw new PdfError('INVALID_EDIT', `Op ${opIndex}: element ${elementId} was deleted`);
    return { cur, box: hit.box };
  };

  const tableOf = (tableId: string, opIndex: number): TableEdit => {
    if (removed.has(tableId)) throw new PdfError('INVALID_EDIT', `Op ${opIndex}: table ${tableId} was deleted`);
    let t = tables.get(tableId);
    if (t) return t;
    const orig = tableIndex.get(tableId);
    if (!orig) throw new PdfError('INVALID_EDIT', `Op ${opIndex}: unknown table ${tableId}`);
    t = initTable(orig);
    tables.set(tableId, t);
    return t;
  };

  const checkIndex = (n: number, max: number, what: string, opIndex: number) => {
    if (n >= max) throw new PdfError('INVALID_EDIT', `Op ${opIndex}: ${what} ${n} is out of range (${max})`);
  };

  ops.forEach((op, i) => {
    switch (op.type) {
      case 'replaceText': {
        const a = added.get(op.elementId);
        if (a) {
          a.text = op.text.replace(/\r\n?/g, '\n');
          break;
        }
        const { cur, box } = target(op.elementId, i);
        if (box.runs.some((r) => !r.decodable)) throw new PdfError('INVALID_EDIT', `Op ${i}: ${op.elementId} contains text that can't be decoded, so it can't be edited`);
        cur.text = op.text.replace(/\r\n?/g, '\n');
        if (op.overflow) cur.overflow = op.overflow;
        boxes.set(op.elementId, cur);
        break;
      }
      case 'addTextBox': {
        if (added.has(op.id) || index.has(op.id) || tableIndex.has(op.id)) throw new PdfError('INVALID_EDIT', `Op ${i}: element ${op.id} already exists`);
        if (op.pageIndex >= pages.length) throw new PdfError('INVALID_EDIT', `Op ${i}: page ${op.pageIndex} does not exist`);
        added.set(op.id, { id: op.id, pageIndex: op.pageIndex, bbox: op.bbox, text: op.text.replace(/\r\n?/g, '\n'), fontSize: op.fontSize, fontFamily: op.fontFamily, color: op.color, background: op.background });
        break;
      }
      case 'deleteElement': {
        if (added.delete(op.elementId)) break;
        if (tableIndex.has(op.elementId)) {
          tableOf(op.elementId, i).deleted = true;
          removed.add(op.elementId);
          break;
        }
        const { cur } = target(op.elementId, i);
        boxes.set(op.elementId, { ...cur, deleted: true, text: undefined });
        break;
      }
      case 'moveElement': {
        const a = added.get(op.elementId);
        if (a) {
          const w = op.width ?? a.bbox.x1 - a.bbox.x0;
          const h = op.height ?? a.bbox.y1 - a.bbox.y0;
          a.bbox = { x0: a.bbox.x0 + op.dx, x1: a.bbox.x0 + op.dx + w, y1: a.bbox.y1 + op.dy, y0: a.bbox.y1 + op.dy - h };
          if (op.background !== undefined) a.background = op.background;
          break;
        }
        if (tableIndex.has(op.elementId)) {
          if (op.width !== undefined || op.height !== undefined) throw new PdfError('INVALID_EDIT', `Op ${i}: tables are resized with resizeTable`);
          if (op.background !== undefined) throw new PdfError('INVALID_EDIT', `Op ${i}: tables have no text background`);
          const t = tableOf(op.elementId, i);
          t.dx += op.dx;
          t.dy += op.dy;
          break;
        }
        const { cur } = target(op.elementId, i);
        cur.dx += op.dx;
        cur.dy += op.dy;
        if (op.width !== undefined) cur.width = op.width;
        if (op.height !== undefined) cur.height = op.height;
        if (op.background !== undefined) cur.style = { ...cur.style, background: op.background };
        boxes.set(op.elementId, cur);
        break;
      }
      case 'tableInsertRow': {
        const t = tableOf(op.tableId, i);
        checkIndex(op.index, t.cells.length, 'row', i);
        const at = op.position === 'above' ? op.index : op.index + 1;
        const inHeader = at < t.headerRows;
        const tmpl = inHeader ? op.index : templateRow(t, op.index);
        const h = t.ys[tmpl]! - t.ys[tmpl + 1]!;
        const rowSpans = t.spans.filter((sp) => sp.row === tmpl && sp.rowSpan === 1);
        t.ys = [...t.ys.slice(0, at + 1), ...t.ys.slice(at).map((y) => y - h)];
        t.spans = spansInsertRow(t.spans, at);
        // The new row copies the template row's merged cells where no taller merged cell runs through it.
        for (const sp of rowSpans) {
          const free = !t.spans.some((o) => at >= o.row && at < o.row + o.rowSpan && sp.col < o.col + o.colSpan && o.col < sp.col + sp.colSpan);
          if (free) t.spans.push({ ...sp, row: at });
        }
        t.cells.splice(at, 0, t.cells[tmpl]!.map((c) => ({ text: '', fill: c.fill })));
        if (inHeader) t.headerRows++;
        break;
      }
      case 'tableDeleteRow': {
        const t = tableOf(op.tableId, i);
        checkIndex(op.index, t.cells.length, 'row', i);
        if (t.cells.length === 1) throw new PdfError('INVALID_EDIT', `Op ${i}: can't delete the last row; delete the table instead`);
        const h = t.ys[op.index]! - t.ys[op.index + 1]!;
        // A merged cell anchored in the deleted row keeps its content in the row under it.
        for (const sp of t.spans) if (sp.row === op.index && sp.rowSpan > 1) t.cells[op.index + 1]![sp.col] = t.cells[op.index]![sp.col]!;
        t.ys = [...t.ys.slice(0, op.index + 1), ...t.ys.slice(op.index + 2).map((y) => y + h)];
        t.cells.splice(op.index, 1);
        t.spans = spansDeleteRow(t.spans, op.index);
        if (op.index < t.headerRows) t.headerRows--;
        break;
      }
      case 'tableInsertCol': {
        const t = tableOf(op.tableId, i);
        checkIndex(op.index, t.xs.length - 1, 'column', i);
        const w = t.xs[op.index + 1]! - t.xs[op.index]!;
        const at = op.position === 'left' ? op.index : op.index + 1;
        const oldW = t.xs[t.xs.length - 1]! - t.xs[0]!;
        t.xs = [...t.xs.slice(0, at + 1), ...t.xs.slice(at).map((x) => x + w)];
        const over = t.xs[t.xs.length - 1]! + t.dx - pages[t.pageIndex]!.view.x1;
        if (over > 0.01) {
          if (op.fit !== 'shrink') throw new PdfError('INVALID_EDIT', `Op ${i}: the table would exceed the page width by ${over.toFixed(1)} pt; insert with fit 'shrink' to narrow the other columns`);
          if (w >= oldW) throw new PdfError('INVALID_EDIT', `Op ${i}: the new column alone is as wide as the table`);
          // The other columns shrink proportionally so the table keeps its width (their text wraps), except
          // that none gets narrower than the images or scanned ink it holds.
          const orig = tableIndex.get(t.tableId)!;
          const mins = t.cells[0]!.map((_, c) => colMinWidth(t, orig, c));
          const old = t.xs.slice(1).map((x, c) => x - t.xs[c]!).filter((_, c) => c !== at);
          const fitted = shrinkTo(old, mins, oldW - w);
          if (!fitted) throw new PdfError('INVALID_EDIT', `Op ${i}: the other columns can't shrink enough: their images or scanned content need ${mins.reduce((a, b) => a + b, 0).toFixed(1)} pt, ${(oldW - w).toFixed(1)} pt are left`);
          const widths = [...fitted.slice(0, at), w, ...fitted.slice(at)];
          t.xs = widths.reduce((xs, cw) => [...xs, xs[xs.length - 1]! + cw], [t.xs[0]!]);
        }
        // Row fills (e.g. a header band) extend into the new column.
        for (const row of t.cells) row.splice(at, 0, { text: '', fill: row[op.index]!.fill });
        for (const row of t.zebra ?? []) row.splice(at, 0, row[op.index]!);
        t.spans = spansInsertCol(t.spans, at);
        checkMinSizes(t, tableIndex.get(t.tableId)!, i);
        break;
      }
      case 'tableDeleteCol': {
        const t = tableOf(op.tableId, i);
        checkIndex(op.index, t.xs.length - 1, 'column', i);
        if (t.xs.length === 2) throw new PdfError('INVALID_EDIT', `Op ${i}: can't delete the last column; delete the table instead`);
        const w = t.xs[op.index + 1]! - t.xs[op.index]!;
        t.xs = [...t.xs.slice(0, op.index + 1), ...t.xs.slice(op.index + 2).map((x) => x - w)];
        for (const sp of t.spans) if (sp.col === op.index && sp.colSpan > 1) t.cells[sp.row]![op.index + 1] = t.cells[sp.row]![op.index]!;
        for (const row of t.cells) row.splice(op.index, 1);
        for (const row of t.zebra ?? []) row.splice(op.index, 1);
        t.spans = spansDeleteCol(t.spans, op.index);
        break;
      }
      case 'setCellText': {
        const t = tableOf(op.tableId, i);
        checkIndex(op.row, t.cells.length, 'row', i);
        checkIndex(op.col, t.xs.length - 1, 'column', i);
        const anchor = cellAnchor({ vertices: [], spans: t.spans }, op.row, op.col);
        const cell = t.cells[anchor.row]![anchor.col]!;
        cell.text = op.text.replace(/\r\n?/g, '\n');
        cell.edited = true;
        const style = { ...cell.style, ...(op.fontFamily && { fontFamily: op.fontFamily }), ...(op.fontSize && { fontSize: op.fontSize }), ...(op.color && { color: op.color }) };
        if (Object.keys(style).length) cell.style = style;
        if (op.background !== undefined) cell.background = op.background;
        break;
      }
      case 'resizeTable': {
        const t = tableOf(op.tableId, i);
        if (op.rowHeights) {
          if (op.rowHeights.length !== t.cells.length) throw new PdfError('INVALID_EDIT', `Op ${i}: expected ${t.cells.length} row heights`);
          t.ys = op.rowHeights.reduce((ys, h) => [...ys, ys[ys.length - 1]! - h], [t.ys[0]!]);
        }
        if (op.colWidths) {
          if (op.colWidths.length !== t.xs.length - 1) throw new PdfError('INVALID_EDIT', `Op ${i}: expected ${t.xs.length - 1} column widths`);
          t.xs = op.colWidths.reduce((xs, w) => [...xs, xs[xs.length - 1]! + w], [t.xs[0]!]);
        }
        checkMinSizes(t, tableIndex.get(t.tableId)!, i);
        break;
      }
      case 'setTextStyle': {
        const style = { ...(op.color && { color: op.color }), ...(op.align && { align: op.align }), ...(op.lineSpacing !== undefined && { lineSpacing: op.lineSpacing }), ...(op.background !== undefined && { background: op.background }) };
        const a = added.get(op.elementId);
        if (a) {
          Object.assign(a, style);
          break;
        }
        const { cur, box } = target(op.elementId, i);
        // A fill underneath needs no new glyphs, so undecodable text can still get one.
        const restyled = op.color || op.align || op.lineSpacing !== undefined;
        if (restyled && box.runs.some((r) => !r.decodable)) throw new PdfError('INVALID_EDIT', `Op ${i}: ${op.elementId} contains text that can't be decoded, so it can't be restyled`);
        cur.style = { ...cur.style, ...style };
        boxes.set(op.elementId, cur);
        break;
      }
      case 'setPageFlow':
      case 'scanLayout':
      case 'tableContinuation':
      case 'arrangePages':
      case 'deskewPage':
        // Read by applyEdits for the page flow.
        break;
      case 'defineTable':
        // Applied during page analysis (tableDefinitions); the table must exist by now.
        if (!tableIndex.has(op.tableId)) throw new PdfError('INVALID_EDIT', `Op ${i}: unknown table ${op.tableId}`);
        break;
    }
  });

  for (const [id, t] of tables) if (!t.deleted && !tableChanged(t, tableIndex.get(id)!)) tables.delete(id);
  for (const [id, cur] of boxes) {
    const box = index.get(id)!.box;
    if (!cur.deleted && cur.text === box.text && !cur.overflow && cur.dx === 0 && cur.dy === 0 && cur.width === undefined && cur.height === undefined && !cur.style) boxes.delete(id);
  }

  return { boxes, added, tables };
}

/** Content under a table that moves with the change of the table's bottom edge (not with its move or deletion). */
export type Reflow = { tableId: string; pageIndex: number; area: Rect; shift: number };

/**
 * Shifts the text boxes and tables right under every table whose bottom edge changed (row inserts,
 * deletes, growth) by that change, and returns the areas so paths and images there can follow.
 * Run it once, after row growth.
 */
export function reflowBelow(pages: PageModel[], state: EditState): Reflow[] {
  const out: Reflow[] = [];
  const index = new Map(pages.flatMap((p) => p.tables.map((t) => [t.id, t] as const)));
  for (const t of [...state.tables.values()]) {
    if (t.deleted) continue;
    const orig = index.get(t.tableId)!;
    const shift = tableBounds(t.ys, t.xs).y0 - orig.bbox.y0;
    if (Math.abs(shift) < 0.01) continue;
    out.push({ tableId: t.tableId, pageIndex: t.pageIndex, area: orig.bbox, shift });
    const below = (r: Rect) => r.y1 <= orig.bbox.y0 + 1;
    const page = pages[t.pageIndex]!;
    for (const b of page.textBoxes) {
      if (!below(b.bbox)) continue;
      const cur = state.boxes.get(b.id) ?? { boxId: b.id, pageIndex: t.pageIndex, deleted: false, dx: 0, dy: 0 };
      if (cur.deleted) continue;
      cur.dy += shift;
      state.boxes.set(b.id, cur);
    }
    for (const o of page.tables) {
      if (o.id === t.tableId || !below(o.bbox)) continue;
      const other = state.tables.get(o.id) ?? initTable(o);
      if (other.deleted) continue;
      other.dy += shift;
      state.tables.set(o.id, other);
    }
  }
  return out;
}
