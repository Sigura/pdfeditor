import type { Align, Rect } from '@pdf-toolkit/shared';
import { unionRect } from '../math.ts';
import type { RunInternal } from './interpreter.ts';

export type LineInternal = { runs: RunInternal[]; bbox: Rect; baseline: number; x0: number; x1: number; size: number; angle: number; text: string };

export type BoxInternal = {
  id: string;
  lines: LineInternal[];
  runs: RunInternal[];
  bbox: Rect;
  lineHeight: number;
  align: Align;
  text: string;
  size: number;
  angle: number;
  /** Rotated or vertical boxes can be moved/deleted but not reflowed. */
  axisAligned: boolean;
};

const ANGLE_EPS = 0.01;

/** Rotates a point into the run's baseline frame so grouping works for any text direction. */
function toFrame(angle: number, x: number, y: number): [number, number] {
  const c = Math.cos(-angle);
  const s = Math.sin(-angle);
  return [x * c - y * s, x * s + y * c];
}

function joinLineText(runs: RunInternal[], angle: number, size: number): string {
  let text = '';
  let prevEnd: number | null = null;
  for (const r of runs) {
    const [sx] = toFrame(angle, r.origin[0], r.origin[1]);
    const [ex] = toFrame(angle, r.end[0], r.end[1]);
    if (prevEnd !== null && sx - prevEnd > 0.2 * size && !text.endsWith(' ') && !r.text.startsWith(' ')) text += ' ';
    text += r.text;
    prevEnd = ex;
  }
  return text;
}

export function groupLines(runs: RunInternal[]): LineInternal[] {
  const visible = runs.filter((r) => r.state.render !== 3 && r.text.trim() !== '' && r.userSize > 0.5);
  const byAngle = new Map<number, RunInternal[]>();
  for (const r of visible) {
    const key = Math.round(r.angle / ANGLE_EPS);
    const list = byAngle.get(key) ?? [];
    list.push(r);
    byAngle.set(key, list);
  }
  const lines: LineInternal[] = [];
  for (const group of byAngle.values()) {
    const angle = group[0]!.angle;
    const items = group
      .map((r) => {
        const [x0, y] = toFrame(angle, r.origin[0], r.origin[1]);
        const [x1] = toFrame(angle, r.end[0], r.end[1]);
        return { r, x0, x1, y };
      })
      .sort((a, b) => b.y - a.y || a.x0 - b.x0);
    type Open = { items: typeof items; y: number; x0: number; x1: number; size: number };
    const open: Open[] = [];
    for (const it of items) {
      const size = it.r.userSize;
      let target: Open | undefined;
      for (const l of open) {
        if (Math.abs(l.y - it.y) > 0.3 * Math.max(size, l.size)) continue;
        const gap = it.x0 - l.x1;
        if (gap > 1.0 * Math.max(size, l.size) || gap < -0.5 * size) continue;
        target = l;
        break;
      }
      if (!target) {
        target = { items: [], y: it.y, x0: it.x0, x1: it.x1, size };
        open.push(target);
      }
      target.items.push(it);
      target.x0 = Math.min(target.x0, it.x0);
      target.x1 = Math.max(target.x1, it.x1);
      target.size = Math.max(target.size, size);
    }
    for (const l of open) {
      const sorted = l.items.sort((a, b) => a.x0 - b.x0).map((i) => i.r);
      lines.push({
        runs: sorted,
        bbox: sorted.map((r) => r.bbox).reduce(unionRect),
        baseline: l.y,
        x0: l.x0,
        x1: l.x1,
        size: l.size,
        angle,
        text: joinLineText(sorted, angle, l.size),
      });
    }
  }
  return lines;
}

export function groupBoxes(lines: LineInternal[]): BoxInternal[] {
  const sorted = lines.slice().sort((a, b) => Math.round(a.angle / ANGLE_EPS) - Math.round(b.angle / ANGLE_EPS) || b.baseline - a.baseline || a.x0 - b.x0);
  const boxes: LineInternal[][] = [];
  for (const line of sorted) {
    let joined = false;
    for (const box of boxes) {
      const last = box[box.length - 1]!;
      if (Math.round(last.angle / ANGLE_EPS) !== Math.round(line.angle / ANGLE_EPS)) continue;
      const ratio = line.size / last.size;
      if (ratio < 0.8 || ratio > 1.25) continue;
      const dy = last.baseline - line.baseline;
      const ref = Math.max(line.size, last.size);
      if (dy < 0.7 * ref || dy > 1.9 * ref) continue;
      if (box.length >= 2) {
        const prevDy = box[box.length - 2]!.baseline - last.baseline;
        if (Math.abs(dy - prevDy) > 0.35 * ref) continue;
      }
      const bx0 = Math.min(...box.map((l) => l.x0));
      const bx1 = Math.max(...box.map((l) => l.x1));
      const overlap = Math.min(bx1, line.x1) - Math.max(bx0, line.x0);
      if (overlap < 0.3 * Math.min(bx1 - bx0, line.x1 - line.x0)) continue;
      box.push(line);
      joined = true;
      break;
    }
    if (!joined) boxes.push([line]);
  }
  return boxes.map((ls) => toBox(ls));
}

export function toBox(lines: LineInternal[]): BoxInternal {
  const runs = lines.flatMap((l) => l.runs);
  const angle = lines[0]!.angle;
  const size = Math.max(...lines.map((l) => l.size));
  let lineHeight = size * 1.2;
  if (lines.length > 1) lineHeight = (lines[0]!.baseline - lines[lines.length - 1]!.baseline) / (lines.length - 1);
  let align: Align = 'left';
  if (lines.length > 1) {
    const tol = Math.max(1, size * 0.15);
    const spread = (vals: number[]) => Math.max(...vals) - Math.min(...vals);
    const lefts = lines.map((l) => l.x0);
    const rights = lines.map((l) => l.x1);
    const centers = lines.map((l) => (l.x0 + l.x1) / 2);
    const bodyRights = rights.slice(0, -1);
    if (spread(lefts) <= tol) align = lines.length >= 3 && spread(bodyRights) <= tol && spread(rights) > tol ? 'justify' : 'left';
    else if (spread(centers) <= tol) align = 'center';
    else if (spread(rights) <= tol) align = 'right';
  }
  return {
    id: `b-${runs[0]!.id}`,
    lines,
    runs,
    bbox: lines.map((l) => l.bbox).reduce(unionRect),
    lineHeight,
    align,
    text: lines.map((l) => l.text).join('\n'),
    size,
    angle,
    axisAligned: Math.abs(angle) < ANGLE_EPS,
  };
}
