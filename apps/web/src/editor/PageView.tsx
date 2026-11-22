import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Color, PageModel, Rect, StrategyReport, TextBox } from '@pdf-toolkit/shared';
import type { PdfDoc } from '../lib/pdfjs.ts';
import { opTarget } from './Changes.tsx';
import { fillAt, moveOp, registerCanvas } from './background.ts';
import { GuideLines, Readout, snapEdges, snapRect, snapTargets, type Guides } from './snap.tsx';
import { TableOverlay } from './TableOverlay.tsx';
import { TableSetupView, setupDraft } from './TableSetup.tsx';
import { useEditor, type CellRef } from './store.ts';

export type Viewport = {
  width: number;
  height: number;
  convertToViewportRectangle: (r: number[]) => number[];
  convertToViewportPoint: (x: number, y: number) => [number, number];
  convertToPdfPoint: (x: number, y: number) => [number, number];
};

export function toCss(vp: Viewport, r: Rect) {
  const [a, b, c, d] = vp.convertToViewportRectangle([r.x0, r.y0, r.x1, r.y1]) as [number, number, number, number];
  return { left: Math.min(a, c), top: Math.min(b, d), width: Math.abs(c - a), height: Math.abs(d - b) };
}

export function cssColor(c: Color): string {
  const v = c.values.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255));
  if (c.space === 'gray') return `rgb(${v[0]},${v[0]},${v[0]})`;
  if (c.space === 'rgb') return `rgb(${v[0]},${v[1]},${v[2]})`;
  if (c.space === 'cmyk') {
    const [cc, m, y, k] = c.values as [number, number, number, number];
    return `rgb(${[cc, m, y].map((x) => Math.round(255 * (1 - x) * (1 - k))).join(',')})`;
  }
  return 'black';
}

/**
 * In-place plain-text editor; Esc cancels (null), blur or Ctrl+Enter commits. With `onTab`, Tab/Shift+Tab commit and move on.
 * `toolbar` sits above the editor; moving the focus into it does not commit.
 */
export function TextEditor({ text, css, style, onDone, onTab, toolbar }: { text: string; css: ReturnType<typeof toCss>; style: CSSProperties; onDone: (text: string | null) => void; onTab?: (text: string, back: boolean) => void; toolbar?: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current!;
    el.innerText = text;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  }, [text]);
  const finish = (t: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(t);
  };
  return (
    <div
      ref={wrap}
      className="contents"
      onBlur={(e) => {
        if (!wrap.current!.contains(e.relatedTarget as Node | null)) finish(ref.current!.innerText.replace(/\n$/, ''));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') finish(null);
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) finish(ref.current!.innerText.replace(/\n$/, ''));
      }}
    >
      {toolbar && (
        <div
          className="absolute z-20 flex items-center gap-1 rounded border border-slate-300 bg-white p-1 text-xs shadow"
          style={{ left: css.left - 2, top: css.top - 40 }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            e.stopPropagation();
            // Only inputs take the focus: a button (e.g. a font in the picker, which then unmounts) would leave it nowhere, so blur never commits.
            if (!(e.target as HTMLElement).closest('input, select, textarea')) e.preventDefault();
          }}
        >
          {toolbar}
        </div>
      )}
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      data-testid="box-editor"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Tab' && onTab) {
          e.preventDefault();
          if (done.current) return;
          done.current = true;
          onTab(ref.current!.innerText.replace(/\n$/, ''), e.shiftKey);
        }
      }}
      className="absolute z-10 whitespace-pre-wrap bg-white outline-2 outline-sky-600"
      style={{ left: css.left - 2, top: css.top - 2, minWidth: css.width + 4, minHeight: css.height + 4, ...style }}
    />
    </div>
  );
}

function BoxEditor({ box, css, zoom, onDone }: { box: TextBox; css: ReturnType<typeof toCss>; zoom: number; onDone: (text: string | null) => void }) {
  const run = box.runs[0];
  // Added boxes have no runs: their line height is 1.2 × the font size.
  const size = run ? Math.hypot(run.matrix[2], run.matrix[3]) * run.fontSize * zoom : (box.lineHeight / 1.2) * zoom;
  const name = run?.fontName ?? '';
  return (
    <TextEditor
      text={box.text}
      css={css}
      onDone={onDone}
      style={{
        fontSize: size,
        lineHeight: `${box.text.includes('\n') ? box.lineHeight * zoom : size * 1.2}px`,
        fontFamily: /times|serif|roman|georgia|garamond/i.test(name) && !/sans/i.test(name) ? 'serif' : /courier|mono/i.test(name) ? 'monospace' : 'sans-serif',
        fontWeight: /bold|black|heavy/i.test(name) ? 700 : 400,
        fontStyle: /italic|oblique/i.test(name) ? 'italic' : 'normal',
        textAlign: box.align,
        color: run ? cssColor(run.color) : 'black',
      }}
    />
  );
}

function StrategyBadge({ report }: { report: StrategyReport }) {
  const ok = report.strategy !== 'none';
  const label = { original: 'S1 original', substitute: 'S2 substitute', emulated: 'S3 emulated', none: 'not applied' }[report.strategy];
  const g = report.glyphs;
  const counts = [`${g.original} original`, g.substitute ? `${g.substitute} substitute` : '', g.composed ? `${g.composed} composed` : '', g.fallback ? `${g.fallback} fallback` : ''].filter(Boolean);
  const title = [`Font: ${report.fontName}`, report.substituteFont ? `Substitute: ${report.substituteFont}` : '', `Glyphs: ${counts.join(', ')}`, ...report.warnings].filter(Boolean).join('\n');
  return (
    <span
      data-testid="strategy-badge"
      title={title}
      className={`pointer-events-auto absolute -top-4 right-0 rounded px-1 text-[10px] leading-4 whitespace-nowrap text-white ${ok ? (report.warnings.length ? 'bg-amber-600' : 'bg-emerald-600') : 'bg-red-600'}`}
    >
      {label}
    </span>
  );
}

type BoxDrag = { id: string; kind: 'move' | 'resize'; dx: number; dy: number; guides: Guides };

/** Cell `delta` steps away in reading order, clamped to the table. */
export function stepCell(model: PageModel, c: CellRef, delta: number): CellRef {
  const t = model.tables.find((x) => x.id === c.tableId);
  if (!t) return c;
  const n = t.cols.length;
  const i = Math.min(t.rows.length * n - 1, Math.max(0, c.row * n + c.col + delta));
  return { tableId: c.tableId, row: Math.floor(i / n), col: i % n };
}
type GridDraw = { x0: number; y0: number; x1: number; y1: number };

/** Top-left corner after a move, in PDF points. */
const readout = (r: Rect, [dx, dy]: readonly [number, number]) => `x ${(r.x0 + dx).toFixed(1)}  y ${(r.y1 + dy).toFixed(1)} pt`;

function nudgeCss(vp: Viewport, n: { dx: number; dy: number }) {
  const [ax, ay] = vp.convertToViewportPoint(0, 0);
  const [bx, by] = vp.convertToViewportPoint(n.dx, n.dy);
  return { dx: bx - ax, dy: by - ay };
}

export function PageView({ pdf, model, revision }: { pdf: PdfDoc; model: PageModel; revision: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState<Viewport | null>(null);
  const [drag, setDrag] = useState<BoxDrag | null>(null);
  const [draw, setDraw] = useState<GridDraw | null>(null);
  const dragged = useRef(false);
  const { zoom, hoveredId, selectedId, editingId, reports, tool, newText, nudge, ops, showChanges, origPages, tableSetup, hover, select, startEditing, edit, setTool, startSetup } = useEditor();
  const latest = useRef({ vp, model });
  latest.current = { vp, model };

  const commit = async (box: TextBox, text: string | null) => {
    if (text === null || text === box.text) return useEditor.getState().startEditing(null);
    await edit([{ type: 'replaceText', elementId: box.id, text }]);
  };

  /** CSS pixel delta → PDF user-space delta (handles /Rotate). */
  const toPdf = (v: Viewport, dx: number, dy: number) => {
    const [ax, ay] = v.convertToPdfPoint(0, 0);
    const [bx, by] = v.convertToPdfPoint(dx, dy);
    return [bx - ax, by - ay] as const;
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = overlayRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const startBoxDrag = (e: React.MouseEvent, b: TextBox, kind: BoxDrag['kind']) => {
    if (b.id !== selectedId || tool !== 'select') return;
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    dragged.current = false;
    if (!vp) return;
    const base = toCss(vp, b.bbox);
    const targets = snapTargets(model, vp, b.id);
    let last: BoxDrag = { id: b.id, kind, dx: 0, dy: 0, guides: { x: null, y: null } };
    const move = (ev: MouseEvent) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 3) dragged.current = true;
      let dx = ev.clientX - x0;
      let dy = ev.clientY - y0;
      let guides: Guides = { x: null, y: null };
      // Alt turns snapping off. A resize snaps the right and bottom edges it moves.
      if (!ev.altKey) {
        const s = kind === 'move' ? snapRect({ ...base, left: base.left + dx, top: base.top + dy }, targets) : snapEdges({ ...base, width: base.width + dx, height: base.height + dy }, targets);
        dx += s.dx;
        dy += s.dy;
        guides = s.guides;
      }
      last = { id: b.id, kind, dx, dy, guides };
      setDrag(last);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDrag(null);
      if (!dragged.current) return;
      if (kind === 'move') {
        const [dx, dy] = toPdf(vp, last.dx, last.dy);
        const st = useEditor.getState();
        void edit([moveOp(model, st.ops, b.id, dx, dy)]);
      } else {
        const [w, h] = toPdf(vp, Math.max(10, base.width + last.dx), Math.max(6, base.height + last.dy));
        void edit([{ type: 'moveElement', elementId: b.id, dx: 0, dy: 0, width: Math.abs(w), height: Math.abs(h) }]);
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useEditor.getState();
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      const { vp: v, model: m } = latest.current;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (key === 'z' || key === 'y')) {
        e.preventDefault();
        if (st.busy) return;
        void (key === 'y' || e.shiftKey ? st.redo() : st.undo());
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key] as [number, number] | undefined;
      if (st.selectedId && !st.editingId) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          void st.edit([{ type: 'deleteElement', elementId: st.selectedId }], () => st.select(null));
        } else if (arrow && v && st.tool === 'select') {
          e.preventDefault();
          // 1 pt per press (10 with Shift) in screen direction, whatever the page rotation.
          const step = (e.shiftKey ? 10 : 1) * st.zoom;
          const [dx, dy] = toPdf(v, arrow[0] * step, arrow[1] * step);
          st.nudgeBy(dx, dy);
        } else if (e.key === 'Enter') {
          const box = m.textBoxes.find((b) => b.id === st.selectedId);
          if (box?.runs.every((r) => r.decodable)) {
            e.preventDefault();
            st.startEditing(box.id);
          }
        } else if (e.key === 'Escape') st.select(null);
        return;
      }
      if (st.cell && !st.editingCell) {
        const n = m.tables.find((x) => x.id === st.cell!.tableId)?.cols.length ?? 1;
        const delta = arrow ? arrow[0] + arrow[1] * n : e.key === 'Tab' ? (e.shiftKey ? -1 : 1) : 0;
        if (delta) {
          e.preventDefault();
          st.selectCell(stepCell(m, st.cell, delta));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          st.editCell(st.cell);
        } else if (e.key === 'Escape') st.selectCell(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Content continued from earlier pages, and pages the flow added, belong to the pages they came from.
  const inFlow = (px: number, py: number) => !!model.added || !!model.flowIn?.some((r) => px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1);
  const flowError = () => useEditor.getState().setError('This area holds content continued from an earlier page: edit it there, or use the cells and boxes shown here.');
  // New content in a flowed area belongs to the page that content came from, where it lies dy lower.
  const flowSource = (py: number) => model.flowFrom?.find((f) => py >= f.y0 && py <= f.y1);

  const onPageMouseDown = (e: React.MouseEvent) => {
    if (tool !== 'table' || tableSetup || !vp) return;
    const [x, y] = local(e);
    if (inFlow(...(vp.convertToPdfPoint(x, y) as [number, number]))) return flowError();
    setDraw({ x0: x, y0: y, x1: x, y1: y });
    const move = (ev: MouseEvent) => {
      const [x1, y1] = local(ev);
      setDraw({ x0: x, y0: y, x1, y1 });
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDraw(null);
      const [x1, y1] = local(ev);
      if (Math.abs(x1 - x) < 10 || Math.abs(y1 - y) < 10) return;
      const [ax, ay] = vp.convertToPdfPoint(x, y);
      const [bx, by] = vp.convertToPdfPoint(x1, y1);
      void setupDraft(pdf, model, { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) }).then(startSetup);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const onPageClick = (e: React.MouseEvent) => {
    if (tool === 'table') return;
    if (tool !== 'addText' || !vp) return select(null);
    const [x, y] = local(e);
    const [px, py] = vp.convertToPdfPoint(x, y);
    const from = inFlow(px, py) ? flowSource(py) : undefined;
    if (inFlow(px, py) && !from) return flowError();
    const id = `n-${Date.now().toString(36)}`;
    const size = newText.fontSize;
    const bbox = { x0: px, y0: py - size * 1.4, x1: Math.min(px + 200, model.view.x1), y1: py };
    const background = fillAt(model, bbox, null);
    const dy = from?.dy ?? 0;
    const at = { ...bbox, y0: bbox.y0 - dy, y1: bbox.y1 - dy };
    void edit([{ type: 'addTextBox', id, pageIndex: from?.src ?? model.pageIndex, bbox: at, text: 'New text', fontSize: size, fontFamily: newText.fontFamily, ...(background && { background }) }], () => {
      setTool('select');
      startEditing(id);
    });
  };

  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    void (async () => {
      const page = await pdf.getPage(model.pageIndex + 1);
      if (cancelled) return;
      const viewport = page.getViewport({ scale: zoom });
      const canvas = canvasRef.current!;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      task = page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      const activity = useEditor.getState().begin(`Rendering page ${model.pageIndex + 1}…`);
      try {
        await task.promise;
      } catch (e) {
        if ((e as Error).name !== 'RenderingCancelledException') throw e;
      } finally {
        useEditor.getState().end(activity);
      }
      // pdf.js types the converted points as any[]; they are always [x, y].
      if (!cancelled) {
        registerCanvas({ canvas, vp: viewport as unknown as Viewport, pageIndex: model.pageIndex });
        setVp(viewport as unknown as Viewport);
        useEditor.getState().rendered();
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, model.pageIndex, zoom, revision]);

  const changed = new Set(ops.map(opTarget));
  const deletedIds = new Set(ops.flatMap((o) => (o.type === 'deleteElement' ? [o.elementId] : [])));
  const orig = origPages[model.pageIndex];
  const deleted = orig ? [...orig.textBoxes, ...orig.tables].filter((el) => deletedIds.has(el.id)) : [];

  return (
    <div
      className={`relative mx-auto bg-white shadow-lg ${tool === 'addText' ? 'cursor-text' : tool === 'table' && !tableSetup ? 'cursor-crosshair' : ''}`}
      style={vp ? { width: vp.width, height: vp.height } : undefined}
      onClick={onPageClick}
      onMouseDown={onPageMouseDown}
    >
      <canvas ref={canvasRef} className="block" />
      {vp && (
        <div ref={overlayRef} className="absolute inset-0" data-testid="overlay">
          {model.flowIn?.map((r, i) => {
            const c = toCss(vp, r);
            return (
              <div
                key={`flow-${i}`}
                data-testid="flow-in"
                title="Continued from an earlier page"
                className="pointer-events-none absolute border-y border-dashed border-violet-400/70"
                style={{ left: c.left, top: c.top, width: c.width, height: c.height, background: 'repeating-linear-gradient(135deg, rgba(139,92,246,0.06) 0 6px, transparent 6px 12px)' }}
              />
            );
          })}
          {model.tables.map((t) => (tableSetup?.tableId === t.id ? null : <TableOverlay key={t.id} table={t} vp={vp} zoom={zoom} pdf={pdf} />))}
          {tableSetup?.pageIndex === model.pageIndex && <TableSetupView key={`${tableSetup.tableId}:${JSON.stringify(tableSetup.rect)}`} draft={tableSetup} model={model} vp={vp} zoom={zoom} pdf={pdf} />}
          {draw && (
            <div
              className="pointer-events-none absolute border-2 border-dashed border-orange-500 bg-orange-400/10"
              style={{ left: Math.min(draw.x0, draw.x1), top: Math.min(draw.y0, draw.y1), width: Math.abs(draw.x1 - draw.x0), height: Math.abs(draw.y1 - draw.y0) }}
            />
          )}
          {drag && <GuideLines guides={drag.guides} vp={vp} />}
          {showChanges &&
            model.tables.filter((t) => changed.has(t.id)).map((t) => <div key={`chg-${t.id}`} data-testid="change-marker" className="pointer-events-none absolute outline-2 outline-offset-4 outline-amber-500 outline-dashed" style={toCss(vp, t.bbox)} />)}
          {showChanges &&
            deleted.map((b) => (
              <div key={`del-${b.id}`} data-testid="deleted-marker" title={`Deleted: ${'text' in b ? b.text : 'table'}`} className="pointer-events-none absolute border border-dashed border-red-500 bg-red-500/10" style={toCss(vp, b.bbox)}>
                <span className="absolute -top-4 left-0 rounded bg-red-600 px-1 text-[10px] leading-4 text-white">deleted</span>
              </div>
            ))}
          {model.textBoxes.map((b) => {
            const css = toCss(vp, b.bbox);
            if (b.id === editingId) return <BoxEditor key={b.id} box={b} css={css} zoom={zoom} onDone={(t) => void commit(b, t)} />;
            const active = b.id === hoveredId || b.id === selectedId;
            const report = reports.find((r) => r.elementId === b.id);
            const editable = b.runs.every((r) => r.decodable);
            const d = drag?.id === b.id ? drag : null;
            const n = nudge?.id === b.id ? nudgeCss(vp, nudge) : null;
            const selected = b.id === selectedId;
            const marked = showChanges && changed.has(b.id);
            return (
              <div
                key={b.id}
                data-testid="text-box"
                data-box-id={b.id}
                title={`${b.runs[0] ? `${b.runs[0].fontName} ${b.runs[0].fontSize.toFixed(1)}pt` : 'Added text'}${editable ? (selected ? ' — drag to move, click to edit, Delete to remove' : ' — click to select') : ' — text cannot be decoded, not editable'}`}
                onMouseEnter={() => hover(b.id)}
                onMouseLeave={() => hover(null)}
                onMouseDown={(e) => startBoxDrag(e, b, 'move')}
                onClick={(e) => {
                  e.stopPropagation();
                  if (tool !== 'select') return;
                  if (dragged.current) {
                    dragged.current = false;
                    return;
                  }
                  if (selected && editable) startEditing(b.id);
                  else select(b.id);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (editable && tool === 'select') startEditing(b.id);
                }}
                className={`absolute rounded-sm ${tool === 'select' ? (selected ? 'cursor-move' : 'cursor-pointer') : 'pointer-events-none'} ${selected ? 'outline-2 outline-sky-600' : active ? 'outline-1 outline-sky-400 bg-sky-400/10' : marked ? 'outline-2 outline-dashed outline-amber-500' : ''}`}
                style={{
                  left: css.left - 2,
                  top: css.top - 2,
                  width: css.width + 4 + (d?.kind === 'resize' ? d.dx : 0),
                  height: css.height + 4 + (d?.kind === 'resize' ? d.dy : 0),
                  transform: d?.kind === 'move' ? `translate(${d.dx}px, ${d.dy}px)` : n ? `translate(${n.dx}px, ${n.dy}px)` : undefined,
                }}
              >
                {(d?.kind === 'move' || n) && <Readout left={0} top={0} text={readout(b.bbox, d ? toPdf(vp, d.dx, d.dy) : [nudge!.dx, nudge!.dy])} />}
                {d?.kind === 'resize' && (
                  <Readout left={0} top={0} text={(() => {
                    const [w, h] = toPdf(vp, Math.max(10, css.width + d.dx), Math.max(6, css.height + d.dy));
                    return `${Math.abs(w).toFixed(1)} × ${Math.abs(h).toFixed(1)} pt`;
                  })()} />
                )}
                {report && <StrategyBadge report={report} />}
                {selected && tool === 'select' && (
                  <div
                    title="Drag to change the wrap width"
                    data-testid="resize-handle"
                    className="absolute -right-1.5 -bottom-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-white bg-sky-600"
                    onMouseDown={(e) => startBoxDrag(e, b, 'resize')}
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
