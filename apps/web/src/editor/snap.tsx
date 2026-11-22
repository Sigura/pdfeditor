import type { PageModel } from '@pdf-toolkit/shared';
import { toCss, type Viewport } from './PageView.tsx';

export type CssRect = { left: number; top: number; width: number; height: number };
export type Guides = { x: number | null; y: number | null };

/** Edges and centres (CSS px) of the page and of every box and table except `exclude`. */
export function snapTargets(model: PageModel, vp: Viewport, exclude: string): { xs: number[]; ys: number[] } {
  const xs = [0, vp.width / 2, vp.width];
  const ys = [0, vp.height / 2, vp.height];
  for (const el of [...model.textBoxes, ...model.tables]) {
    if (el.id === exclude) continue;
    const r = toCss(vp, el.bbox);
    xs.push(r.left, r.left + r.width / 2, r.left + r.width);
    ys.push(r.top, r.top + r.height / 2, r.top + r.height);
  }
  return { xs, ys };
}

const nearest = (edges: number[], targets: number[], tol: number) => {
  let best: { d: number; at: number } | null = null;
  for (const e of edges) for (const t of targets) if (Math.abs(t - e) <= tol && (!best || Math.abs(t - e) < Math.abs(best.d))) best = { d: t - e, at: t };
  return best;
};

/** Correction that snaps the left/centre/right and top/middle/bottom of `r` to the closest target within `tol` px. */
export function snapRect(r: CssRect, t: { xs: number[]; ys: number[] }, tol = 5): { dx: number; dy: number; guides: Guides } {
  const x = nearest([r.left, r.left + r.width / 2, r.left + r.width], t.xs, tol);
  const y = nearest([r.top, r.top + r.height / 2, r.top + r.height], t.ys, tol);
  return { dx: x?.d ?? 0, dy: y?.d ?? 0, guides: { x: x?.at ?? null, y: y?.at ?? null } };
}

/** Correction that snaps the right and bottom edges of `r` (being resized from its top-left corner). */
export function snapEdges(r: CssRect, t: { xs: number[]; ys: number[] }, tol = 5): { dx: number; dy: number; guides: Guides } {
  const x = nearest([r.left + r.width], t.xs, tol);
  const y = nearest([r.top + r.height], t.ys, tol);
  return { dx: x?.d ?? 0, dy: y?.d ?? 0, guides: { x: x?.at ?? null, y: y?.at ?? null } };
}

/** Correction that snaps a single dragged line at `pos` to the closest of `targets`. */
export function snapLine(pos: number, targets: number[], tol = 5): { d: number; at: number | null } {
  const n = nearest([pos], targets, tol);
  return { d: n?.d ?? 0, at: n?.at ?? null };
}

export function GuideLines({ guides, vp }: { guides: Guides; vp: { width: number; height: number } }) {
  return (
    <>
      {guides.x !== null && <div className="pointer-events-none absolute top-0 z-30 w-px bg-fuchsia-500" style={{ left: guides.x, height: vp.height }} />}
      {guides.y !== null && <div className="pointer-events-none absolute left-0 z-30 h-px bg-fuchsia-500" style={{ top: guides.y, width: vp.width }} />}
    </>
  );
}

/** Small dark label with coordinates or sizes, shown next to what is being dragged. */
export function Readout({ left, top, text }: { left: number; top: number; text: string }) {
  return (
    <div data-testid="readout" className="pointer-events-none absolute z-30 rounded bg-slate-900/85 px-1 text-[10px] leading-4 whitespace-nowrap text-white tabular-nums" style={{ left, top: top - 18 }}>
      {text}
    </div>
  );
}
