import type { EditOperation, PageModel } from '@pdf-toolkit/shared';
import { askConfirm } from '../lib/Dialogs.tsx';
import { pageNo, useEditor } from './store.ts';

/** Id of the box or table an op changes. */
export function opTarget(op: EditOperation): string {
  if (op.type === 'addTextBox') return op.id;
  if (op.type === 'setPageFlow' || op.type === 'scanLayout') return `page-flow`;
  if (op.type === 'arrangePages') return 'arrange-pages';
  if (op.type === 'deskewPage') return `deskew-${op.pageIndex}`;
  return 'tableId' in op ? op.tableId : op.elementId;
}

/**
 * Page where an op's element is shown now (text added in a flowed area belongs to an earlier page but
 * shows on a later one), else the op's page, else the original models (deleted elements).
 */
export function opPage(op: EditOperation, pages: PageModel[], origPages: PageModel[]): number | undefined {
  const id = opTarget(op);
  const on = (list: PageModel[]) => list.find((pg) => pg.textBoxes.some((b) => b.id === id) || pg.tables.some((t) => t.id === id))?.pageIndex;
  return on(pages) ?? ('pageIndex' in op ? op.pageIndex : on(origPages));
}

/**
 * Later ops on the pages that the arrange op at `index` added and that its undo takes away: blanks and
 * copies come from the last arrange op, and later ones only append to the list.
 */
export function dependentOps(ops: EditOperation[], index: number, pages: PageModel[], origPages: PageModel[]): number[] {
  const added = (list: EditOperation[]) => {
    const last = list.findLast((o) => o.type === 'arrangePages');
    return last?.type === 'arrangePages' ? last.blanks.length : 0;
  };
  const from = origPages.length + added(ops.filter((_, k) => k !== index));
  const to = origPages.length + added(ops);
  return ops.flatMap((op, k) => {
    const page = k > index ? opPage(op, pages, origPages) : undefined;
    return page !== undefined && page >= from && page < to ? [k] : [];
  });
}

const clip = (s: string, n = 28) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

type Arrange = Extract<EditOperation, { type: 'arrangePages' }>;

/** Names a page-list change by comparing it with the arrangement before it; page numbers are display positions. */
function describeArrange(op: Arrange, prev: Arrange | undefined, pageCount: number): string {
  const before: Arrange['order'] = prev?.order ?? Array.from({ length: pageCount }, (_, page) => ({ page }));
  const added = op.blanks.length - (prev?.blanks.length ?? 0);
  const at = (list: { page: number }[], page: number) => list.findIndex((e) => e.page === page) + 1;
  const pages = (list: { page: number }[]) => list.map((e) => e.page);
  if (added === 1 && op.order.length === before.length + 1) {
    const blank = op.blanks.at(-1)!;
    const page = pageCount + op.blanks.length - 1;
    if ('copy' in blank) return `Duplicate page ${at(op.order, blank.copy)}`;
    return at(op.order, page) === 1 ? 'Insert a blank page first' : `Insert a blank page after page ${at(op.order, page) - 1}`;
  }
  if (added !== 0) return `Arrange pages (${op.order.length} pages)`;
  if (op.order.length === before.length - 1) {
    const gone = before.find((e) => at(op.order, e.page) === 0);
    if (gone && pages(before).filter((k) => k !== gone.page).join() === pages(op.order).join()) return `Delete page ${at(before, gone.page)}`;
  }
  if (op.order.length === before.length) {
    if (pages(before).join() === pages(op.order).join()) {
      const turned = op.order.filter((e, i) => (e.rotate ?? 0) !== (before[i]!.rotate ?? 0));
      if (turned.length === 1) return `Rotate page ${at(op.order, turned[0]!.page)} to ${turned[0]!.rotate ?? 0}°`;
    } else {
      const moved = before.find((e) => {
        const rest = (list: { page: number }[]) => pages(list).filter((k) => k !== e.page).join();
        return rest(before) === rest(op.order);
      });
      if (moved) return `Move page ${at(before, moved.page)} to position ${at(op.order, moved.page)}`;
    }
  }
  return `Arrange pages (${op.order.length} pages)`;
}

function describe(op: EditOperation, name: string, before: EditOperation[], pageCount: number): string {
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
    {
      const parts = [op.color && 'colour', op.align, op.lineSpacing !== undefined && `spacing ${op.lineSpacing}`, op.background !== undefined && (op.background ? 'fill' : 'no fill')].filter(Boolean);
      return parts.length ? `Style ${name}: ${parts.join(', ')}` : `Style ${name}`;
    }
    case 'tableInsertRow':
      return `Insert row ${op.position} ${op.index + 1}`;
    case 'tableDeleteRow':
      return `Delete row ${op.index + 1}`;
    case 'tableInsertCol':
      return `Insert column ${op.position} of ${op.index + 1}`;
    case 'tableDeleteCol':
      return `Delete column ${op.index + 1}`;
    case 'setCellText':
      return op.text ? `Cell R${op.row + 1}C${op.col + 1} → “${clip(op.text, 20)}”` : `Clear cell R${op.row + 1}C${op.col + 1}`;
    case 'defineTable':
      return `Table setup ${op.vertices.length - 1}×${op.vertices[0]!.length - 1}${op.spans.length ? `, ${op.spans.length} merged` : ''}`;
    case 'setPageFlow':
      return op.newPages === 'copy' ? `New pages copy the header/footer${op.pageNumbers === 'omit' ? ' (no page number)' : ''}` : 'New pages are empty';
    case 'tableContinuation':
      return op.repeatHeader ? 'Continued table repeats its header rows' : 'Continued table without header rows';
    case 'scanLayout':
      return `Scan layout of page ${op.pageIndex + 1} (${op.lines.length} lines)`;
    case 'deskewPage':
      return `Straighten page by ${op.angle.toFixed(2)}°`;
    case 'arrangePages':
      return describeArrange(op, before.findLast((o) => o.type === 'arrangePages'), pageCount);
    case 'resizeTable':
      return `Resize table ${op.colWidths ? 'columns' : ''}${op.colWidths && op.rowHeights ? ' and ' : ''}${op.rowHeights ? 'rows' : ''}`;
  }
}

export function ChangesList() {
  const { ops, pages, origPages, reports, busy, showChanges, toggleChanges, removeOp, revertAll, setPage, select, selectCell } = useEditor();
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
        {ops.length > 0 && (
          <button
            data-testid="revert-all"
            className="ml-auto mr-2 rounded px-1.5 text-xs text-slate-600 hover:bg-red-100 hover:text-red-700 disabled:opacity-40"
            disabled={busy}
            title="Undo every change (Redo brings them back)"
            onClick={() => void askConfirm(`Undo all ${ops.length} change${ops.length > 1 ? 's' : ''}? Redo (Ctrl + Shift + Z) brings them back.`, 'Revert all').then((yes) => { if (yes) void revertAll(); })}
          >
            Revert all
          </button>
        )}
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
                {describe(op, nameOf(target), ops.slice(0, i), origPages.length)}
                {page !== undefined && pageNo({ ops, pages }, page) > 0 && <span className="ml-1 text-slate-400">p{pageNo({ ops, pages }, page)}</span>}
              </button>
              <button
                aria-label="Undo only this change"
                className="rounded px-1 text-slate-400 opacity-40 group-hover:opacity-100 hover:bg-red-100 hover:text-red-700 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-red-500 disabled:opacity-20"
                disabled={busy}
                title="Undo only this change"
                data-testid="change-undo"
                onClick={() => {
                  const deps = dependentOps(ops, i, pages, origPages);
                  if (deps.length === 0) return void removeOp(i);
                  const list = deps.map((k) => k + 1).join(', ');
                  void askConfirm(`This change added pages that later changes edit. Undo it together with change${deps.length > 1 ? 's' : ''} ${list}?`, 'Undo all').then((yes) => {
                    if (yes) void removeOp(i, deps);
                  });
                }}
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
