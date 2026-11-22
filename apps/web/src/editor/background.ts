import type { Color, EditOperation, PageModel, Rect } from '@pdf-toolkit/shared';
import type { PdfDoc } from '../lib/pdfjs.ts';
import { toCss, type Viewport } from './PageView.tsx';
import type { Region } from './rasterGrid.ts';

export type Detected = { color: Color; source: 'shape' | 'pixels' };

/** The rendered page, registered by PageView after each render, for the pixel fallback. */
let rendered: { canvas: HTMLCanvasElement; vp: Viewport; pageIndex: number } | null = null;
export const registerCanvas = (r: typeof rendered) => void (rendered = r);

/** `rect` of page `pageIndex` rendered on its own at `pxPerPt` (less if it would exceed 16 Mpx), for measurements finer than the on-screen canvas. */
export async function renderRegion(pdf: PdfDoc, pageIndex: number, rect: Rect, pxPerPt: number): Promise<Region & { toPx: (r: Rect) => Rect }> {
  const page = await pdf.getPage(pageIndex + 1);
  const scale = Math.min(pxPerPt, Math.sqrt(16e6 / Math.max(1, (rect.x1 - rect.x0) * (rect.y1 - rect.y0))));
  const viewport = page.getViewport({ scale });
  const vp = viewport as unknown as Viewport;
  const css = toCss(vp, rect);
  const l = Math.floor(css.left);
  const t = Math.floor(css.top);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(css.left + css.width) - l;
  canvas.height = Math.ceil(css.top + css.height) - t;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  await page.render({ canvas, viewport, transform: [1, 0, 0, 1, -l, -t] }).promise;
  const toPx = (q: Rect): Rect => {
    const c = toCss(vp, q);
    return { x0: c.left - l, y0: c.top - t, x1: c.left + c.width - l, y1: c.top + c.height - t };
  };
  return { img: ctx.getImageData(0, 0, canvas.width, canvas.height), toPage: (x, y) => vp.convertToPdfPoint(l + x + 0.5, t + y + 0.5), toPx };
}

const contains = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

/** Most frequent colour (4 bits per channel) on a ring outside `rect` and outside a fill we painted (1 pt padding), so neither is sampled. */
function sampleRing(rect: Rect): Color | null {
  if (!rendered) return null;
  const { canvas, vp } = rendered;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const ratio = canvas.width / vp.width;
  const css = toCss(vp, { x0: rect.x0 - 2.5, y0: rect.y0 - 2.5, x1: rect.x1 + 2.5, y1: rect.y1 + 2.5 });
  const l = css.left - 2;
  const t = css.top - 2;
  const r = css.left + css.width + 2;
  const b = css.top + css.height + 2;
  const pts: [number, number][] = [];
  for (let x = l; x <= r; x += 2) pts.push([x, t], [x, b]);
  for (let y = t; y <= b; y += 2) pts.push([l, y], [r, y]);
  const bins = new Map<number, { n: number; sum: [number, number, number] }>();
  for (const [x, y] of pts) {
    const px = Math.round(x * ratio);
    const py = Math.round(y * ratio);
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
    const [rr, gg, bb] = ctx.getImageData(px, py, 1, 1).data as unknown as [number, number, number];
    const key = ((rr >> 4) << 8) | ((gg >> 4) << 4) | (bb >> 4);
    const bin = bins.get(key) ?? { n: 0, sum: [0, 0, 0] };
    bin.n++;
    bin.sum[0] += rr;
    bin.sum[1] += gg;
    bin.sum[2] += bb;
    bins.set(key, bin);
  }
  const best = [...bins.values()].sort((a, c) => c.n - a.n)[0];
  if (!best) return null;
  return { space: 'rgb', values: best.sum.map((v) => Math.round(v / best.n) / 255) };
}

/**
 * Background at `rect` on `model`'s page: the topmost filled shape under its centre, else the
 * rendered pixels around it (images, unknown colour spaces, shadings, or nothing painted).
 */
export function detectBackground(model: PageModel, rect: Rect): Detected | null {
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  const top = model.backgrounds.findLast((b) => contains(b.bbox, cx, cy));
  if (top?.color) return { color: top.color, source: 'shape' };
  if (rendered?.pageIndex !== model.pageIndex) return null;
  const px = sampleRing(rect);
  return px ? { color: px, source: 'pixels' } : null;
}

export function isWhite(c: Color): boolean {
  const v = c.values;
  if (c.space === 'gray') return v[0]! >= 0.96;
  if (c.space === 'rgb') return v.every((x) => x >= 0.96);
  if (c.space === 'cmyk') return v.every((x) => x <= 0.04);
  return false;
}

/** Fill under `id` after `ops`: a colour, or null when there is none. */
export function fillOf(ops: EditOperation[], id: string): Color | null {
  let fill: Color | null = null;
  for (const o of ops) {
    if (o.type === 'addTextBox' && o.id === id) fill = o.background ?? null;
    else if ((o.type === 'moveElement' || o.type === 'setTextStyle') && o.elementId === id && o.background !== undefined) fill = o.background;
  }
  return fill;
}

/** Fill for text placed at `rect`: the detected colour over a non-white area; null to drop a stale fill; undefined = leave as is. */
export function fillAt(model: PageModel, rect: Rect, current: Color | null): Color | null | undefined {
  const d = detectBackground(model, rect);
  if (d && !isWhite(d.color)) return d.color;
  return current ? null : undefined;
}

/** moveElement for a box or table; a text box gets the fill detected at its destination. */
export function moveOp(model: PageModel, ops: EditOperation[], id: string, dx: number, dy: number): EditOperation {
  const box = model.textBoxes.find((b) => b.id === id);
  if (!box) return { type: 'moveElement', elementId: id, dx, dy };
  const dest = { x0: box.bbox.x0 + dx, y0: box.bbox.y0 + dy, x1: box.bbox.x1 + dx, y1: box.bbox.y1 + dy };
  const background = fillAt(model, dest, fillOf(ops, id));
  return { type: 'moveElement', elementId: id, dx, dy, ...(background !== undefined && { background }) };
}
