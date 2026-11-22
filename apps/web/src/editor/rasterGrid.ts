import type { Color, Point, Rect, Ruling } from '@pdf-toolkit/shared';

export type Pixels = { data: Uint8ClampedArray; width: number; height: number };
/** Pixel grid of a rendered page region: `toPage` maps a pixel centre to page coordinates. */
export type Region = { img: Pixels; toPage: (x: number, y: number) => [number, number] };

const lum = (d: Uint8ClampedArray, i: number) => 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;

/** Otsu threshold of the region's luminance: ink below, paper and light fills above. */
function otsu(img: Pixels): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < img.data.length; i += 4) hist[Math.round(lum(img.data, i))]!++;
  const total = img.width * img.height;
  const sumAll = hist.reduce((s, n, v) => s + n * v, 0);
  let [best, bestVar, wB, sumB] = [128, -1, 0, 0];
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (!wB || wB === total) continue;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / (total - wB);
    const v = wB * (total - wB) * (mB - mF) ** 2;
    if (v > bestVar) [bestVar, best] = [v, t];
  }
  return best;
}

/**
 * Border lines of a scanned table: dark runs at least `minLen` px long (horizontal and vertical
 * opening, gaps up to 2 px bridged), stacked runs joined into one line no thicker than `maxWidth` pt
 * (thicker ones are filled shapes or bold text), then their crossings. Runs from half `minLen` are
 * stacked too, so a word about `minLen` long, whose antialiased rows fall on both sides of it, stays
 * one thick stack instead of thin slices that pass for lines.
 */
export function detectLines(region: Region, minLen: number, maxWidth = 4): { rulings: Ruling[]; junctions: Point[] } {
  const { img, toPage } = region;
  const t = otsu(img);
  const dark = new Uint8Array(img.width * img.height);
  for (let i = 0; i < dark.length; i++) dark[i] = lum(img.data, i * 4) < t ? 1 : 0;
  const ptPerPx = Math.hypot(toPage(1, 0)[0] - toPage(0, 0)[0], toPage(1, 0)[1] - toPage(0, 0)[1]);
  const rulings: Ruling[] = [];
  for (const horiz of [true, false]) {
    const [n, len] = horiz ? [img.height, img.width] : [img.width, img.height];
    const at = (line: number, k: number) => dark[horiz ? line * img.width + k : k * img.width + line]!;
    type Group = { lines: number[]; a: number; b: number; last: number };
    const groups: Group[] = [];
    for (let line = 0; line < n; line++) {
      let k = 0;
      while (k < len) {
        if (!at(line, k)) {
          k++;
          continue;
        }
        let end = k;
        let gap = 0;
        for (let j = k; j < len && gap <= 2; j++) {
          if (at(line, j)) [end, gap] = [j, 0];
          else gap++;
        }
        if (end - k + 1 >= minLen / 2) {
          const g = groups.find((x) => x.last === line - 1 && Math.min(x.b, end) - Math.max(x.a, k) > 0.5 * Math.min(x.b - x.a, end - k));
          if (g) [g.a, g.b, g.last] = [Math.min(g.a, k), Math.max(g.b, end), line];
          if (g) g.lines.push(line);
          else groups.push({ lines: [line], a: k, b: end, last: line });
        }
        k = end + 1;
      }
    }
    for (const g of groups.filter((x) => x.b - x.a + 1 >= minLen)) {
      const mid = (g.lines[0]! + g.lines[g.lines.length - 1]!) / 2;
      const [p, q] = horiz ? [toPage(g.a, mid), toPage(g.b, mid)] : [toPage(mid, g.a), toPage(mid, g.b)];
      const h = Math.abs(q[0] - p[0]) > Math.abs(q[1] - p[1]);
      rulings.push({ dir: h ? 'h' : 'v', pos: h ? (p[1] + q[1]) / 2 : (p[0] + q[0]) / 2, a: h ? Math.min(p[0], q[0]) : Math.min(p[1], q[1]), b: h ? Math.max(p[0], q[0]) : Math.max(p[1], q[1]), width: g.lines.length * ptPerPx });
    }
  }
  // Antialiased edges can split one line into neighbouring runs: join those that overlap.
  const lines: Ruling[] = [];
  for (const r of rulings.sort((p, q) => p.pos - q.pos)) {
    const m = lines.find((l) => l.dir === r.dir && Math.abs(l.pos - r.pos) <= Math.max(1, (l.width + r.width) / 2) && Math.min(l.b, r.b) > Math.max(l.a, r.a));
    if (!m) {
      lines.push({ ...r });
      continue;
    }
    const lo = Math.min(m.pos - m.width / 2, r.pos - r.width / 2);
    const hi = Math.max(m.pos + m.width / 2, r.pos + r.width / 2);
    Object.assign(m, { pos: (lo + hi) / 2, width: hi - lo, a: Math.min(m.a, r.a), b: Math.max(m.b, r.b) });
  }
  const thin = lines.filter((l) => l.width <= maxWidth);
  const junctions: Point[] = [];
  for (const h of thin.filter((r) => r.dir === 'h')) {
    for (const v of thin.filter((r) => r.dir === 'v')) {
      const th = 1 + v.width / 2;
      const tv = 1 + h.width / 2;
      if (v.pos < h.a - th || v.pos > h.b + th || h.pos < v.a - tv || h.pos > v.b + tv) continue;
      if (!junctions.some((p) => Math.abs(p.x - v.pos) <= 1 && Math.abs(p.y - h.pos) <= 1)) junctions.push({ x: v.pos, y: h.pos });
    }
  }
  return { rulings: thin, junctions };
}

/** Most frequent colour (4 bits per channel bins, averaged) of the pixels `keep` accepts. */
function dominant(img: Pixels, keep: (x: number, y: number, l: number) => boolean): Color | null {
  const bins = new Map<number, { n: number; sum: [number, number, number] }>();
  const d = img.data;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (!keep(x, y, lum(d, i))) continue;
      const key = ((d[i]! >> 4) << 8) | ((d[i + 1]! >> 4) << 4) | (d[i + 2]! >> 4);
      const bin = bins.get(key) ?? { n: 0, sum: [0, 0, 0] };
      bin.n++;
      bin.sum[0] += d[i]!;
      bin.sum[1] += d[i + 1]!;
      bin.sum[2] += d[i + 2]!;
      bins.set(key, bin);
    }
  }
  const best = [...bins.values()].sort((a, b) => b.n - a.n)[0];
  return best ? { space: 'rgb', values: best.sum.map((v) => Math.round(v / best.n) / 255) } : null;
}

export type InkBox = Rect & { line: number; ascent: number };

const BASELINE_DENSE = 0.4;

/**
 * Box of the dark pixels in pixel rect `p` (page space) and the height of its tallest run of inked
 * pixel rows, which is one line of text. Null when it has no ink or is mostly dark (a dark fill).
 */
function inkBox(region: Region, p: Rect, t: number): InkBox | null {
  const { img, toPage } = region;
  const [x0, y0, x1, y1] = [Math.max(0, Math.ceil(p.x0) + 1), Math.max(0, Math.ceil(p.y0) + 1), Math.min(img.width, Math.floor(p.x1) - 1), Math.min(img.height, Math.floor(p.y1) - 1)];
  let [bx0, by0, bx1, by1, n] = [Infinity, Infinity, -1, -1, 0];
  let [run, tallest, tallestEnd] = [0, 0, 0];
  const counts: number[] = [];
  for (let y = y0; y < y1; y++) {
    let inked = 0;
    for (let x = x0; x < x1; x++) {
      if (lum(img.data, (y * img.width + x) * 4) >= t) continue;
      inked++;
      n++;
      [bx0, by0, bx1, by1] = [Math.min(bx0, x), Math.min(by0, y), Math.max(bx1, x), Math.max(by1, y)];
    }
    counts.push(inked);
    run = inked ? run + 1 : 0;
    if (run > tallest) [tallest, tallestEnd] = [run, y];
  }
  // Baseline of the tallest line: its last row with at least DENSE of its busiest row's ink; only descenders hang below it.
  const rows = counts.slice(tallestEnd - y0 - tallest + 1, tallestEnd - y0 + 1);
  const busiest = Math.max(0, ...rows);
  let base = rows.length - 1;
  while (base > 0 && rows[base]! < BASELINE_DENSE * busiest) base--;
  if (!n || n > 0.5 * (x1 - x0) * (y1 - y0)) return null;
  const a = toPage(bx0 - 0.5, by0 - 0.5);
  const b = toPage(bx1 + 0.5, by1 + 0.5);
  const ptPerPx = Math.hypot(toPage(0, 1)[0] - toPage(0, 0)[0], toPage(0, 1)[1] - toPage(0, 0)[1]);
  return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]), line: tallest * ptPerPx, ascent: (base + 1) * ptPerPx };
}

/**
 * Colours of a scanned table: paper (most common light colour), ink (most common dark colour), the
 * background of each cell interior (`cells[row][col]`, null for covered cells or where it is paper)
 * and the box of its ink (null for covered or empty cells).
 */
export function measureLook(region: Region, toPx: (r: Rect) => Rect, cells: (Rect | null)[][]): { paper: Color; ink?: Color; fills: (Color | null)[][]; inkBoxes: (InkBox | null)[][] } | null {
  const t = otsu(region.img);
  const paper = dominant(region.img, (_x, _y, l) => l >= t);
  if (!paper) return null;
  const ink = dominant(region.img, (_x, _y, l) => l < t);
  const near = (a: Color, b: Color) => a.values.every((v, i) => Math.abs(v - b.values[i]!) <= 10 / 255);
  const fills = cells.map((row) =>
    row.map((r) => {
      if (!r) return null;
      const p = toPx(r);
      const c = dominant(region.img, (x, y, l) => l >= t && x >= p.x0 && x < p.x1 && y >= p.y0 && y < p.y1);
      return c && !near(c, paper) ? c : null;
    }),
  );
  const inkBoxes = cells.map((row) => row.map((r) => (r ? inkBox(region, toPx(r), t) : null)));
  return { paper, ...(ink && { ink }), fills, inkBoxes };
}

/**
 * Ink rows of a scanned page (outside nothing: the server skips rows inside tables): runs of pixel rows
 * with ink, joined across gaps under 1 pt, in page coordinates, top first; plus the paper colour.
 */
export function scanLayout(region: Region, pxPerPt: number): { lines: { y0: number; y1: number }[]; paper: Color } | null {
  const { img } = region;
  // A page is mostly paper, which skews Otsu towards the darkest ink; halfway between paper (median) and ink (1st percentile) instead.
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < img.data.length; i += 4) hist[Math.round(lum(img.data, i))]!++;
  const quantile = (q: number) => {
    let acc = 0;
    return hist.findIndex((n) => (acc += n) >= q * img.width * img.height);
  };
  const [ink, paperLum] = [quantile(0.01), quantile(0.5)];
  if (paperLum - ink < 40) return { lines: [], paper: dominant(img, () => true)! };
  const t = (ink + paperLum) / 2;
  const minInk = Math.max(3, img.width * 0.002);
  const inked = Array.from({ length: img.height }, (_, y) => {
    let n = 0;
    for (let x = 0; x < img.width; x++) if (lum(img.data, (y * img.width + x) * 4) < t) n++;
    return n >= minInk;
  });
  const runs: [number, number][] = [];
  inked.forEach((on, y) => {
    if (!on) return;
    const last = runs.at(-1);
    if (last && y - last[1] <= pxPerPt) last[1] = y;
    else runs.push([y, y]);
  });
  const paper = dominant(img, (_x, _y, l) => l >= t);
  if (!paper) return null;
  const yAt = (py: number) => region.toPage(0, py)[1];
  return { lines: runs.map(([a, b]) => ({ y1: yAt(a - 0.5), y0: yAt(b + 0.5) })), paper };
}
