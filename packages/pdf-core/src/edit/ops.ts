import type { Color, Matrix, Rect } from '@pdf-toolkit/shared';
import { invert, mul, translate } from '../math.ts';
import { PdfError } from '../errors.ts';


export const num = (n: number) => String(Number(n.toFixed(4)) || 0);

/** `cm` operator that translates by (dx, dy) in user space when the current CTM is `ctm`. */
export function translateIn(ctm: Matrix, dx: number, dy: number): string {
  const inv = invert(ctm);
  if (!inv) throw new PdfError('UNSUPPORTED', 'Degenerate transformation matrix');
  // Full precision: under a scaled CTM (e.g. an image's) the entries are divided by the scale, and 4 decimals would move it off by up to 0.01 pt.
  return `${mul(mul(ctm, translate(dx, dy)), inv).map((n) => String(Number(n.toPrecision(12)) || 0)).join(' ')} cm`;
}

export function colorOp(c: Color | undefined, stroke: boolean): string {
  const v = c?.values ?? [0];
  const op = c?.space === 'rgb' ? 'rg' : c?.space === 'cmyk' ? 'k' : 'g';
  if (c?.space === 'other') return stroke ? '0 G' : '0 g';
  return `${v.map(num).join(' ')} ${stroke ? op.toUpperCase() : op}`;
}

const BG_PAD = 1;

/** Fill under text: `bbox` in user space, painted where the CTM is `ctm`. */
export function backgroundFill(c: Color, bbox: Rect, ctm: Matrix): string {
  const inv = invert(ctm);
  if (!inv) throw new PdfError('UNSUPPORTED', 'Degenerate transformation matrix');
  const toUser = ctm.every((v, i) => v === [1, 0, 0, 1, 0, 0][i]) ? '' : `${inv.map(num).join(' ')} cm `;
  const r = [bbox.x0 - BG_PAD, bbox.y0 - BG_PAD, bbox.x1 - bbox.x0 + 2 * BG_PAD, bbox.y1 - bbox.y0 + 2 * BG_PAD];
  return `q ${toUser}${colorOp(c, false)} ${r.map(num).join(' ')} re f Q`;
}

export const shiftRect = (r: Rect, dx: number, dy: number): Rect => ({ x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy });

export const union = (rs: Rect[]): Rect => ({ x0: Math.min(...rs.map((r) => r.x0)), y0: Math.min(...rs.map((r) => r.y0)), x1: Math.max(...rs.map((r) => r.x1)), y1: Math.max(...rs.map((r) => r.y1)) });
