import { useEffect, useMemo, useRef, useState } from 'react';
import {
  bandCheck,
  cellAnchor,
  changeCols,
  changeRows,
  evenLines,
  meshFromGrid,
  meshLines,
  mergeCells,
  moveGridVertex,
  placeContent,
  rectifyMesh,
  snapPoint,
  splitCells,
  unsnappedVertices,
  vertexVisible,
  type Mesh,
  type PageModel,
  type Point,
  type Rect,
  type Ruling,
  type Table,
} from '@pdf-toolkit/shared';
import { toCss, type Viewport } from './PageView.tsx';
import { renderRegion } from './background.ts';
import type { PdfDoc } from '../lib/pdfjs.ts';
import { detectLines, measureLook } from './rasterGrid.ts';
import { useEditor, type SetupDraft } from './store.ts';

export const gridOf = (t: Table) => ({ ys: [t.rows[0]!.y1, ...t.rows.map((r) => r.y0)], xs: [t.cols[0]!.x0, ...t.cols.map((c) => c.x1)] });

/** Proposes row and column boundaries for a drawn rectangle from the text runs inside it. */
export function proposeGrid(model: PageModel, r: Rect): { rows: number[]; cols: number[] } {
  const runs = model.textBoxes.flatMap((b) => b.runs).filter((x) => {
    const cx = (x.bbox.x0 + x.bbox.x1) / 2;
    const cy = (x.bbox.y0 + x.bbox.y1) / 2;
    return cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1;
  });
  const merge = (iv: [number, number][], gap: number) => {
    const out: [number, number][] = [];
    for (const [a, b] of iv.sort((p, q) => p[0] - q[0])) {
      const last = out[out.length - 1];
      if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  };
  const between = (iv: [number, number][]) => iv.slice(1).map((v, i) => (iv[i]![1] + v[0]) / 2);
  const rowsIv = merge(runs.map((x) => [x.bbox.y0, x.bbox.y1]), 0);
  const colsIv = merge(runs.map((x) => [x.bbox.x0, x.bbox.x1]), 8);
  return { rows: [r.y1, ...between(rowsIv).reverse(), r.y0], cols: [r.x0, ...between(colsIv), r.x1] };
}

const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const area = (r: Rect) => (r.x1 - r.x0) * (r.y1 - r.y0);

const within = (r: Ruling, rect: Rect, m: number) =>
  r.dir === 'h' ? r.pos >= rect.y0 - m && r.pos <= rect.y1 + m && r.b >= rect.x0 - m && r.a <= rect.x1 + m : r.pos >= rect.x0 - m && r.pos <= rect.x1 + m && r.b >= rect.y0 - m && r.a <= rect.y1 + m;

/** Border lines found in the pixels (a 4 px/pt render) when the page has no vector rulings in `rect` (a scanned table). */
async function scanLines(pdf: PdfDoc, model: PageModel, rect: Rect): Promise<SetupDraft['raster']> {
  if (model.rulings.some((r) => within(r, rect, 2))) return undefined;
  const pad = { x0: rect.x0 - 4, y0: rect.y0 - 4, x1: rect.x1 + 4, y1: rect.y1 + 4 };
  const region = await renderRegion(pdf, model.pageIndex, pad, 4);
  const px = region.toPx(pad);
  const found = detectLines(region, Math.max(8, (30 * (px.x1 - px.x0)) / (pad.x1 - pad.x0)));
  const rulings = found.rulings.filter((r) => within(r, rect, 4));
  if (rulings.filter((r) => r.dir === 'h').length < 2 || rulings.filter((r) => r.dir === 'v').length < 2) return undefined;
  return { rulings, junctions: found.junctions };
}

/** Step 1 defaults: from the table the rectangle mostly covers (or that was clicked), else proposed from the text inside it. */
export async function setupDraft(pdf: PdfDoc, model: PageModel, rect: Rect, clicked?: Table): Promise<SetupDraft> {
  const table = clicked ?? model.tables.find((t) => overlap(t.bbox, rect) > 0.5 * area(t.bbox));
  const raster = await scanLines(pdf, model, table?.bbox ?? rect);
  if (table) {
    const s = table.setup;
    return {
      pageIndex: model.pageIndex,
      tableId: table.id,
      rect: table.bbox,
      rows: table.rows.length,
      cols: table.cols.length,
      borderWidth: s?.borderWidth ?? table.borderStyle?.width ?? 0,
      headerRows: s?.headerRows ?? Math.min(1, table.rows.length),
      grid: { ...gridOf(table), spans: table.cells.flatMap((c) => (c.rowSpan || c.colSpan ? [{ row: c.row, col: c.col, rowSpan: c.rowSpan ?? 1, colSpan: c.colSpan ?? 1 }] : [])) },
      ...(s && { setup: s }),
      ...(raster && { raster }),
    };
  }
  if (raster) {
    const lines = (dir: 'h' | 'v') => {
      const out: number[] = [];
      for (const p of raster.rulings.filter((r) => r.dir === dir).map((r) => r.pos).sort((a, b) => a - b)) if (!out.length || p - out[out.length - 1]! > 2) out.push(p);
      return out;
    };
    const ys = lines('h').reverse();
    const xs = lines('v');
    const widths = raster.rulings.map((r) => r.width).sort((a, b) => a - b);
    const borderWidth = Math.round(widths[Math.floor(widths.length / 2)]! * 20) / 20;
    const box = { x0: xs[0]!, y0: ys[ys.length - 1]!, x1: xs[xs.length - 1]!, y1: ys[0]! };
    return { pageIndex: model.pageIndex, tableId: `t-n-${Date.now().toString(36)}`, rect: box, rows: ys.length - 1, cols: xs.length - 1, borderWidth, headerRows: 1, grid: { ys, xs }, raster };
  }
  const { rows, cols } = proposeGrid(model, rect);
  // Most common ruling width inside the rectangle.
  const counts = new Map<number, number>();
  for (const r of model.rulings) {
    const box = r.dir === 'h' ? { x0: r.a, y0: r.pos, x1: r.b, y1: r.pos } : { x0: r.pos, y0: r.a, x1: r.pos, y1: r.b };
    if (box.x0 >= rect.x0 - 2 && box.x1 <= rect.x1 + 2 && box.y0 >= rect.y0 - 2 && box.y1 <= rect.y1 + 2) {
      const w = Math.round(r.width * 100) / 100;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  const borderWidth = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  return { pageIndex: model.pageIndex, tableId: `t-n-${Date.now().toString(36)}`, rect, rows: rows.length - 1, cols: cols.length - 1, borderWidth, headerRows: 1, grid: { ys: rows, xs: cols } };
}

type Params = { rows: number; cols: number; borderWidth: number; headerRows: number };
type Range = { r0: number; c0: number; r1: number; c1: number };

function initialMesh(d: SetupDraft, p: Params, junctions: Point[], radius: number): Mesh {
  if (d.setup && d.setup.vertices.length === p.rows + 1 && d.setup.vertices[0]!.length === p.cols + 1) return rectifyMesh({ vertices: d.setup.vertices, spans: d.setup.spans }, junctions);
  const g = d.grid && d.grid.ys.length === p.rows + 1 && d.grid.xs.length === p.cols + 1 ? d.grid : null;
  const m = meshFromGrid(g?.ys ?? evenLines(d.rect.y1, d.rect.y0, p.rows), g?.xs ?? evenLines(d.rect.x0, d.rect.x1, p.cols), junctions, radius);
  return rectifyMesh({ ...m, spans: g?.spans ?? [] }, junctions);
}

function Step1({ draft, css, onOk, onCancel }: { draft: SetupDraft; css: ReturnType<typeof toCss>; onOk: (p: Params) => void; onCancel: () => void }) {
  const [p, setP] = useState<Params>({ rows: draft.rows, cols: draft.cols, borderWidth: draft.borderWidth, headerRows: draft.headerRows });
  const field = (key: keyof Params, label: string, min: number, step: number) => (
    <label className="flex items-center justify-between gap-2">
      {label}
      <input
        type="number"
        data-testid={`setup-${key}`}
        min={min}
        step={step}
        value={p[key]}
        className="w-16 rounded border border-slate-300 px-1"
        onChange={(e) => setP({ ...p, [key]: Number(e.target.value) })}
      />
    </label>
  );
  const valid = p.rows >= 1 && p.cols >= 1 && p.rows * p.cols >= 1 && p.borderWidth >= 0 && p.headerRows >= 0 && p.headerRows <= p.rows && Number.isInteger(p.rows) && Number.isInteger(p.cols);
  return (
    <form
      data-testid="setup-step1"
      className="absolute z-30 grid w-52 gap-1 rounded border border-slate-300 bg-white p-2 text-xs shadow-lg"
      style={{ left: css.left, top: Math.max(0, css.top - 4) }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onOk(p);
      }}
    >
      <div className="font-medium">Table setup: step 1</div>
      {field('cols', 'Columns', 1, 1)}
      {field('rows', 'Rows', 1, 1)}
      {field('borderWidth', 'Border width (pt)', 0, 0.05)}
      {field('headerRows', 'Header rows', 0, 1)}
      <div className="mt-1 flex justify-end gap-1">
        <button type="button" className="rounded px-2 py-0.5 hover:bg-slate-100" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" data-testid="setup-ok" disabled={!valid} className="rounded bg-sky-600 px-2 py-0.5 text-white disabled:opacity-40">
          Next
        </button>
      </div>
    </form>
  );
}

const hue = (row: number, col: number) => ((row * 3 + col) * 47) % 360;

/** Table tool: Step 1 dialog, then the vertex mesh over the table until Confirm (defineTable) or Cancel. */
export function TableSetupView({ draft, model, vp, zoom, pdf }: { draft: SetupDraft; model: PageModel; vp: Viewport; zoom: number; pdf: PdfDoc }) {
  const { edit, busy, startSetup, setTool } = useEditor();
  const [measuring, setMeasuring] = useState(false);
  const [params, setParams] = useState<Params | null>(null);
  const [mesh, setMesh] = useState<Mesh | null>(null);
  const [sel, setSel] = useState<Range | null>(null);
  const [vsel, setVsel] = useState<[number, number] | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const radius = 6 / zoom;
  const rulings = draft.raster?.rulings ?? model.rulings;
  const junctions = useMemo(() => {
    const r = draft.rect;
    const m = 12;
    return (draft.raster?.junctions ?? model.junctions).filter((j) => j.x >= r.x0 - m && j.x <= r.x1 + m && j.y >= r.y0 - m && j.y <= r.y1 + m);
  }, [model, draft]);
  const latest = useRef({ mesh, vsel, junctions });
  latest.current = { mesh, vsel, junctions };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { mesh: m, vsel: v, junctions: js } = latest.current;
      if (!m || !v || (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(e.target.tagName))) return;
      const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key] as [number, number] | undefined;
      if (e.key === 'Escape') return setVsel(null);
      if (!arrow) return;
      e.preventDefault();
      e.stopPropagation();
      // 0.25 pt per press (2 pt with Shift), in screen direction whatever the page rotation.
      const step = e.shiftKey ? 2 : 0.25;
      const [ax, ay] = vp.convertToPdfPoint(0, 0);
      const [bx, by] = vp.convertToPdfPoint(arrow[0], arrow[1]);
      const len = Math.hypot(bx - ax, by - ay);
      const p = m.vertices[v[0]]![v[1]]!;
      const x = p.x + ((bx - ax) / len) * step;
      const y = p.y + ((by - ay) / len) * step;
      setMesh(moveGridVertex(m, v[0], v[1], { x, y }, js));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [vp]);

  const cancel = () => startSetup(null);
  const css = toCss(vp, draft.rect);
  if (!params || !mesh) {
    return (
      <Step1
        draft={draft}
        css={css}
        onCancel={cancel}
        onOk={(p) => {
          setParams(p);
          setMesh(initialMesh(draft, p, junctions, radius));
        }}
      />
    );
  }

  const v = mesh.vertices;
  const rows = v.length - 1;
  const cols = v[0]!.length - 1;
  const pt = (p: Point) => vp.convertToViewportPoint(p.x, p.y);
  const edges = bandCheck(mesh, rulings, params.borderWidth);
  const off = edges.filter((e) => e.status === 'off');
  const yellow = unsnappedVertices(mesh);
  const anchors = [] as { row: number; col: number; rowSpan: number; colSpan: number }[];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const s = mesh.spans.find((x) => r >= x.row && r < x.row + x.rowSpan && c >= x.col && c < x.col + x.colSpan);
      if (!s) anchors.push({ row: r, col: c, rowSpan: 1, colSpan: 1 });
      else if (s.row === r && s.col === c) anchors.push(s);
    }
  }
  const poly = (pts: Point[]) => pts.map((p) => pt(p).join(',')).join(' ');
  const inSel = (a: { row: number; col: number }) => !!sel && a.row >= Math.min(sel.r0, sel.r1) && a.row <= Math.max(sel.r0, sel.r1) && a.col >= Math.min(sel.c0, sel.c1) && a.col <= Math.max(sel.c0, sel.c1);

  const near = (r: Rect) => r.x1 >= draft.rect.x0 - 20 && r.x0 <= draft.rect.x1 + 20 && r.y1 >= draft.rect.y0 - 20 && r.y0 <= draft.rect.y1 + 20;
  const content = [
    ...model.textBoxes.flatMap((b) => b.runs.map((r) => r.bbox)),
    ...model.tables.flatMap((t) => t.cells.flatMap((c) => c.runBoxes ?? [])),
    ...model.backgrounds.filter((b) => b.color === null).map((b) => b.bbox),
  ].filter(near);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return vp.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
  };
  const startVertexDrag = (e: React.MouseEvent, r: number, c: number) => {
    e.stopPropagation();
    e.preventDefault();
    setVsel([r, c]);
    const move = (ev: MouseEvent) => {
      const [x, y] = local(ev);
      const p = ev.altKey ? { x, y, snapped: false } : snapPoint({ x, y }, junctions, radius);
      setMesh((m) => m && moveGridVertex(m, r, c, p, junctions));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const selRow = sel ? Math.max(sel.r0, sel.r1) : rows - 1;
  const selCol = sel ? Math.max(sel.c0, sel.c1) : cols - 1;
  const btn = (label: string, title: string, run: () => void, disabled = false, testId?: string) => (
    <button key={label} type="button" title={title} data-testid={testId} disabled={disabled} className="rounded px-1.5 py-0.5 hover:bg-slate-100 disabled:opacity-40" onClick={run}>
      {label}
    </button>
  );
  const update = (m: Mesh) => {
    setMesh(rectifyMesh(m, junctions));
    setSel(null);
    setVsel(null);
  };
  // A scanned table also sends its colours, measured now on the rendered page: paper, ink, and each cell's background
  // and ink box. Cells are measured inside the band the server crops them by (edit/raster.ts), clear of blurred borders,
  // on a 4 px/pt render: the screen canvas (~1.25 px/pt) puts ink boxes, and so font sizes and minimum cell sizes, a pixel off.
  const rasterLook = async () => {
    if (!draft.raster) return undefined;
    const { ys, xs } = meshLines(mesh);
    const pad = params.borderWidth / 2 + Math.max(1, params.borderWidth / 2);
    const region = await renderRegion(pdf, draft.pageIndex, { x0: xs[0]! - pad, y0: ys[ys.length - 1]! - pad, x1: xs[xs.length - 1]! + pad, y1: ys[0]! + pad }, 4);
    const cells = ys.slice(0, -1).map((_, r) =>
      xs.slice(0, -1).map((_, c) => {
        const a = cellAnchor(mesh, r, c);
        if (a.row !== r || a.col !== c) return null;
        return { x0: xs[c]! + pad, y0: ys[r + a.rowSpan]! + pad, x1: xs[c + a.colSpan]! - pad, y1: ys[r]! - pad };
      }),
    );
    return measureLook(region, region.toPx, cells) ?? undefined;
  };
  const confirm = async () => {
    setMeasuring(true);
    const raster = await rasterLook().finally(() => setMeasuring(false));
    void edit(
      [{ type: 'defineTable', tableId: draft.tableId, pageIndex: draft.pageIndex, vertices: mesh.vertices, spans: mesh.spans, borderWidth: params.borderWidth, headerRows: Math.min(params.headerRows, rows), origin: draft.raster ? 'raster' : 'vector', ...(raster && { raster }) }],
      () => setTool('select'),
    );
  };

  return (
    <>
      <svg ref={svgRef} className="absolute inset-0 z-20" width={vp.width} height={vp.height} data-testid="setup-mesh" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        {anchors.map((a) => {
          const tl = v[a.row]![a.col]!;
          const tr = v[a.row]![a.col + a.colSpan]!;
          const br = v[a.row + a.rowSpan]![a.col + a.colSpan]!;
          const bl = v[a.row + a.rowSpan]![a.col]!;
          return (
            <polygon
              key={`c${a.row},${a.col}`}
              data-testid="setup-cell"
              points={poly([tl, tr, br, bl])}
              fill={inSel(a) ? 'rgba(14,165,233,0.25)' : 'rgba(0,0,0,0.001)'}
              className="cursor-pointer"
              onClick={(e) => {
                setVsel(null);
                setSel(e.shiftKey && sel ? { ...sel, r1: a.row + a.rowSpan - 1, c1: a.col + a.colSpan - 1 } : { r0: a.row, c0: a.col, r1: a.row + a.rowSpan - 1, c1: a.col + a.colSpan - 1 });
              }}
            />
          );
        })}
        {content.map((r, i) => {
          const { cell, bad } = placeContent(mesh, r, params.borderWidth);
          const c = toCss(vp, r);
          return (
            <rect
              key={`t${i}`}
              data-testid="setup-content"
              data-bad={bad}
              x={c.left}
              y={c.top}
              width={c.width}
              height={c.height}
              pointerEvents="none"
              fill={cell ? `hsla(${hue(cell.row, cell.col)},70%,50%,0.25)` : 'none'}
              stroke={bad ? 'rgb(220,38,38)' : 'none'}
            />
          );
        })}
        {edges.map((e) => {
          const [ax, ay] = pt(e.a);
          const [bx, by] = pt(e.b);
          const w = params.borderWidth * zoom;
          const color = e.status === 'ok' ? '124,58,237' : e.status === 'off' ? '220,38,38' : '100,116,139';
          // Band edges: the two lines borderWidth apart, drawn when they are far enough apart to see.
          const len = Math.hypot(bx - ax, by - ay) || 1;
          const nx = (-(by - ay) / len) * (w / 2);
          const ny = ((bx - ax) / len) * (w / 2);
          return (
            <g key={`${e.dir}${e.row},${e.col}`} data-testid="setup-edge" data-status={e.status} pointerEvents="none">
              <line x1={ax} y1={ay} x2={bx} y2={by} stroke={`rgba(${color},${e.status === 'none' ? 0.6 : 0.35})`} strokeWidth={e.status === 'none' ? 1 : Math.max(w, 3)} strokeDasharray={e.status === 'none' ? '3 3' : undefined} />
              {e.status !== 'none' && w >= 4 && (
                <>
                  <line x1={ax + nx} y1={ay + ny} x2={bx + nx} y2={by + ny} stroke={`rgb(${color})`} strokeWidth={0.75} />
                  <line x1={ax - nx} y1={ay - ny} x2={bx - nx} y2={by - ny} stroke={`rgb(${color})`} strokeWidth={0.75} />
                </>
              )}
            </g>
          );
        })}
        {v.map((row, r) =>
          row.map((p, c) => {
            if (!vertexVisible(mesh, r, c)) return null;
            const [x, y] = pt(p);
            const active = vsel?.[0] === r && vsel[1] === c;
            return (
              <circle
                key={`v${r},${c}`}
                data-testid="setup-vertex"
                data-snapped={p.snapped}
                cx={x}
                cy={y}
                r={5}
                fill={p.snapped ? 'rgb(22,163,74)' : 'rgb(234,179,8)'}
                stroke={active ? 'rgb(14,165,233)' : 'white'}
                strokeWidth={active ? 2.5 : 1.5}
                className="cursor-move"
                onMouseDown={(e) => startVertexDrag(e, r, c)}
              >
                <title>{`R${r + 1} C${c + 1}: x ${p.x.toFixed(2)} y ${p.y.toFixed(2)} pt${p.snapped ? ' (on a junction)' : ' (placed by hand)'} — drag (Alt: no snapping), arrows 0.25 pt, Shift 2 pt`}</title>
              </circle>
            );
          }),
        )}
      </svg>
      <div
        data-testid="setup-toolbar"
        className="absolute z-30 flex max-w-[95%] flex-wrap items-center gap-0.5 rounded border border-slate-300 bg-white px-1 py-0.5 text-xs shadow"
        style={{ left: css.left, top: Math.max(0, css.top - 54) }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="px-1 text-slate-500">
          {rows}×{cols}
        </span>
        <label className="flex items-center gap-0.5 px-1" title="Border width: the band must cover the drawn border">
          border
          <input type="number" min={0} step={0.05} value={params.borderWidth} className="w-14 rounded border border-slate-300 px-1" onChange={(e) => setParams({ ...params, borderWidth: Math.max(0, Number(e.target.value)) })} />
          pt
        </label>
        <label className="flex items-center gap-0.5 px-1" title="Header rows">
          header
          <input type="number" min={0} max={rows} step={1} value={params.headerRows} className="w-10 rounded border border-slate-300 px-1" onChange={(e) => setParams({ ...params, headerRows: Math.max(0, Math.round(Number(e.target.value))) })} />
        </label>
        <span className="mx-0.5 border-l border-slate-200 self-stretch" />
        {btn('+Row', `Split row ${selRow + 1} in two`, () => update(changeRows(mesh, selRow, 1, junctions, radius)))}
        {btn('−Row', `Join row ${selRow + 1} with the next one`, () => update(changeRows(mesh, selRow, -1, junctions, radius)), rows < 2)}
        {btn('+Col', `Split column ${selCol + 1} in two`, () => update(changeCols(mesh, selCol, 1, junctions, radius)))}
        {btn('−Col', `Join column ${selCol + 1} with the next one`, () => update(changeCols(mesh, selCol, -1, junctions, radius)), cols < 2)}
        <span className="mx-0.5 border-l border-slate-200 self-stretch" />
        {btn('Merge', 'Merge the selected cells (Shift+click extends the selection)', () => sel && update(mergeCells(mesh, sel.r0, sel.c0, sel.r1, sel.c1)), !sel || (sel.r0 === sel.r1 && sel.c0 === sel.c1), 'setup-merge')}
        {btn('Split', 'Split merged cells in the selection', () => sel && update(splitCells(mesh, sel.r0, sel.c0, sel.r1, sel.c1, junctions, radius)), !sel)}
        {btn('Reset', 'Back to the Step 1 mesh', () => update(initialMesh(draft, params, junctions, radius)))}
        <span className="mx-0.5 border-l border-slate-200 self-stretch" />
        {btn('Cancel', 'Leave the setup without changes', cancel)}
        <button type="button" data-testid="setup-confirm" disabled={busy || measuring} className="rounded bg-sky-600 px-2 py-0.5 text-white disabled:opacity-40" onClick={() => void confirm()}>
          Confirm
        </button>
        {(off.length > 0 || yellow.length > 0) && (
          <div className="basis-full px-1 text-[11px]" data-testid="setup-warnings">
            {off.length > 0 && <div className="text-red-700">{off.length} edge{off.length > 1 ? 's' : ''} outside the band: adjust the border width or the vertices</div>}
            {yellow.length > 0 && (
              <div className="text-amber-700">
                Not on a junction: {yellow.slice(0, 8).map(([r, c]) => `R${r + 1}C${c + 1}`).join(', ')}
                {yellow.length > 8 ? ` +${yellow.length - 8}` : ''}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
