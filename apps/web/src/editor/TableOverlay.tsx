import { useState } from 'react';
import { inkFontSize, type Cell, type Color, type Table } from '@pdf-toolkit/shared';
import type { PdfDoc } from '../lib/pdfjs.ts';
import { FontPicker } from './FontPicker.tsx';
import { MIN_CELL, fromHex, minCellSize, toHex } from './Inspector.tsx';
import { TextEditor, stepCell, toCss, type Viewport } from './PageView.tsx';
import { GuideLines, Readout, snapLine, snapRect, snapTargets, type Guides } from './snap.tsx';
import { useEditor } from './store.ts';
import { gridOf, setupDraft } from './TableSetup.tsx';

function Toolbar({ table, row, col, css }: { table: Table; row: number; col: number; css: ReturnType<typeof toCss> }) {
  const { edit, busy, pages, setPrompt } = useEditor();
  const id = table.id;
  const run = (op: Parameters<typeof edit>[0][number]) => {
    // A column copies the width of the one it is inserted next to; past the page edge the user chooses.
    if (op.type === 'tableInsertCol') {
      const c = table.cols[op.index]!;
      const by = table.bbox.x1 + (c.x1 - c.x0) - (pages[table.pageIndex]?.view.x1 ?? Infinity);
      if (by > 0.01) return setPrompt({ kind: 'colFit', by, op });
    }
    void edit([op]);
  };
  const btn = (label: string, title: string, op: Parameters<typeof edit>[0][number], disabled = false) => (
    <button key={title} title={title} disabled={busy || disabled} className="rounded px-1.5 py-0.5 hover:bg-slate-100 disabled:opacity-40" onClick={(e) => (e.stopPropagation(), run(op))}>
      {label}
    </button>
  );
  return (
    <div className="absolute z-20 flex gap-0.5 rounded border border-slate-300 bg-white px-1 py-0.5 text-xs shadow" style={{ left: css.left, top: css.top - 30 }} onClick={(e) => e.stopPropagation()} data-testid="table-toolbar">
      <span className="px-1 text-slate-500">
        R{row + 1} C{col + 1}
      </span>
      {btn('+↑', 'Insert row above', { type: 'tableInsertRow', tableId: id, index: row, position: 'above' })}
      {btn('+↓', 'Insert row below', { type: 'tableInsertRow', tableId: id, index: row, position: 'below' })}
      {btn('−row', 'Delete row', { type: 'tableDeleteRow', tableId: id, index: row }, table.rows.length < 2)}
      <span className="mx-0.5 border-l border-slate-200" />
      {btn('+←', 'Insert column left', { type: 'tableInsertCol', tableId: id, index: col, position: 'left' })}
      {btn('+→', 'Insert column right', { type: 'tableInsertCol', tableId: id, index: col, position: 'right' })}
      {btn('−col', 'Delete column', { type: 'tableDeleteCol', tableId: id, index: col }, table.cols.length < 2)}
      <span className="mx-0.5 border-l border-slate-200" />
      {btn('✕ table', 'Delete table', { type: 'deleteElement', elementId: id })}
    </div>
  );
}

type CellStyle = { fontFamily?: string; fontSize?: number; color?: Color; background?: Color | null };

const BLACK: Color = { space: 'gray', values: [0] };
const WHITE: Color = { space: 'gray', values: [1] };

/** What the server uses for unset fields: the column style, or for a scanned cell the measured ink and a size from the tallest ink line (the server's estimate). */
function cellAuto(table: Table, c: Cell): { fontFamily: string; fontSize?: number; color: Color; background: Color | null } {
  const look = table.setup?.origin === 'raster' ? table.setup.raster : undefined;
  const boxes = look?.inkBoxes ?? [];
  const inCol = boxes.flatMap((row) => (row[c.col] ? [inkFontSize(row[c.col]!)] : []));
  const sizes = inCol.length ? inCol : boxes.flat().flatMap((b) => (b ? [inkFontSize(b)] : []));
  return {
    fontFamily: look ? 'Helvetica' : 'Column style',
    ...(sizes.length && { fontSize: Math.max(...sizes) }),
    color: look?.ink ?? BLACK,
    background: c.fill ?? (look ? (look.fills?.[c.row]?.[c.col] ?? null) : null),
  };
}

/** Cell text editor with a style bar (font, size, colour, fill); only the fields the user changed are sent. */
function CellEditor({ table, c, vp, zoom, pdf }: { table: Table; c: Cell; vp: Viewport; zoom: number; pdf: PdfDoc }) {
  const { edit, editCell, pages, revision } = useEditor();
  const [style, setStyle] = useState<CellStyle>({});
  const auto = cellAuto(table, c);
  const changed = Object.keys(style).length > 0;
  const cc = toCss(vp, c.bbox);
  const h = (c.bbox.y1 - c.bbox.y0) * zoom;
  const op = (text: string) => ({ type: 'setCellText' as const, tableId: table.id, row: c.row, col: c.col, text, ...style });
  const bg = style.background !== undefined ? style.background : auto.background;
  return (
    <TextEditor
      text={c.text}
      css={cc}
      style={{ fontSize: Math.min((style.fontSize ?? auto.fontSize ?? 11) * zoom, h * 0.6), lineHeight: 1.2 }}
      toolbar={
        <>
          <FontPicker pdf={pdf} pages={pages} revision={revision} value={style} auto={auto} onChange={(s) => setStyle((x) => ({ ...x, ...s }))} />
          <input type="color" title="Text colour" data-testid="cell-color" value={toHex(style.color ?? auto.color)} className="h-7 w-8 cursor-pointer rounded border border-slate-300" onChange={(e) => setStyle((x) => ({ ...x, color: fromHex(e.target.value) }))} />
          <label className="flex items-center gap-1" title="Cell fill">
            <input type="checkbox" checked={!!bg} data-testid="cell-fill" onChange={(e) => setStyle((x) => ({ ...x, background: e.target.checked ? (auto.background ?? WHITE) : null }))} />
            Fill
          </label>
          <input type="color" title="Cell fill colour" disabled={!bg} data-testid="cell-fill-color" value={toHex(bg ?? WHITE)} className="h-7 w-8 cursor-pointer rounded border border-slate-300 disabled:opacity-40" onChange={(e) => setStyle((x) => ({ ...x, background: fromHex(e.target.value) }))} />
        </>
      }
      onDone={(text) => {
        // A scanned cell shows the scan until it is set, so committing it empty blanks it.
        if (text === null || (text === c.text && !changed && !(table.setup?.origin === 'raster' && text === ''))) return editCell(null);
        void edit([op(text)]);
      }}
      onTab={(text, back) => {
        const here = { tableId: table.id, row: c.row, col: c.col };
        const model = pages[table.pageIndex];
        const next = model ? stepCell(model, here, back ? -1 : 1) : here;
        if (text === c.text && !changed) return editCell(next);
        void edit([op(text)], () => editCell(next));
      }}
    />
  );
}

/** rowSize/colSize: border drags that resize a row or column. */
type Drag = { kind: 'move' | 'rowSize' | 'colSize'; index: number; x0: number; y0: number; dx: number; dy: number; guides?: Guides };


export function TableOverlay({ table, vp, zoom, pdf }: { table: Table; vp: Viewport; zoom: number; pdf: PdfDoc }) {
  const { cell, editingCell, tool, pages, selectedId, nudge, select, selectCell, editCell, edit, reports, startSetup } = useEditor();
  const [drag, setDrag] = useState<Drag | null>(null);
  const css = toCss(vp, table.bbox);
  const { ys, xs } = gridOf(table);
  const setupMode = tool === 'table';
  const mine = (c: { tableId: string } | null) => c?.tableId === table.id;

  const toPdf = (dx: number, dy: number) => {
    const [ax, ay] = vp.convertToPdfPoint(0, 0);
    const [bx, by] = vp.convertToPdfPoint(dx, dy);
    return [bx - ax, by - ay] as const;
  };

  const startDrag = (e: React.MouseEvent, kind: Drag['kind'], index: number) => {
    e.stopPropagation();
    e.preventDefault();
    const d: Drag = { kind, index, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0 };
    setDrag(d);
    const model = pages[table.pageIndex];
    const targets = (kind === 'move' || kind === 'rowSize' || kind === 'colSize') && model ? snapTargets(model, vp, table.id) : null;
    // Border being resized, in overlay px.
    const [lineX, lineY] = kind === 'colSize' ? vp.convertToViewportPoint(xs[index]!, ys[0]!) : kind === 'rowSize' ? vp.convertToViewportPoint(xs[0]!, ys[index]!) : [0, 0];
    let last = d;
    const move = (ev: MouseEvent) => {
      let dx = ev.clientX - d.x0;
      let dy = ev.clientY - d.y0;
      let guides: Guides | undefined;
      if (targets && !ev.altKey) {
        if (kind === 'move') {
          const s = snapRect({ ...css, left: css.left + dx, top: css.top + dy }, targets);
          dx += s.dx;
          dy += s.dy;
          guides = s.guides;
        } else if (kind === 'colSize') {
          const s = snapLine(lineX + dx, targets.xs);
          dx += s.d;
          guides = { x: s.at, y: null };
        } else {
          const s = snapLine(lineY + dy, targets.ys);
          dy += s.d;
          guides = { x: null, y: s.at };
        }
      }
      last = { ...d, dx, dy, guides };
      setDrag(last);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDrag(null);
      const [px, py] = toPdf(last.dx, last.dy);
      if (Math.hypot(last.dx, last.dy) < 3) return;
      if (kind === 'move') void edit([{ type: 'moveElement', elementId: table.id, dx: px, dy: py }]);
      else if (kind === 'colSize') void edit([{ type: 'resizeTable', tableId: table.id, colWidths: sizes('col', index, px) }]);
      else void edit([{ type: 'resizeTable', tableId: table.id, rowHeights: sizes('row', index, py) }]);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const minOf = (axis: 'row' | 'col', i: number) => minCellSize(table, axis, i);
  /** Row heights / column widths after dragging border `index` (1 = below the first row / right of the first column) by a PDF delta. */
  const sizes = (axis: 'row' | 'col', index: number, delta: number) =>
    axis === 'col'
      ? xs.slice(1).map((x, i) => Math.max(minOf('col', i), x - xs[i]! + (i === index - 1 ? delta : 0)))
      : ys.slice(1).map((y, i) => Math.max(minOf('row', i), ys[i]! - y - (i === index - 1 ? delta : 0)));
  const sizeReadout = (d: Drag) => {
    const [px, py] = toPdf(d.dx, d.dy);
    const axis = d.kind === 'colSize' ? 'col' : 'row';
    const size = sizes(axis, d.index, axis === 'col' ? px : py)[d.index - 1]!;
    const min = minOf(axis, d.index - 1);
    const why = table.setup?.origin === 'raster' ? 'ink' : 'image';
    return `${axis} ${d.index}: ${size.toFixed(1)} pt${min > MIN_CELL && size <= min + 1e-6 ? ` (min ${min.toFixed(1)} pt: ${why})` : ''}`;
  };
  const resizable = tool === 'select' && !editingCell;

  const n = nudge?.id === table.id ? (() => {
    const [ax, ay] = vp.convertToViewportPoint(0, 0);
    const [bx, by] = vp.convertToViewportPoint(nudge.dx, nudge.dy);
    return { dx: bx - ax, dy: by - ay };
  })() : null;
  const offset = drag?.kind === 'move' ? { transform: `translate(${drag.dx}px, ${drag.dy}px)` } : n ? { transform: `translate(${n.dx}px, ${n.dy}px)` } : {};
  const tableSelected = selectedId === table.id;
  const sel = mine(cell) ? cell! : null;

  return (
    <>
      <div className={`pointer-events-none absolute ${tableSelected ? 'outline-2 outline-offset-2 outline-violet-600' : ''}`} style={{ ...css, ...offset }} data-testid="table" data-table-id={table.id}>
        <div
          title="Drag to move the table, click to select it (arrow keys nudge, Delete removes)"
          data-testid="table-handle"
          className="pointer-events-auto absolute -top-4 -left-4 h-3.5 w-3.5 cursor-move rounded-sm bg-violet-500 text-[9px] leading-3.5 text-white"
          onMouseDown={(e) => tool === 'select' && startDrag(e, 'move', 0)}
          onClick={(e) => {
            e.stopPropagation();
            if (tool === 'select') select(table.id);
          }}
        />
        {setupMode && (
          <button
            type="button"
            data-testid="table-setup-start"
            title="Set up this table: rows, columns, border, then align the vertices"
            className="pointer-events-auto absolute inset-0 z-10 cursor-pointer bg-violet-400/10 outline-2 outline-dashed outline-violet-500 hover:bg-violet-400/20"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const model = pages[table.pageIndex];
              if (model) void setupDraft(pdf, model, table.bbox, table).then(startSetup);
            }}
          >
            <span className="absolute -top-5 right-0 rounded bg-violet-600 px-1 text-[10px] leading-4 text-white">{table.setup ? 'Edit setup' : 'Set up table'}</span>
          </button>
        )}
        {n && <Readout left={0} top={-6} text={`x ${(table.bbox.x0 + nudge!.dx).toFixed(1)}  y ${(table.bbox.y1 + nudge!.dy).toFixed(1)} pt`} />}
        {table.cells.map((c) => {
          if (c.covered) return null;
          const cc = toCss(vp, c.bbox);
          const isSel = sel?.row === c.row && sel.col === c.col;
          const report = reports.find((r) => r.elementId === `${table.id}:${c.row},${c.col}`);
          return (
            <div
              key={`${c.row},${c.col}`}
              data-testid="table-cell"
              title={report ? `${report.strategy}${report.warnings.length ? '\n' + report.warnings.join('\n') : ''}` : 'Click to select, double-click to edit'}
              className={`pointer-events-auto absolute border border-dashed ${isSel ? 'border-violet-600 bg-violet-500/15' : 'border-violet-400/50 hover:bg-violet-400/10'} ${report?.strategy === 'none' ? 'bg-red-500/20' : ''}`}
              style={{ left: cc.left - css.left, top: cc.top - css.top, width: cc.width, height: cc.height }}
              onClick={(e) => {
                e.stopPropagation();
                selectCell({ tableId: table.id, row: c.row, col: c.col });
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                editCell({ tableId: table.id, row: c.row, col: c.col });
              }}
            />
          );
        })}
        {resizable &&
          ys.slice(1).map((y, k) => {
            const i = k + 1;
            const [, top] = vp.convertToViewportPoint(xs[0]!, y);
            const active = drag?.kind === 'rowSize' && drag.index === i;
            return (
              <div
                key={`rs${i}`}
                data-testid="row-border"
                title="Drag to change this row's height"
                className={`pointer-events-auto absolute z-10 h-1.5 w-full -translate-y-1/2 cursor-row-resize ${active ? 'bg-sky-500' : 'hover:bg-sky-500/60'}`}
                style={{ top: top - css.top + (active ? drag.dy : 0), left: 0 }}
                onMouseDown={(e) => startDrag(e, 'rowSize', i)}
                onClick={(e) => e.stopPropagation()}
              />
            );
          })}
        {resizable &&
          xs.slice(1).map((x, k) => {
            const i = k + 1;
            const [left] = vp.convertToViewportPoint(x, ys[0]!);
            const active = drag?.kind === 'colSize' && drag.index === i;
            return (
              <div
                key={`cs${i}`}
                data-testid="col-border"
                title="Drag to change this column's width"
                className={`pointer-events-auto absolute top-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize ${active ? 'bg-sky-500' : 'hover:bg-sky-500/60'}`}
                style={{ left: left - css.left + (active ? drag.dx : 0) }}
                onMouseDown={(e) => startDrag(e, 'colSize', i)}
                onClick={(e) => e.stopPropagation()}
              />
            );
          })}
        {drag && (drag.kind === 'colSize' || drag.kind === 'rowSize') && <Readout left={0} top={-6} text={sizeReadout(drag)} />}
        {drag?.kind === 'move' && Math.hypot(drag.dx, drag.dy) >= 3 && (() => {
          const [px, py] = toPdf(drag.dx, drag.dy);
          return <Readout left={0} top={-6} text={`x ${(table.bbox.x0 + px).toFixed(1)}  y ${(table.bbox.y1 + py).toFixed(1)} pt`} />;
        })()}
      </div>
      {drag?.guides && <GuideLines guides={drag.guides} vp={vp} />}
      {sel && !setupMode && !editingCell && <Toolbar table={table} row={sel.row} col={sel.col} css={css} />}
      {mine(editingCell) &&
        (() => {
          const c = table.cells.find((x) => x.row === editingCell!.row && x.col === editingCell!.col)!;
          return (
            <CellEditor key={`${c.row},${c.col}`} table={table} c={c} vp={vp} zoom={zoom} pdf={pdf} />
          );
        })()}
    </>
  );
}
