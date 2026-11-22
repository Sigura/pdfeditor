import { PDFArray, PDFStream, type PDFDocument, type PDFPage } from 'pdf-lib';
import type { Background, PageModel, Rect, StoredTable, TextBox, TextRun } from '@pdf-toolkit/shared';
import { mul } from '../math.ts';
import { streamBytes } from '../pdf/util.ts';
import { groupBoxes, groupLines, type BoxInternal } from './group.ts';
import { FontCache, interpretPage, type InterpretResult, type RunInternal } from './interpreter.ts';
import { readStoredTables } from './pieceInfo.ts';
import { detectTables, pageJunctions, pageRulings, type TableDefinition, type TableInternal } from './tables.ts';

export type PageAnalysis = {
  pageIndex: number;
  interp: InterpretResult;
  boxes: BoxInternal[];
  tables: TableInternal[];
  /** Table models read from the page's /PieceInfo. */
  stored: StoredTable[];
  model: PageModel;
};

export function pageContentBytes(page: PDFPage): Uint8Array {
  const contents = page.node.Contents();
  if (!contents) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = contents.lookup(i);
      if (s instanceof PDFStream) parts.push(streamBytes(s), Uint8Array.of(0x0a));
    }
  } else if (contents instanceof PDFStream) {
    parts.push(streamBytes(contents));
  }
  return Buffer.concat(parts);
}

export function toTextRun(r: RunInternal, pageIndex: number): TextRun {
  return {
    id: r.id,
    pageIndex,
    text: r.text,
    bbox: r.bbox,
    fontRef: r.font.ref ? `${r.font.ref.objectNumber} ${r.font.ref.generationNumber} R` : `/${r.state.fontKey}`,
    fontName: r.font.cleanName,
    fontSize: r.state.size,
    color: { space: r.fill.space, values: r.fill.values },
    matrix: mul(r.tm, r.ctm),
    charSpacing: r.state.charSpacing,
    wordSpacing: r.state.wordSpacing,
    horizontalScale: r.state.hScale * 100,
    decodable: r.decodable,
    contentStreamRef: { streamId: r.streamId, opStart: r.opIndex, opEnd: r.opIndex + 1 },
  };
}

export function toTextBox(b: BoxInternal, pageIndex: number): TextBox {
  return { id: b.id, runs: b.runs.map((r) => toTextRun(r, pageIndex)), bbox: b.bbox, lineHeight: b.lineHeight, align: b.align, text: b.text };
}

const MAX_BACKGROUNDS = 2000;

/** Filled paths and images big enough to sit behind text, in paint order. Thin fills are rules, not backgrounds. */
export function pageBackgrounds(interp: InterpretResult): Background[] {
  const items: { seq: number; bg: Background }[] = [];
  const big = (r: Rect) => r.x1 - r.x0 > 3 && r.y1 - r.y0 > 3;
  for (const p of interp.paths) {
    if (p.paint !== 'fill' && p.paint !== 'fillStroke') continue;
    const xs = [...p.rects.flatMap((r) => [r.x0, r.x1]), ...p.segments.flatMap((s) => [s.x0, s.x1])];
    const ys = [...p.rects.flatMap((r) => [r.y0, r.y1]), ...p.segments.flatMap((s) => [s.y0, s.y1])];
    if (!xs.length) continue;
    const bbox = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    if (!big(bbox)) continue;
    items.push({ seq: p.seq, bg: { bbox, color: p.fill.space === 'other' ? null : { space: p.fill.space, values: p.fill.values } } });
  }
  for (const im of interp.images) if (big(im.bbox)) items.push({ seq: im.seq, bg: { bbox: im.bbox, color: null } });
  return items
    .sort((a, b) => a.seq - b.seq)
    .slice(-MAX_BACKGROUNDS)
    .map((i) => i.bg);
}

export function analyzePage(doc: PDFDocument, pageIndex: number, fonts: FontCache, defs: TableDefinition[] = []): PageAnalysis {
  const page = doc.getPage(pageIndex);
  const interp = interpretPage(doc.context, pageIndex, pageContentBytes(page), page.node.Resources(), fonts);
  const stored = readStoredTables(page);
  const tables = detectTables(pageIndex, interp.paths, interp.runs, defs, stored.tables, interp.images);
  const rulings = pageRulings(interp.paths);
  const inTables = new Set(tables.flatMap((t) => t.runs));
  const boxes = groupBoxes(groupLines(interp.runs.filter((r) => !inTables.has(r))));
  const { width, height } = page.getSize();
  const mb = page.getMediaBox();
  const cb = page.getCropBox();
  const view: Rect = { x0: cb.x ?? mb.x, y0: cb.y ?? mb.y, x1: (cb.x ?? mb.x) + (cb.width ?? width), y1: (cb.y ?? mb.y) + (cb.height ?? height) };
  const warnings = [...interp.warnings, ...(stored.warning ? [stored.warning] : [])];
  for (const s of interp.streams.values()) {
    if (s.uses > 1) warnings.push(`Form XObject ${s.id} is painted ${s.uses} times; editing its text changes every copy`);
  }
  const fontWarnings = new Set(interp.runs.flatMap((r) => r.font.warnings.map((w) => `${r.font.cleanName}: ${w}`)));
  warnings.push(...fontWarnings);
  const undecodable = interp.runs.filter((r) => !r.decodable && r.codes.length > 0);
  if (undecodable.length) {
    const names = [...new Set(undecodable.map((r) => r.font.cleanName))].join(', ');
    warnings.push(`${undecodable.length} text runs can't be decoded to Unicode (fonts: ${names}); they can be moved or deleted but not edited`);
  }
  let editable = true;
  if (interp.runs.length === 0) {
    const pageArea = width * height;
    const imageArea = interp.images.reduce((s, i) => s + Math.max(0, i.bbox.x1 - i.bbox.x0) * Math.max(0, i.bbox.y1 - i.bbox.y0), 0);
    if (imageArea > 0.4 * pageArea) {
      editable = false;
      warnings.push('Scanned page: it has no text layer, only images. Text editing needs OCR, which this toolkit does not do.');
    }
  }
  return {
    pageIndex,
    interp,
    boxes,
    tables,
    stored: stored.tables,
    model: {
      pageIndex,
      width,
      height,
      rotate: page.getRotation().angle,
      view,
      textBoxes: boxes.map((b) => toTextBox(b, pageIndex)),
      tables: tables.map((t) => t.table),
      backgrounds: pageBackgrounds(interp),
      rulings,
      junctions: pageJunctions(rulings),
      editable,
      warnings,
    },
  };
}

/** `defs` are defineTable setups, keyed by page index. */
export function analyzeDocument(doc: PDFDocument, defs: Map<number, TableDefinition[]> = new Map()): PageAnalysis[] {
  const fonts = new FontCache();
  return doc.getPages().map((_, i) => analyzePage(doc, i, fonts, defs.get(i)));
}
