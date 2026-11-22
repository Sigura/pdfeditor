import { useEffect, useMemo, useState } from 'react';
import type { Align, Color, EditOperation, Table, TextBox } from '@pdf-toolkit/shared';
import { detectBackground, fillOf, moveOp } from './background.ts';
import { ChangesList } from './Changes.tsx';
import { cssColor } from './PageView.tsx';
import { pageNo, useEditor } from './store.ts';

/** Number input that commits on Enter or blur, only when the value changed. */
export const MIN_CELL = 4;

/** Smallest size of a row / column: cells holding an image or scanned ink can't get smaller than it (neither is ever scaled). */
export const minCellSize = (table: Table, axis: 'row' | 'col', i: number) =>
  Math.max(MIN_CELL, ...table.cells.filter((c) => c.minSize && (axis === 'row' ? c.row === i && (c.rowSpan ?? 1) === 1 : c.col === i && (c.colSpan ?? 1) === 1)).map((c) => (axis === 'row' ? c.minSize!.height : c.minSize!.width)));

function NumField({ label, value, onCommit, step = 0.5, min, testId }: { label: string; value: number; onCommit?: (v: number) => void; step?: number; min?: number; testId?: string }) {
  const shown = Number(value.toFixed(2));
  const [text, setText] = useState(String(shown));
  const [rejected, setRejected] = useState<string>();
  useEffect(() => setText(String(shown)), [shown]);
  useEffect(() => {
    if (!rejected) return;
    const t = setTimeout(() => setRejected(undefined), 2500);
    return () => clearTimeout(t);
  }, [rejected]);
  const commit = () => {
    const v = Number(text);
    const bad = text.trim() === '' || !Number.isFinite(v) ? `“${text}” is not a number` : min !== undefined && v < min - 1e-6 ? `At least ${min.toFixed(1)} pt` : undefined;
    if (bad || Math.abs(v - shown) < 1e-3) {
      setRejected(bad);
      return setText(String(shown));
    }
    onCommit?.(v);
  };
  return (
    <label className="relative flex items-center gap-1">
      <span className="w-5 text-slate-500">{label}</span>
      <input
        type="number"
        step={step}
        disabled={!onCommit}
        title={min !== undefined ? `min ${min.toFixed(1)} pt` : undefined}
        aria-invalid={rejected ? true : undefined}
        data-testid={testId}
        className={`w-full min-w-0 rounded border px-1 py-0.5 tabular-nums disabled:bg-slate-50 disabled:text-slate-500 ${rejected ? 'border-red-500 ring-2 ring-red-300' : 'border-slate-300'}`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setRejected(undefined);
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      />
      {rejected && (
        <span role="status" data-testid="numfield-rejected" className="absolute top-full left-5 z-10 mt-0.5 rounded bg-red-600 px-1 text-[10px] whitespace-nowrap text-white">
          {rejected}, kept {shown}
        </span>
      )}
    </label>
  );
}

export const toHex = (c: Color) => '#' + (cssColor(c).match(/\d+/g) ?? ['0', '0', '0']).map((v) => Number(v).toString(16).padStart(2, '0')).join('');
export const fromHex = (h: string): Color => ({ space: 'rgb', values: [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) });

const WHITE: Color = { space: 'gray', values: [1] };

const Swatch = ({ c, testId }: { c: Color; testId?: string }) => (
  <span className="inline-flex items-center gap-1" data-testid={testId}>
    <span className="inline-block h-3 w-3 rounded-sm border border-slate-300" style={{ background: cssColor(c) }} />
    <span className="tabular-nums">{toHex(c)}</span>
  </span>
);

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="flex gap-2">
    <span className="w-14 shrink-0 text-slate-500">{k}</span>
    <span className="min-w-0 break-words">{children}</span>
  </div>
);

function BoxInspector({ box }: { box: TextBox }) {
  const { ops, reports, busy, edit, startEditing, pages, pageIndex, renderCount } = useEditor();
  const run = box.runs[0];
  const added = ops.find((o): o is Extract<EditOperation, { type: 'addTextBox' }> => o.type === 'addTextBox' && o.id === box.id);
  const size = run ? run.fontSize * Math.hypot(run.matrix[2], run.matrix[3]) : (added?.fontSize ?? box.lineHeight / 1.2);
  const style = ops.reduce<{ color?: Color; align?: Align; lineSpacing?: number }>((s, o) => (o.type === 'setTextStyle' && o.elementId === box.id ? { ...s, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) } : s), {});
  const color = style.color ?? (run ? run.color : (added?.color ?? { space: 'gray', values: [0] }));
  const align = style.align ?? box.align;
  const spacing = style.lineSpacing ?? box.lineHeight / size;
  const report = reports.find((r) => r.elementId === box.id);
  const editable = box.runs.every((r) => r.decodable);
  const restyle = (s: Omit<Extract<EditOperation, { type: 'setTextStyle' }>, 'type' | 'elementId'>) => void edit([{ type: 'setTextStyle', elementId: box.id, ...s }]);
  const { x0, y0, x1, y1 } = box.bbox;
  const model = pages[pageIndex];
  // renderCount: pixel detection reads the canvas, which changes after each render.
  const detected = useMemo(() => (model ? detectBackground(model, box.bbox) : null), [model, box.bbox, renderCount]);
  const fill = fillOf(ops, box.id);
  const move = (dx: number, dy: number) => void edit([model ? moveOp(model, ops, box.id, dx, dy) : { type: 'moveElement', elementId: box.id, dx, dy }]);

  return (
    <div className="space-y-3" data-testid="inspector-box">
      <div className="space-y-1">
        <Row k="Font">{run ? run.fontName : (added?.fontFamily ?? 'Helvetica')}</Row>
        <Row k="Size">{size.toFixed(1)} pt</Row>
        {report && (
          <Row k="Strategy">
            <span className={report.strategy === 'none' ? 'text-red-700' : ''}>{report.strategy}</span>
            {report.substituteFont && <span className="text-slate-500"> ({report.substituteFont})</span>}
          </Row>
        )}
        {report?.warnings.map((w) => (
          <p key={w} className="text-[11px] text-amber-700">
            ⚠ {w}
          </p>
        ))}
      </div>
      <div>
        <div className="mb-1 text-[11px] font-medium tracking-wide text-slate-500 uppercase">Position (pt, top-left)</div>
        <div className="grid grid-cols-2 gap-1">
          <NumField label="X" value={x0} testId="insp-x" onCommit={busy ? undefined : (v) => move(v - x0, 0)} />
          <NumField label="Y" value={y1} testId="insp-y" onCommit={busy ? undefined : (v) => move(0, v - y1)} />
          <NumField label="W" value={x1 - x0} min={5} testId="insp-w" onCommit={busy ? undefined : (v) => void edit([{ type: 'moveElement', elementId: box.id, dx: 0, dy: 0, width: v }])} />
          <NumField label="H" value={y1 - y0} />
        </div>
      </div>
      <div className="space-y-1">
        <div className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">Colours</div>
        <Row k="Text">
          <Swatch c={color} testId="insp-text-color" />
        </Row>
        <Row k="Behind">
          {detected ? (
            <span data-testid="insp-bg-detected" data-source={detected.source}>
              <Swatch c={detected.color} /> <span className="text-slate-500">({detected.source === 'shape' ? 'shape' : 'pixels'})</span>
            </span>
          ) : (
            <span className="text-slate-400">unknown</span>
          )}
        </Row>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={!!fill} disabled={busy} data-testid="insp-fill" onChange={(e) => restyle({ background: e.target.checked ? (detected?.color ?? WHITE) : null })} />
            Fill under text
          </label>
          <input
            type="color"
            value={toHex(fill ?? detected?.color ?? WHITE)}
            disabled={busy || !fill}
            data-testid="insp-fill-color"
            title="Fill colour"
            className="h-6 w-8 cursor-pointer rounded border border-slate-300 disabled:cursor-default disabled:opacity-40"
            onChange={(e) => restyle({ background: fromHex(e.target.value) })}
          />
        </div>
        <p className="text-[11px] text-slate-500">Moved and new text gets a fill when it lands on a coloured area.</p>
      </div>
      {editable && (
        <div className="space-y-2">
          <div className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">Text</div>
          <div className="flex items-center gap-2">
            <input type="color" value={toHex(color)} disabled={busy} data-testid="insp-color" className="h-7 w-9 cursor-pointer rounded border border-slate-300" onChange={(e) => restyle({ color: fromHex(e.target.value) })} />
            <div className="flex rounded border border-slate-300" data-testid="insp-align">
              {(['left', 'center', 'right', 'justify'] as const).map((a) => (
                <button key={a} disabled={busy} title={`Align ${a}`} className={`px-1.5 py-0.5 ${align === a ? 'bg-sky-600 text-white' : 'hover:bg-slate-100'}`} onClick={() => align !== a && restyle({ align: a })}>
                  {{ left: '⇤', center: '↔', right: '⇥', justify: '☰' }[a]}
                </button>
              ))}
            </div>
          </div>
          <NumField label="↕" value={spacing} step={0.1} min={0.5} testId="insp-spacing" onCommit={busy ? undefined : (v) => restyle({ lineSpacing: Math.min(5, v) })} />
          <p className="text-[11px] text-slate-500">↕ line spacing, × font size</p>
          <button className="w-full rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" onClick={() => startEditing(box.id)}>
            Edit text…
          </button>
        </div>
      )}
      {!editable && <p className="text-[11px] text-amber-700">This text can't be decoded, so it can only be moved or deleted.</p>}
    </div>
  );
}

function CellInspector() {
  const { cell, pages, pageIndex, busy, edit, editCell } = useEditor();
  const table = pages[pageIndex]?.tables.find((t) => t.id === cell?.tableId);
  if (!cell || !table) return null;
  const c = table.cells.find((x) => x.row === cell.row && x.col === cell.col);
  const widths = table.cols.map((k) => k.x1 - k.x0);
  const heights = table.rows.map((r) => r.y1 - r.y0);
  const { x0, y1 } = table.bbox;
  return (
    <div className="space-y-3" data-testid="inspector-cell">
      <div className="space-y-1">
        <Row k="Table">
          {table.rows.length} × {table.cols.length}
          {table.bordered ? '' : ', borderless'}
        </Row>
        <Row k="Cell">
          R{cell.row + 1} C{cell.col + 1}
        </Row>
        <Row k="Text">{c?.text || <span className="text-slate-400">empty</span>}</Row>
      </div>
      <div>
        <div className="mb-1 text-[11px] font-medium tracking-wide text-slate-500 uppercase">Table position (pt)</div>
        <div className="grid grid-cols-2 gap-1">
          <NumField label="X" value={x0} onCommit={busy ? undefined : (v) => void edit([{ type: 'moveElement', elementId: table.id, dx: v - x0, dy: 0 }])} />
          <NumField label="Y" value={y1} onCommit={busy ? undefined : (v) => void edit([{ type: 'moveElement', elementId: table.id, dx: 0, dy: v - y1 }])} />
        </div>
      </div>
      <div>
        <div className="mb-1 text-[11px] font-medium tracking-wide text-slate-500 uppercase">Cell size (pt)</div>
        <div className="grid grid-cols-2 gap-1">
          <NumField label="W" value={widths[cell.col]!} min={minCellSize(table, 'col', cell.col)} testId="insp-col-width" onCommit={busy ? undefined : (v) => void edit([{ type: 'resizeTable', tableId: table.id, colWidths: widths.map((w, i) => (i === cell.col ? v : w)) }])} />
          <NumField label="H" value={heights[cell.row]!} min={minCellSize(table, 'row', cell.row)} testId="insp-row-height" onCommit={busy ? undefined : (v) => void edit([{ type: 'resizeTable', tableId: table.id, rowHeights: heights.map((h, i) => (i === cell.row ? v : h)) }])} />
        </div>
      </div>
      <button className="w-full rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" onClick={() => editCell(cell)}>
        Edit cell text…
      </button>
    </div>
  );
}

export function Inspector() {
  const { pages, pageIndex, selectedId, cell, ops } = useEditor();
  const model = pages[pageIndex];
  const box = model?.textBoxes.find((b) => b.id === selectedId);
  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-slate-200 bg-white text-xs" data-testid="inspector">
      <div className="border-b border-slate-200 px-3 py-2 font-medium">Inspector</div>
      <div className="max-h-[55%] overflow-y-auto px-3 py-3">
        {box ? (
          <BoxInspector key={box.id} box={box} />
        ) : cell ? (
          <CellInspector />
        ) : (
          <div className="space-y-1 text-slate-500">
            {model && (
              <Row k="Page">
                {pageNo({ ops, pages }, pageIndex)}: {(model.view.x1 - model.view.x0).toFixed(0)} × {(model.view.y1 - model.view.y0).toFixed(0)} pt
              </Row>
            )}
            <p>Select a text box or a table cell to see its properties.</p>
            <p className="pt-2">
              Press <kbd className="rounded border border-slate-300 px-1 font-mono">?</kbd> for keyboard shortcuts.
            </p>
          </div>
        )}
      </div>
      <ChangesList />
    </aside>
  );
}
