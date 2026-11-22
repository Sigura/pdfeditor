import type { EditOperation, PageModel } from '@pdf-toolkit/shared';
import { useEditor } from './store.ts';

/** Id of the box or table an op changes. */
export function opTarget(op: EditOperation): string {
  if (op.type === 'addTextBox') return op.id;
  if (op.type === 'setPageFlow' || op.type === 'scanLayout') return `page-flow`;
  return 'tableId' in op ? op.tableId : op.elementId;
}

/** Page of an op's element: current models first, then the original ones (deleted elements). */
export function opPage(op: EditOperation, pages: PageModel[], origPages: PageModel[]): number | undefined {
  if ('pageIndex' in op) return op.pageIndex;
  const id = opTarget(op);
  for (const list of [pages, origPages]) {
    const p = list.find((pg) => pg.textBoxes.some((b) => b.id === id) || pg.tables.some((t) => t.id === id));
    if (p) return p.pageIndex;
  }
  return undefined;
}

const clip = (s: string, n = 28) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

function describe(op: EditOperation, name: string): string {
  switch (op.type) {
    case 'replaceText':
      return `Edit text → “${clip(op.text)}”`;
    case 'addTextBox':
      return `Add text “${clip(op.text)}”`;
    case 'deleteElement':
      return `Delete ${name}`;
    case 'moveElement':
      return op.width !== undefined ? `Resize ${name}` : `Move ${name} (${op.dx.toFixed(1)}, ${op.dy.toFixed(1)} pt)${op.background ? ', fill' : ''}`;
    case 'setTextStyle':
      return `Style ${name}: ${[op.color && 'colour', op.align, op.lineSpacing !== undefined && `spacing ${op.lineSpacing}`, op.background !== undefined && (op.background ? 'fill' : 'no fill')].filter(Boolean).join(', ')}`;
    case 'tableInsertRow':
      return `Insert row ${op.position} ${op.index + 1}`;
    case 'tableDeleteRow':
      return `Delete row ${op.index + 1}`;
    case 'tableInsertCol':
      return `Insert column ${op.position} of ${op.index + 1}`;
    case 'tableDeleteCol':
      return `Delete column ${op.index + 1}`;
    case 'setCellText':
      return `Cell R${op.row + 1}C${op.col + 1} → “${clip(op.text, 20)}”`;
    case 'defineTable':
      return `Table setup ${op.vertices.length - 1}×${op.vertices[0]!.length - 1}${op.spans.length ? `, ${op.spans.length} merged` : ''}`;
    case 'setPageFlow':
      return op.newPages === 'copy' ? `New pages copy the header/footer${op.pageNumbers === 'omit' ? ' (no page number)' : ''}` : 'New pages are empty';
    case 'tableContinuation':
      return op.repeatHeader ? 'Continued table repeats its header rows' : 'Continued table without header rows';
    case 'scanLayout':
      return `Scan layout of page ${op.pageIndex + 1} (${op.lines.length} lines)`;
    case 'resizeTable':
      return `Resize table ${op.colWidths ? 'columns' : ''}${op.colWidths && op.rowHeights ? ' and ' : ''}${op.rowHeights ? 'rows' : ''}`;
  }
}

export function ChangesList() {
  const { ops, pages, origPages, reports, busy, showChanges, toggleChanges, removeOp, setPage, select, selectCell } = useEditor();
  const nameOf = (id: string) => {
    for (const list of [pages, origPages]) {
      for (const p of list) {
        const b = p.textBoxes.find((x) => x.id === id);
        if (b) return `“${clip(b.text, 18)}”`;
        if (p.tables.some((t) => t.id === id)) return 'table';
      }
    }
    return id;
  };
  return (
    <div className="flex min-h-0 flex-col" data-testid="changes">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <span className="font-medium">Changes ({ops.length})</span>
        <label className="flex items-center gap-1 text-xs text-slate-600" title="Outline changed and deleted elements on the page">
          <input type="checkbox" checked={showChanges} onChange={toggleChanges} data-testid="show-changes" />
          Show on page
        </label>
      </div>
      {ops.length === 0 && <p className="px-3 py-2 text-xs text-slate-500">No changes yet.</p>}
      <ol className="min-h-0 flex-1 overflow-y-auto text-xs">
        {ops.map((op, i) => {
          const target = opTarget(op);
          const page = opPage(op, pages, origPages);
          const failed = reports.some((r) => r.strategy === 'none' && (r.elementId === target || r.elementId.startsWith(`${target}:`)));
          return (
            <li key={i} className={`group flex items-start gap-1 border-b border-slate-100 px-3 py-1.5 hover:bg-slate-50 ${failed ? 'text-red-700' : ''}`} data-testid="change-item">
              <button
                className="min-w-0 flex-1 text-left"
                title={failed ? 'Not applied: see the badge on the element' : 'Show this element'}
                onClick={() => {
                  if (page !== undefined) setPage(page);
                  const exists = pages.some((p) => p.textBoxes.some((b) => b.id === target));
                  if (exists) select(target);
                  else if ('row' in op) selectCell({ tableId: op.tableId, row: op.row, col: op.col });
                }}
              >
                <span className="mr-1 text-slate-400 tabular-nums">{i + 1}.</span>
                {describe(op, nameOf(target))}
                {page !== undefined && <span className="ml-1 text-slate-400">p{page + 1}</span>}
              </button>
              <button
                className="rounded px-1 text-slate-400 opacity-40 group-hover:opacity-100 hover:bg-red-100 hover:text-red-700 disabled:opacity-20"
                disabled={busy}
                title="Undo only this change"
                data-testid="change-undo"
                onClick={() => void removeOp(i)}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
