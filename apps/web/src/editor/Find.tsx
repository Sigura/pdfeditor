import { useEffect, useMemo, useRef, useState } from 'react';
import type { EditOperation, PageModel } from '@pdf-toolkit/shared';
import { pageOrder, useEditor } from './store.ts';

export type Match = { page: number; text: string; editable: boolean } & ({ boxId: string } | { tableId: string; row: number; col: number });

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text boxes and table cells containing `query` (case ignored), in display order of the pages, then top to bottom. */
export function findMatches(pages: PageModel[], order: number[], query: string): Match[] {
  if (!query) return [];
  const re = new RegExp(escape(query), 'i');
  return order.flatMap((k) => {
    const pg = pages[k];
    if (!pg) return [];
    const found: (Match & { top: number; left: number })[] = [];
    for (const b of pg.textBoxes) if (re.test(b.text)) found.push({ page: k, boxId: b.id, text: b.text, editable: b.runs.every((r) => r.decodable), top: b.bbox.y1, left: b.bbox.x0 });
    for (const t of pg.tables)
      for (const c of t.cells) if (!c.covered && re.test(c.text)) found.push({ page: k, tableId: t.id, row: c.row, col: c.col, text: c.text, editable: true, top: c.bbox.y1, left: c.bbox.x0 });
    return found.sort((a, b) => b.top - a.top || a.left - b.left).map(({ top: _t, left: _l, ...m }) => m);
  });
}

/** The edit that replaces every occurrence of `query` in a match. */
export function replaceOp(m: Match, query: string, by: string): EditOperation {
  const text = m.text.replace(new RegExp(escape(query), 'gi'), () => by);
  return 'boxId' in m ? { type: 'replaceText', elementId: m.boxId, text } : { type: 'setCellText', tableId: m.tableId, row: m.row, col: m.col, text };
}

/** Find bar (Ctrl+F): steps through matches in boxes and cells, selecting each; Replace / Replace all edit them. */
export function FindBar({ onClose }: { onClose: () => void }) {
  const st = useEditor();
  const [query, setQuery] = useState('');
  const [by, setBy] = useState('');
  const [at, setAt] = useState(0);
  // Whether match `at` is the one selected on the page; the first Enter selects it, the next ones move on.
  const [shown, setShown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const order = pageOrder(st.ops, st.pages);
  const matches = useMemo(() => findMatches(st.pages, order, query), [st.pages, order.join(), query]);
  const cur = matches.length ? matches[Math.min(at, matches.length - 1)]! : null;

  useEffect(() => inputRef.current?.select(), []);

  const show = (i: number) => {
    const m = matches[(i + matches.length) % matches.length];
    if (!m) return;
    setAt((i + matches.length) % matches.length);
    setShown(true);
    const s = useEditor.getState();
    if (s.pageIndex !== m.page) s.setPage(m.page);
    if ('boxId' in m) s.select(m.boxId);
    else s.selectCell({ tableId: m.tableId, row: m.row, col: m.col });
  };
  const editable = matches.filter((m) => m.editable);
  const replace = () => {
    if (!cur?.editable) return;
    void st.edit([replaceOp(cur, query, by)]);
  };
  const replaceAll = () => {
    if (editable.length) void st.edit(editable.map((m) => replaceOp(m, query, by)));
  };
  const input = 'w-44 rounded border border-slate-300 px-1.5 py-0.5';
  const btn = 'rounded px-2 py-0.5 hover:bg-slate-100 disabled:opacity-40';
  return (
    <div
      data-testid="find-bar"
      role="search"
      className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-1.5 text-sm"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <input
        ref={inputRef}
        data-testid="find-input"
        aria-label="Find text"
        placeholder="Find in text and cells"
        className={input}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setAt(0);
          setShown(false);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          show(shown ? at + (e.shiftKey ? -1 : 1) : at);
        }}
      />
      <span data-testid="find-count" className="w-20 tabular-nums text-slate-600" role="status">
        {query ? (matches.length ? `${Math.min(at, matches.length - 1) + 1} of ${matches.length}` : 'no matches') : ''}
      </span>
      <button className={btn} disabled={!matches.length} aria-label="Previous match" title="Previous match (Shift+Enter)" onClick={() => show(at - 1)}>
        ↑
      </button>
      <button className={btn} disabled={!matches.length} aria-label="Next match" title="Next match (Enter)" onClick={() => show(at + 1)}>
        ↓
      </button>
      <input data-testid="replace-input" aria-label="Replace with" placeholder="Replace with" className={input} value={by} onChange={(e) => setBy(e.target.value)} />
      <button data-testid="replace-one" className={btn} disabled={st.busy || !cur?.editable} title={cur && !cur.editable ? "This text can't be decoded, so it can't be replaced" : 'Replace in the current match'} onClick={replace}>
        Replace
      </button>
      <button
        data-testid="replace-all"
        className={btn}
        disabled={st.busy || !editable.length}
        title={`Replace in every match${matches.length > editable.length ? ` (${matches.length - editable.length} can't be decoded and stay)` : ''}; each changed box or cell is one change in the list`}
        onClick={replaceAll}
      >
        Replace all
      </button>
      <button className={`${btn} ml-auto`} aria-label="Close find" title="Close (Esc)" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
