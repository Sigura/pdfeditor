import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { applyEdits } from '../src/edit/apply.ts';
import { planFlow, type FlowPage } from '../src/edit/paging.ts';
import { configureFonts } from '../src/fonts/lookup.ts';
import { loadPdf } from '../src/load.ts';
import { analyzeDocument, pageContentBytes } from '../src/model/extract.ts';
import { PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } from 'pdf-lib';
import { INK_ASCENT_EM, edgeRole, junctionType, meshEdges, type Mesh, type Table } from '@pdf-toolkit/shared';
import { rasterDiff, rasterize } from './helpers.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'fixtures', name)));
/** defineTable for an axis-aligned grid (row lines top→bottom, column lines left→right), nothing merged. */
const defineGrid = (tableId: string, ys: number[], xs: number[]) => ({
  type: 'defineTable' as const,
  tableId,
  pageIndex: 0,
  vertices: ys.map((y) => xs.map((x) => ({ x, y, snapped: false }))),
  spans: [],
  borderWidth: 0,
  headerRows: 0,
  origin: 'vector' as const,
});
const fontsDir = path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/';

async function pdfjsLines(bytes: Uint8Array, pageIndex = 0): Promise<string[]> {
  const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, standardFontDataUrl: fontsDir, verbosity: 0 }).promise;
  const page = await doc.getPage(pageIndex + 1);
  const content = await page.getTextContent();
  const lines: string[] = [];
  let cur = '';
  for (const item of content.items) {
    if (!('str' in item)) continue;
    cur += item.str;
    if (item.hasEOL) {
      lines.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) lines.push(cur.trim());
  await doc.destroy();
  return lines.filter(Boolean);
}

// Font lookup sees only pdf.js's bundled fonts (Liberation Sans .ttf), never the machine's fonts.
beforeEach(() => configureFonts({ dirs: [fontsDir], system: false }));

async function pdfjsItems(bytes: Uint8Array) {
  const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, standardFontDataUrl: fontsDir, verbosity: 0 }).promise;
  const content = await (await doc.getPage(1)).getTextContent();
  const items = content.items.flatMap((i) => ('str' in i && i.str ? [{ str: i.str, x: i.transform[4] as number, y: i.transform[5] as number, w: i.width, size: Math.hypot(i.transform[2] as number, i.transform[3] as number) }] : []));
  await doc.destroy();
  return items;
}

const contentOf = async (bytes: Uint8Array) => Buffer.from(pageContentBytes((await loadPdf(bytes)).doc.getPage(0))).toString('latin1');

const boxId = async (bytes: Uint8Array, index: number, page = 0) => analyzeDocument((await loadPdf(bytes)).doc)[page]!.model.textBoxes[index]!;

describe('S1 text replacement', () => {
  it.each([
    ['latin-standard14.pdf', 0, 'Annual Report 2026', 'Quarterly Report'],
    ['cyrillic-subset.pdf', 1, 'Привет, редактор!\nСъешь же ещё этих мягких французских булок.', 'Это проверка'],
    ['turkish-subset.pdf', 1, "Şişli'de ılık bir gün.\nİğdır ve Muğla.", 'geçirdik'],
    ['simple-truetype.pdf', 1, 'Edited first line.\nEdited second line, quote op.', 'Kerned'],
  ])('%s: edit → save → reopen with pdf.js gives the new text', async (name, index, text, gone) => {
    const original = fixture(name);
    const box = await boxId(original, index);
    const res = await applyEdits(original, [{ type: 'replaceText', elementId: box.id, text }]);
    expect(res.reports).toMatchObject([{ elementId: box.id, strategy: 'original' }]);
    const lines = await pdfjsLines(res.bytes);
    for (const l of text.split('\n')) expect(lines).toContain(l);
    expect(lines.join('\n')).not.toContain(gone);
    expect(res.pages[0]!.textBoxes[index]!.text).toBe(text);
  });

  it('removes the old glyphs from the content stream and keeps advances', async () => {
    const original = fixture('simple-truetype.pdf');
    const box = await boxId(original, 1);
    const res = await applyEdits(original, [{ type: 'replaceText', elementId: box.id, text: 'New text' }]);
    const content = Buffer.from(pageContentBytes((await loadPdf(res.bytes)).doc.getPage(0))).toString('latin1');
    for (const old of ['First line of', 'two show', 'Second line via', 'Kerned', 'TJ array']) expect(content).not.toContain(old);
    // Tj → [-N] TJ, ' → T* [-N] TJ; the untouched heading and the blue run stay byte-identical.
    expect(content).toMatch(/T\* \[-\d+(\.\d+)?\] TJ/);
    expect(content).toContain('(Simple TrueType font, WinAnsi) Tj');
    expect(content).toContain('1 Tc (Spaced blue) Tj');
    expect(await pdfjsLines(res.bytes)).toEqual(['Simple TrueType font, WinAnsi', 'New text', 'Spaced blue']);
  });

  it('leaves the document unchanged when no font has the glyph (NO_GLYPH_SOURCE)', async () => {
    configureFonts({ dirs: [], system: false });
    const original = fixture('cyrillic-subset.pdf');
    const box = await boxId(original, 1);
    const res = await applyEdits(original, [{ type: 'replaceText', elementId: box.id, text: 'Жёлтый' }]);
    expect(res.reports[0]!.strategy).toBe('none');
    expect(res.reports[0]!.warnings[0]).toMatch(/Ж/);
    expect(Buffer.from(res.bytes).equals(Buffer.from(original))).toBe(true);
  });
});

describe('embedded Type1 / bare CFF programs', () => {
  it('parses Type1 charstrings (subrs, seac) and uses them for S1 coverage', async () => {
    const original = fixture('type1-cff.pdf');
    const { doc } = await loadPdf(original);
    const run = analyzeDocument(doc)[0]!.boxes[0]!.runs[0]!;
    const prog = run.font.program().program!;
    expect(prog.kind).toBe('Type1');
    const box = (n: string) => prog.bbox(prog.gidForName(n)!)!;
    expect(box('B')).toEqual({ x0: 40, y0: 0, x1: 600, y1: 680 });
    // seac: Aacute = A plus the acute raised above the cap height.
    expect(box('Aacute').y1).toBeGreaterThan(box('A').y1 + 200);
    const res = await applyEdits(original, [{ type: 'replaceText', elementId: (await boxId(original, 0)).id, text: 'aAe Á' }]);
    expect(res.reports).toMatchObject([{ strategy: 'original', glyphs: { original: 5 } }]);
    expect(await pdfjsLines(res.bytes)).toContain('aAe Á');
  });

  it('checks glyph coverage in a bare CFF (FontFile3/Type1C) program', async () => {
    const original = fixture('type1-cff.pdf');
    const res = await applyEdits(original, [{ type: 'replaceText', elementId: (await boxId(original, 1)).id, text: 'Edited CFF line' }]);
    expect(res.reports).toMatchObject([{ strategy: 'original', glyphs: { original: 15 } }]);
    expect(await pdfjsLines(res.bytes)).toContain('Edited CFF line');
  });
});

describe('S3 emulated glyphs', () => {
  it('draws program outlines, NFD compositions and scaled fallbacks, with an invisible text layer', async () => {
    const original = fixture('type1-cff.pdf');
    const res = await applyEdits(original, [{ type: 'replaceText', elementId: (await boxId(original, 0)).id, text: 'Bé Ж' }]);
    // B: outline from the Type1 program (no code maps to it); é = e + acute; Ж from Liberation Sans.
    expect(res.reports).toMatchObject([{ strategy: 'emulated', substituteFont: 'LiberationSans', glyphs: { original: 2, composed: 1, fallback: 1 } }]);
    const content = await contentOf(res.bytes);
    expect(content.match(/ cm [^Q]* f Q/g)).toHaveLength(4);
    expect(content.match(/3 Tr [\d.]+ Tz [^\n]* Tj 0 Tr 100 Tz/g)).toHaveLength(3);
    expect(await pdfjsLines(res.bytes)).toContain('Bé Ж');
  });

  it('composes ş from s and cedilla of a CFF font at the position of the glyph', async () => {
    const original = fixture('type1-cff.pdf');
    const res = await applyEdits(original, [{ type: 'replaceText', elementId: (await boxId(original, 1)).id, text: 'Serif ş text' }]);
    expect(res.reports).toMatchObject([{ strategy: 'emulated', glyphs: { original: 11, composed: 1, fallback: 0 } }]);
    expect(await pdfjsLines(res.bytes)).toContain('Serif ş text');
    // "Serif " keeps its original glyph positions; ş starts where the original "t" did.
    const before = await pdfjsItems(original);
    const after = await pdfjsItems(res.bytes);
    const at = (items: typeof after, s: string) => items.find((i) => i.str.startsWith(s))!;
    expect(at(after, 'Serif').x).toBeCloseTo(at(before, 'Serif').x, 3);
    const serifSpace = ((556 + 444 + 333 + 278 + 333 + 250) / 1000) * 16; // Times AFM widths at 16 pt
    expect(at(after, 'ş').x).toBeCloseTo(at(before, 'Serif').x + serifSpace, 2);
  });
});

describe('S2 substitute fonts', () => {
  it('embeds a metric-compatible subset (Type0/Identity-H + ToUnicode) and leaves metadata alone', async () => {
    const original = fixture('latin-standard14.pdf');
    const box = await boxId(original, 0);
    const res = await applyEdits(original, [{ type: 'replaceText', elementId: box.id, text: 'Quarterly Raporu ş' }]);
    expect(res.reports).toMatchObject([{ strategy: 'substitute', fontName: 'Helvetica-Bold', substituteFont: 'LiberationSans-Bold' }]);
    expect(await pdfjsLines(res.bytes)).toContain('Quarterly Raporu ş');
    const { doc } = await loadPdf(res.bytes);
    const fonts = doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
    const tk = fonts.lookup(PDFName.of('TK1'), PDFDict);
    expect(tk.get(PDFName.of('Subtype'))?.toString()).toBe('/Type0');
    expect(tk.get(PDFName.of('Encoding'))?.toString()).toBe('/Identity-H');
    expect(tk.get(PDFName.of('ToUnicode'))).toBeInstanceOf(PDFRef);
    expect(tk.get(PDFName.of('BaseFont'))?.toString()).toMatch(/^\/[A-Z]{6}\+LiberationSans-Bold$/);
    // Same size and start position as the original line; /Info is not rewritten.
    const [b0] = await pdfjsItems(original);
    const [a0] = await pdfjsItems(res.bytes);
    expect([a0!.x, a0!.y]).toEqual([b0!.x, b0!.y]);
    const infoNum = (await loadPdf(original)).doc.context.trailerInfo.Info?.toString().split(' ')[0];
    const update = Buffer.from(res.bytes.subarray(original.length)).toString('latin1');
    expect([...update.matchAll(/^(\d+) 0 obj/gm)].map((m) => m[1])).not.toContain(infoNum);
    expect(doc.getTitle()).toBe('latin-standard14');
  });
});

describe('incremental save', () => {
  it('keeps the original bytes as a prefix and appends only changed objects', async () => {
    const original = fixture('latin-standard14.pdf');
    const box = await boxId(original, 0);
    const res = await applyEdits(original, [{ type: 'replaceText', elementId: box.id, text: 'Annual Report' }]);
    expect(res.bytes.length).toBeGreaterThan(original.length);
    expect(Buffer.from(res.bytes.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true);
    const update = Buffer.from(res.bytes.subarray(original.length)).toString('latin1');
    const objs = [...update.matchAll(/^(\d+) 0 obj/gm)].map((m) => Number(m[1]));
    // The page dict (new /Contents) and the new content stream; no metadata, fonts or other pages.
    expect(objs).toHaveLength(2);
    const { doc } = await loadPdf(original);
    const info = doc.context.trailerInfo.Info?.toString().split(' ')[0];
    expect(objs).not.toContain(Number(info));
    expect(update).toMatch(/trailer\n<<[^>]*\/Prev \d+/);
    expect((await loadPdf(res.bytes)).doc.getTitle()).toBe('latin-standard14');
  });
});

describe('moveElement and addTextBox', () => {
  it('moves a box by exactly dx/dy, keeping every glyph position relative to the others', async () => {
    const original = fixture('latin-standard14.pdf');
    const box = await boxId(original, 1);
    const res = await applyEdits(original, [{ type: 'moveElement', elementId: box.id, dx: 25.5, dy: -40 }]);
    expect(res.reports).toMatchObject([{ elementId: box.id, strategy: 'original' }]);
    const before = await pdfjsItems(original);
    const after = await pdfjsItems(res.bytes);
    const lines = box.text.split('\n');
    for (const l of lines) {
      const b = before.find((i) => i.str === l)!;
      const a = after.find((i) => i.str === l)!;
      expect(a.x).toBeCloseTo(b.x + 25.5, 3);
      expect(a.y).toBeCloseTo(b.y - 40, 3);
    }
    // Other text stays where it was.
    expect(after.find((i) => i.str === 'Quarterly Report')).toEqual(before.find((i) => i.str === 'Quarterly Report'));
    expect(res.pages[0]!.textBoxes[1]!.bbox.x0).toBeCloseTo(box.bbox.x0 + 25.5, 1);
  });

  it("adds text in a font the page already uses (S1) or a substitute, at the box's top-left", async () => {
    const original = fixture('latin-standard14.pdf');
    const bbox = { x0: 100, y0: 300, x1: 400, y1: 340 };
    const res = await applyEdits(original, [
      { type: 'addTextBox', id: 'a1', pageIndex: 0, bbox, text: 'Own font text', fontSize: 12, fontFamily: 'Helvetica' },
      { type: 'addTextBox', id: 'a2', pageIndex: 0, bbox: { ...bbox, y0: 200, y1: 240 }, text: 'Привет', fontSize: 12, fontFamily: 'Helvetica' },
    ]);
    expect(res.reports).toMatchObject([
      { elementId: 'a1', strategy: 'original', glyphs: { original: 13 } },
      { elementId: 'a2', strategy: 'substitute', substituteFont: 'LiberationSans' },
    ]);
    const items = await pdfjsItems(res.bytes);
    const own = items.find((i) => i.str === 'Own font text')!;
    expect(own.x).toBeCloseTo(100, 3);
    expect(own.y).toBeCloseTo(340 - 0.718 * 12, 1); // Helvetica ascender 718
    expect(items.map((i) => i.str)).toContain('Привет');
    expect(res.pages[0]!.textBoxes.map((b) => b.id)).toEqual(expect.arrayContaining(['a1', 'a2']));
    expect(Buffer.from(res.bytes.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true);
  });
});

describe('setTextStyle', () => {
  it('recolours, right-aligns and re-spaces a box with its own glyphs, and centres an added box', async () => {
    const original = fixture('latin-standard14.pdf');
    const box = await boxId(original, 1);
    const r0 = box.runs[0]!;
    const size = r0.fontSize * Math.hypot(r0.matrix[2], r0.matrix[3]);
    const bbox = { x0: 100, y0: 150, x1: 400, y1: 190 };
    const res = await applyEdits(original, [
      { type: 'setTextStyle', elementId: box.id, color: { space: 'rgb', values: [1, 0, 0] }, align: 'right', lineSpacing: 2 },
      { type: 'addTextBox', id: 'c1', pageIndex: 0, bbox, text: 'Centred', fontSize: 12, fontFamily: 'Helvetica' },
      { type: 'setTextStyle', elementId: 'c1', align: 'center' },
    ]);
    expect(res.reports).toMatchObject([{ elementId: box.id, strategy: 'original' }, { elementId: 'c1', strategy: 'original' }]);
    const before = await pdfjsItems(original);
    const after = await pdfjsItems(res.bytes);
    const lines = box.text.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    const right = Math.max(...lines.map((l) => before.find((i) => i.str === l)!.x + before.find((i) => i.str === l)!.w));
    const top = before.find((i) => i.str === lines[0])!.y;
    lines.forEach((l, k) => {
      const a = after.find((i) => i.str === l)!;
      expect(a.x + a.w).toBeCloseTo(right, 1);
      expect(a.y).toBeCloseTo(top - k * 2 * size, 3);
    });
    expect(await contentOf(res.bytes)).toContain('1 0 0 rg');
    expect(res.pages[0]!.textBoxes[1]).toMatchObject({ align: 'right', lineHeight: 2 * size, text: box.text });
    const c = after.find((i) => i.str === 'Centred')!;
    expect(c.x + c.w / 2).toBeCloseTo(250, 1);
  });
});

describe('background fill', () => {
  it('lists filled shapes in the model and paints a fill under moved and added text only when asked', async () => {
    const original = fixture('table.pdf');
    const model = analyzeDocument((await loadPdf(original)).doc)[0]!.model;
    const header = model.tables[0]!.cells[0]!;
    const behind = model.backgrounds.filter((b) => b.bbox.x0 <= header.bbox.x0 + 1 && b.bbox.x1 >= header.bbox.x1 - 1 && b.bbox.y0 <= header.bbox.y0 + 1 && b.bbox.y1 >= header.bbox.y1 - 1);
    expect(behind.at(-1)?.color).toEqual(header.fill);

    const box = model.textBoxes[0]!;
    const grey = { space: 'gray' as const, values: [0.8] };
    const res = await applyEdits(original, [
      { type: 'moveElement', elementId: box.id, dx: 10, dy: -20, background: grey },
      { type: 'addTextBox', id: 'n1', pageIndex: 0, bbox: { x0: 100, y0: 100, x1: 300, y1: 130 }, text: 'New', fontSize: 12, fontFamily: 'Helvetica', background: { space: 'rgb', values: [1, 1, 0] } },
      { type: 'addTextBox', id: 'n2', pageIndex: 0, bbox: { x0: 100, y0: 50, x1: 300, y1: 80 }, text: 'Plain', fontSize: 12, fontFamily: 'Helvetica', background: null },
    ]);
    const content = await contentOf(res.bytes);
    const moved = res.pages[0]!.textBoxes.find((b) => b.id === box.id)!.bbox;
    // The fill is drawn in the moved coordinate system, so its rect is the box before the move (plus padding).
    const fill = content.match(/q 0\.8 g ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re f Q\n/);
    expect(fill).not.toBeNull();
    const [x, y, w, h] = fill!.slice(1).map(Number) as [number, number, number, number];
    expect(x + 10).toBeCloseTo(moved.x0 - 1, 1);
    expect(y - 20 + h).toBeCloseTo(moved.y1 + 1, 1);
    expect(w).toBeCloseTo(moved.x1 - moved.x0 + 2, 1);
    expect(content.indexOf('0.8 g')).toBeLessThan(content.indexOf('BT', content.indexOf('0.8 g')));
    // Moved with a fill, the text is drawn after the header fill painted later in the original stream, not hidden under it.
    expect(content.indexOf('0.8 g')).toBeGreaterThan(content.indexOf('0.85 0.9 0.97 rg'));
    expect(content).toMatch(/q 1 1 0 rg 99 [-\d.]+ 202 [-\d.]+ re f Q\nq BT/);
    expect(content.match(/re f Q/g)).toHaveLength(2);

    const off = await applyEdits(original, [
      { type: 'moveElement', elementId: box.id, dx: 10, dy: -20 },
      { type: 'setTextStyle', elementId: box.id, background: grey },
      { type: 'moveElement', elementId: box.id, dx: 5, dy: 0 },
      { type: 'setTextStyle', elementId: box.id, background: null },
    ]);
    expect(await contentOf(off.bytes)).not.toContain('0.8 g');
  });
});

describe('tables', () => {
  const tableOf = async (bytes: Uint8Array) => analyzeDocument((await loadPdf(bytes)).doc)[0]!.model;

  it('detects the bordered grid, cell text and header fill; cell text is not a free text box', async () => {
    const m = await tableOf(fixture('table.pdf'));
    expect(m.tables).toHaveLength(1);
    const t = m.tables[0]!;
    expect([t.rows.length, t.cols.length, t.bordered, t.confidence]).toEqual([4, 4, true, 1]);
    expect(t.cells.map((c) => c.text)).toEqual(['Item', 'Qty', 'Price', 'Total', 'Apples', '10', '1.20', '12.00', 'Pears', '4', '2.50', '10.00', 'Cherries', '200', '0.10', '20.00']);
    expect(t.cells.filter((c) => c.fill).map((c) => c.row)).toEqual([0, 0, 0, 0]);
    expect(m.textBoxes.map((b) => b.text.split('\n')[0])).toEqual(['Inventory', 'Text below the table moves when rows are added or removed.']);
  });

  it('inserts a row: untouched cells keep their exact positions, rows below and text under the table shift by one row', async () => {
    const original = fixture('table.pdf');
    const t = (await tableOf(original)).tables[0]!;
    const res = await applyEdits(original, [
      { type: 'tableInsertRow', tableId: t.id, index: 1, position: 'below' },
      { type: 'setCellText', tableId: t.id, row: 2, col: 0, text: 'Bananas' },
      { type: 'setCellText', tableId: t.id, row: 1, col: 3, text: '12.50' },
    ]);
    expect(res.reports.every((r) => r.strategy === 'original')).toBe(true);
    const before = await pdfjsItems(original);
    const after = await pdfjsItems(res.bytes);
    const pos = (items: typeof after, s: string) => items.find((i) => i.str === s)!;
    for (const s of ['Item', 'Total', 'Apples', '1.20']) expect(pos(after, s)).toEqual(pos(before, s));
    for (const s of ['Pears', '20.00', 'Text below the table moves when rows are added or removed.']) {
      expect(pos(after, s).x).toBeCloseTo(pos(before, s).x, 3);
      expect(pos(after, s).y).toBeCloseTo(pos(before, s).y - 24, 3);
    }
    // New cell text in the column's style, at the same offset inside its cell as the row above.
    expect(pos(after, 'Bananas').x).toBeCloseTo(pos(before, 'Apples').x, 3);
    expect(pos(after, 'Bananas').y).toBeCloseTo(pos(before, 'Apples').y - 24, 3);
    expect(pos(after, '12.50')).toEqual({ ...pos(before, '12.00'), str: '12.50' });
    expect(after.map((i) => i.str)).not.toContain('12.00');
    const nt = res.pages[0]!.tables[0]!;
    expect(nt.rows).toHaveLength(5);
    expect(nt.bbox.y0).toBeCloseTo(t.bbox.y0 - 24, 3);
    // The old ruling lines are no longer painted; the regenerated grid has 6 horizontal and 5 vertical lines.
    const content = await contentOf(res.bytes);
    expect(content.match(/ m [\d.]+ [\d.]+ l S/g)).toHaveLength(11);
  });

  it('deletes a column and defines a borderless table with defineTable', async () => {
    const original = fixture('table.pdf');
    const t = (await tableOf(original)).tables[0]!;
    const res = await applyEdits(original, [{ type: 'tableDeleteCol', tableId: t.id, index: 1 }]);
    const after = (await pdfjsItems(res.bytes)).map((i) => i.str);
    expect(after).not.toContain('Qty');
    expect(after).not.toContain('200');
    expect(res.pages[0]!.tables[0]!.cells.slice(0, 3).map((c) => c.text)).toEqual(['Item', 'Price', 'Total']);

    // Grid over the two lines under the table: one row per line.
    const grid = await applyEdits(original, [
      defineGrid('g1', [615, 595, 575], [55, 420]),
      { type: 'setCellText', tableId: 'g1', row: 1, col: 0, text: 'Second line, edited.' },
    ]);
    const g = grid.pages[0]!.tables.find((x) => x.id === 'g1')!;
    expect(g.bordered).toBe(false);
    expect(g.cells.map((c) => c.text)).toEqual(['Text below the table moves when rows are added or removed.', 'Second line, edited.']);
    expect(grid.pages[0]!.textBoxes.map((b) => b.text)).toEqual(['Inventory']);
    expect(await pdfjsLines(grid.bytes)).toContain('Second line, edited.');

    // A table under a growing table moves down with it.
    const both = await applyEdits(original, [
      defineGrid('g1', [615, 595, 575], [55, 420]),
      { type: 'tableInsertRow', tableId: t.id, index: 0, position: 'below' },
    ]);
    const line = (await pdfjsItems(both.bytes)).find((i) => i.str === 'A second line under the table.')!;
    expect(line.y).toBeCloseTo(585 - 24, 3);
    expect(both.pages[0]!.tables.find((x) => x.id === 'g1')!.bbox.y1).toBeCloseTo(615 - 24, 3);
  });
});

describe('table pattern and persistence (zebra-table.pdf)', () => {
  const analyze = async (bytes: Uint8Array) => analyzeDocument((await loadPdf(bytes)).doc)[0]!;
  const grid = (t: Table) => ({ ys: [t.rows[0]!.y1, ...t.rows.map((r) => r.y0)], xs: [t.cols[0]!.x0, ...t.cols.map((c) => c.x1)] });
  const spansOf = (t: Table) => t.cells.flatMap((c) => (c.rowSpan || c.colSpan ? [{ row: c.row, col: c.col, rowSpan: c.rowSpan ?? 1, colSpan: c.colSpan ?? 1 }] : []));
  /** The Table tool's Confirm with the detected defaults: header row 1, band as wide as the thickest border. */
  const defineDetected = (t: Table) => {
    const { ys, xs } = grid(t);
    return { type: 'defineTable' as const, tableId: t.id, pageIndex: 0, vertices: ys.map((y) => xs.map((x) => ({ x, y, snapped: true }))), spans: spansOf(t), borderWidth: 1.6, headerRows: 1, origin: 'vector' as const };
  };
  const meshOf = (t: Table): Mesh => {
    const { ys, xs } = grid(t);
    return { vertices: ys.map((y) => xs.map((x) => ({ x, y, snapped: true }))), spans: spansOf(t) };
  };

  it('add 2 rows, remove 1: every junction and edge piece is pixel-identical to the original, zebra fills continue, the merged Total row survives', async () => {
    const original = fixture('zebra-table.pdf');
    const a0 = await analyze(original);
    const t0 = a0.model.tables[0]!;
    expect(spansOf(t0)).toEqual([{ row: 4, col: 0, rowSpan: 1, colSpan: 3 }]);
    expect(t0.pattern!.zebra).toHaveLength(2);
    const res = await applyEdits(original, [
      defineDetected(t0),
      { type: 'tableInsertRow', tableId: t0.id, index: 3, position: 'below' },
      { type: 'tableInsertRow', tableId: t0.id, index: 1, position: 'above' },
      { type: 'tableDeleteRow', tableId: t0.id, index: 2 },
    ]);
    const a1 = await analyze(res.bytes);
    const t1 = a1.model.tables[0]!;
    expect(t1.rows).toHaveLength(6);
    expect(spansOf(res.pages[0]!.tables[0]!)).toEqual([{ row: 5, col: 0, rowSpan: 1, colSpan: 3 }]);
    expect(res.pages[0]!.tables[0]!.cells.filter((c) => c.row === 5 && !c.covered).map((c) => c.text)).toEqual(['Total', '42.00']);
    // The re-detected table proposes the same merge, from the drawn borders alone.
    expect(spansOf(t1)).toEqual([{ row: 5, col: 0, rowSpan: 1, colSpan: 3 }]);

    const SCALE = 8;
    const strokes = (a: typeof a0, x: number, y: number, rx: number, ry: number) => rasterize(a.tables[0]!.paths, { x0: x - rx, y0: y - ry, x1: x + rx, y1: y + ry }, SCALE, 'stroke');
    const pieces = (t: Table) => {
      const m = meshOf(t);
      const { ys, xs } = grid(t);
      // A junction piece is its type plus the roles of the lines meeting there (a tee on the header separator looks different from one on a body row).
      const junctions = m.vertices.flatMap((row, r) => row.map((p, c) => ({ type: junctionType(m, r, c), key: `${junctionType(m, r, c)}/${edgeRole('h', r, ys.length - 1, 1)}/${edgeRole('v', c, xs.length - 1, 1)}`, p })));
      const edges = meshEdges(m).map((e) => ({ role: edgeRole(e.dir, e.dir === 'h' ? e.row : e.col, e.dir === 'h' ? ys.length - 1 : xs.length - 1, 1), dir: e.dir, mid: { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 } }));
      return { junctions, edges };
    };
    const p0 = pieces(t0);
    const p1 = pieces(t1);
    const types = new Set(p0.junctions.map((j) => j.type).filter(Boolean));
    expect(types.size).toBe(9);
    for (const j of p1.junctions) {
      if (!j.type) continue;
      const ref = p0.junctions.find((o) => o.key === j.key)!;
      expect(ref, j.key).toBeDefined();
      expect(rasterDiff(strokes(a1, j.p.x, j.p.y, 5, 5), strokes(a0, ref.p.x, ref.p.y, 5, 5)), `${j.key} at ${j.p.x},${j.p.y}`).toBe(0);
    }
    for (const e of p1.edges) {
      const ref = p0.edges.find((o) => o.role === e.role)!;
      const [rx, ry] = e.dir === 'h' ? [4, 5] : [5, 4];
      expect(rasterDiff(strokes(a1, e.mid.x, e.mid.y, rx, ry), strokes(a0, ref.mid.x, ref.mid.y, rx, ry)), `${e.role} at ${e.mid.x},${e.mid.y}`).toBe(0);
    }
    // Row fills as drawn, sampled inside the first column: header, zebra (none, grey, none, grey), Total.
    const { ys, xs } = grid(t1);
    const fillAt = (r: number) => rasterize(a1.tables[0]!.paths, { x0: xs[0]! + 10, y0: (ys[r]! + ys[r + 1]!) / 2, x1: xs[0]! + 11, y1: (ys[r]! + ys[r + 1]!) / 2 + 1 }, 1, 'fill')[0]![0];
    expect(ys.slice(0, -1).map((_, r) => fillAt(r))).toEqual(['0.85,0.90,0.97', '', '0.93,0.93,0.93', '', '0.93,0.93,0.93', '1.00,0.96,0.85']);
  });

  it('save → reopen: the TableModel comes back from /PieceInfo (vertices within 1 pt) and further edits keep the pattern', async () => {
    const original = fixture('zebra-table.pdf');
    const t0 = (await analyze(original)).model.tables[0]!;
    expect(t0.setup).toBeUndefined();
    const res = await applyEdits(original, [defineDetected(t0), { type: 'tableInsertRow', tableId: t0.id, index: 3, position: 'below' }]);
    const saved = res.pages[0]!.tables[0]!;
    const reopened = (await analyze(res.bytes)).model.tables[0]!;
    expect(reopened.setup).toBeDefined();
    expect(reopened.setup!.spans).toEqual(saved.setup!.spans);
    expect(reopened.setup!.headerRows).toBe(1);
    reopened.setup!.vertices.forEach((row, r) =>
      row.forEach((p, c) => {
        expect(Math.abs(p.x - saved.setup!.vertices[r]![c]!.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(p.y - saved.setup!.vertices[r]![c]!.y)).toBeLessThanOrEqual(1);
      }),
    );
    expect(reopened.pattern).toEqual(saved.pattern);
    // One more row on the reopened file: the zebra sequence goes on, the Total row stays merged.
    const again = await applyEdits(res.bytes, [{ type: 'tableInsertRow', tableId: reopened.id, index: 4, position: 'below' }]);
    const t2 = again.pages[0]!.tables[0]!;
    expect(spansOf(t2)).toEqual([{ row: 6, col: 0, rowSpan: 1, colSpan: 3 }]);
    expect(t2.cells.filter((c) => c.col === 0).map((c) => c.fill?.values[0] ?? null)).toEqual([0.85, null, 0.93, null, 0.93, null, 1]);
    expect((await analyze(again.bytes)).model.tables[0]!.setup!.vertices).toHaveLength(8);
  });
});

describe('cell layout, row growth and images (image-table.pdf)', () => {
  const analyze = async (bytes: Uint8Array) => analyzeDocument((await loadPdf(bytes)).doc)[0]!;
  const heights = (t: Table) => t.rows.map((r) => Math.round((r.y1 - r.y0) * 100) / 100);
  const rule = (a: Awaited<ReturnType<typeof analyze>>) => a.interp.paths.find((p) => p.segments.some((s) => Math.abs(s.x1 - s.x0 - 480) < 0.01 && Math.abs(s.y0 - s.y1) < 0.01) && p.paint !== 'none' && !a.tables[0]!.paths.includes(p))!;

  it('long cell value: font size unchanged, text wraps in the cell, the row grows and everything below shifts by the same delta', async () => {
    const original = fixture('image-table.pdf');
    const a0 = await analyze(original);
    const t0 = a0.model.tables[0]!;
    expect(heights(t0)).toEqual([24, 50, 50, 50]);
    const long = 'Fresh from the orchard, picked this morning and packed in recyclable crates for delivery';
    const res = await applyEdits(original, [{ type: 'setCellText', tableId: t0.id, row: 1, col: 2, text: long }]);
    expect(res.reports.every((r) => r.strategy === 'original')).toBe(true);
    expect(res.overflows).toEqual([]);
    const t1 = res.pages[0]!.tables[0]!;
    const grow = t1.rows[1]!.y1 - t1.rows[1]!.y0 - 50;
    expect(grow).toBeGreaterThan(20);
    expect(heights(t1).filter((_, i) => i !== 1)).toEqual([24, 50, 50]);
    const delta = t1.bbox.y0 - t0.bbox.y0;
    expect(delta).toBeCloseTo(-grow, 3);

    const before = await pdfjsItems(original);
    const after = await pdfjsItems(res.bytes);
    const pos = (items: typeof after, s: string) => items.find((i) => i.str === s)!;
    const lines = after.filter((i) => long.includes(i.str.trim()) && i.str.trim().length > 1);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.map((l) => l.str.trim()).join(' ')).toBe(long);
    for (const l of lines) {
      expect(l.size).toBeCloseTo(11, 3);
      expect(l.x).toBeCloseTo(pos(before, 'Fresh').x, 3);
      expect(l.x + l.w).toBeLessThanOrEqual(540 - 5);
    }
    for (const s of ['Item', 'Picture', 'Notes']) expect(pos(after, s)).toEqual(pos(before, s));
    // Middle-aligned neighbours stay centred in the taller row; rows below and content under the table move by delta.
    expect(pos(after, 'Apples').y).toBeCloseTo(pos(before, 'Apples').y - grow / 2, 3);
    for (const s of ['Pears', 'Sweet', 'Text below the table moves with it.']) {
      expect(pos(after, s).x).toBeCloseTo(pos(before, s).x, 3);
      expect(pos(after, s).y).toBeCloseTo(pos(before, s).y + delta, 3);
    }
    const a1 = await analyze(res.bytes);
    expect(a1.interp.images).toHaveLength(2);
    a0.interp.images.forEach((im, i) => {
      const moved = a1.interp.images[i]!;
      expect(moved.ctm.slice(0, 4)).toEqual(im.ctm.slice(0, 4));
      expect(moved.bbox.x0).toBeCloseTo(im.bbox.x0, 3);
      expect(moved.bbox.y0).toBeCloseTo(im.bbox.y0 + delta, 3);
    });
    expect(rule(a1).segments[0]!.y0).toBeCloseTo(rule(a0).segments[0]!.y0 + delta, 3);
  });

  it('image cell: rows added above move the image by translation only, at its original size; a cell smaller than its image is rejected', async () => {
    const original = fixture('image-table.pdf');
    const a0 = await analyze(original);
    const t0 = a0.model.tables[0]!;
    expect(t0.cells.find((c) => c.row === 2 && c.col === 1)!.minSize).toEqual({ width: 44, height: 34 });
    const res = await applyEdits(original, [
      { type: 'tableInsertRow', tableId: t0.id, index: 1, position: 'below' },
      { type: 'tableInsertRow', tableId: t0.id, index: 0, position: 'below' },
    ]);
    const a1 = await analyze(res.bytes);
    const [pic0, pic1] = [a0.interp.images[0]!, a1.interp.images[0]!];
    // Same image XObject, same scale: only the translation part of its matrix changed.
    expect(pic1.ctm.slice(0, 4)).toEqual(pic0.ctm.slice(0, 4));
    expect(pic1.ctm[4]).toBeCloseTo(pic0.ctm[4], 6);
    expect(pic1.ctm[5]).toBeCloseTo(pic0.ctm[5] - 100, 6);
    const cell = res.pages[0]!.tables[0]!.cells.find((c) => c.row === 4 && c.col === 1)!;
    expect(cell.images).toHaveLength(1);
    for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(cell.images![0]![k]).toBeCloseTo(pic1.bbox[k], 6);
    expect(cell.minSize).toEqual({ width: 44, height: 34 });

    await expect(applyEdits(original, [{ type: 'resizeTable', tableId: t0.id, rowHeights: [24, 50, 30, 50] }])).rejects.toThrow(/can't be smaller than 44\.0 × 34\.0 pt/);
    await expect(applyEdits(original, [{ type: 'resizeTable', tableId: t0.id, rowHeights: [24, 50, 34, 50] }])).resolves.toBeDefined();
  });

  it("a column that doesn't fit the page: rejected unless 'shrink', which narrows the other columns and keeps font sizes", async () => {
    const original = fixture('image-table.pdf');
    const t0 = (await analyze(original)).model.tables[0]!;
    const insert = { type: 'tableInsertCol' as const, tableId: t0.id, index: 2, position: 'right' as const };
    await expect(applyEdits(original, [insert])).rejects.toThrow(/exceed the page width by 105\.0 pt/);
    const res = await applyEdits(original, [{ ...insert, fit: 'shrink' }]);
    const t1 = res.pages[0]!.tables[0]!;
    expect(t1.bbox.x0).toBe(60);
    expect(t1.bbox.x1).toBeCloseTo(540, 6);
    expect(t1.cols.map((c) => Math.round((c.x1 - c.x0) * 100) / 100)).toEqual([93.33, 120, 106.67, 160]);
    const after = await pdfjsItems(res.bytes);
    const inTable = after.filter((x) => x.str.trim() && x.y > t1.bbox.y0 && x.y < t1.bbox.y1);
    expect(inTable.length).toBeGreaterThanOrEqual(9);
    for (const i of inTable) expect(i.size).toBeCloseTo(11, 3);
    // Centred header text stays centred in its narrower column.
    const pic = after.find((i) => i.str === 'Picture')!;
    expect(pic.x + pic.w / 2).toBeCloseTo((t1.cols[1]!.x0 + t1.cols[1]!.x1) / 2, 1);
    const img = (await analyze(res.bytes)).interp.images[0]!;
    expect((img.bbox.x0 + img.bbox.x1) / 2).toBeCloseTo((t1.cols[1]!.x0 + t1.cols[1]!.x1) / 2, 6);
  });
});

/** Page rendered by pdf.js at `scale` px/pt, as grey levels; `at(x, y)` reads the pixel at user-space point (x, y). */
async function renderGray(bytes: Uint8Array, scale: number, pageIndex = 0) {
  const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, standardFontDataUrl: fontsDir, verbosity: 0 }).promise;
  const page = await doc.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale });
  type Ctx = { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } };
  const { canvas, context } = (doc.canvasFactory as { create(w: number, h: number): { canvas: unknown; context: Ctx } }).create(vp.width, vp.height);
  await page.render({ canvasContext: context as never, viewport: vp, canvas: canvas as never }).promise;
  const w = Math.round(vp.width);
  const rgba = context.getImageData(0, 0, w, Math.round(vp.height)).data;
  await doc.destroy();
  const ph = vp.height / scale;
  return { at: (x: number, y: number) => rgba[(Math.floor((ph - y) * scale) * w + Math.floor(x * scale)) * 4]! };
}

describe('scanned tables (scanned-table.pdf)', () => {
  const xs = [60, 200, 330, 450, 540];
  const ys = [700, 670, 644, 618, 592, 566];
  const grey = (v: number) => ({ space: 'gray' as const, values: [v / 255] });
  const define = {
    ...defineGrid('t-scan', ys, xs),
    vertices: ys.map((y) => xs.map((x) => ({ x, y, snapped: true }))),
    borderWidth: 1.5,
    headerRows: 1,
    origin: 'raster' as const,
    raster: { paper: grey(248), ink: grey(50), fills: ys.slice(0, -1).map((_, r) => xs.slice(0, -1).map(() => (r === 0 ? grey(212) : null))) },
  };

  it('adds rows from border tiles without seams, moves cells and the scan below unscaled, rewrites an edited cell', async () => {
    const original = fixture('scanned-table.pdf');
    const res = await applyEdits(original, [
      define,
      { type: 'tableInsertRow', tableId: 't-scan', index: 1, position: 'above' },
      { type: 'tableInsertRow', tableId: 't-scan', index: 5, position: 'below' },
      { type: 'setCellText', tableId: 't-scan', row: 2, col: 1, text: 'New value' },
    ]);
    const t = res.pages[0]!.tables[0]!;
    const nys = [t.rows[0]!.y1, ...t.rows.map((r) => r.y0)];
    expect(nys).toEqual([700, 670, 644, 618, 592, 566, 540, 514]);
    const S = 2;
    const [a, b] = await Promise.all([renderGray(original, S), renderGray(res.bytes, S)]);
    const step = 1 / S;

    // Every grid line, pixel by pixel along its length: the line is there (no gap) and its profile
    // across the band changes no more than along an original line (no seam at tile or junction joins).
    const profile = (img: typeof a, dir: 'h' | 'v', pos: number, s: number) =>
      [-1.5, -1, -0.5, 0, 0.5, 1].map((o) => (dir === 'h' ? img.at(s, pos + o) : img.at(pos + o, s)));
    const jump = (p: number[], q: number[]) => p.reduce((sum, v, i) => sum + Math.abs(v - q[i]!), 0);
    // Jumps are not measured where a crossing line passes (within 1.25 pt of a grid line).
    const worst = (img: typeof a, dir: 'h' | 'v', pos: number, from: number, to: number, crossing: number[]) => {
      let gap = 0;
      let maxJump = 0;
      const near = (s: number) => crossing.some((c) => Math.abs(s - c) < 1.25);
      for (let s = from; s < to - step; s += step) {
        const p = profile(img, dir, pos, s);
        gap = Math.max(gap, Math.min(...p));
        if (!near(s) && !near(s + step)) maxJump = Math.max(maxJump, jump(p, profile(img, dir, pos, s + step)));
      }
      return { gap, maxJump };
    };
    const base = Math.max(...ys.map((y) => worst(a, 'h', y, xs[0]! + 3, xs[4]! - 3, xs).maxJump), ...xs.map((x) => worst(a, 'v', x, ys[5]! + 3, ys[0]! - 3, ys).maxJump));
    expect(base).toBeLessThan(150);
    for (const y of nys) {
      const w = worst(b, 'h', y, xs[0]! - 0.5, xs[4]! + 0.5, xs);
      expect(w.gap, `line y=${y}`).toBeLessThan(120);
      expect(w.maxJump, `line y=${y}`).toBeLessThanOrEqual(base + 20);
    }
    for (const x of xs) {
      const w = worst(b, 'v', x, nys[7]! - 0.5, nys[0]! + 0.5, nys);
      expect(w.gap, `line x=${x}`).toBeLessThan(120);
      expect(w.maxJump, `line x=${x}`).toBeLessThanOrEqual(base + 20);
    }

    const same = (x0: number, y0: number, x1: number, y1: number, dy: number) => {
      let diff = 0;
      for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) diff = Math.max(diff, Math.abs(a.at(x, y) - b.at(x, y + dy)));
      return diff;
    };
    // Cell interiors (borders are tiles, so their scan noise differs): header cells stay, body cells
    // move down by the inserted rows (26 pt each), at the original size.
    const row = (y0: number, y1: number, dy: number, cols = [0, 1, 2, 3]) => Math.max(...cols.map((c) => same(xs[c]! + 2.5, y0 + 2.5, xs[c + 1]! - 2.5, y1 - 2.5, dy)));
    expect(row(ys[1]!, ys[0]!, 0)).toBeLessThanOrEqual(2);
    expect(row(ys[2]!, ys[1]!, -26, [0, 2, 3])).toBeLessThanOrEqual(2);
    expect(row(ys[4]!, ys[3]!, -26)).toBeLessThanOrEqual(2);
    expect(row(ys[5]!, ys[4]!, -26)).toBeLessThanOrEqual(2);
    // The scan under the table follows its bottom edge.
    expect(same(60, 380, 540, 548, -52)).toBeLessThanOrEqual(2);
    // Above the table nothing changes.
    expect(same(60, 735, 400, 750, 0)).toBeLessThanOrEqual(2);
    // The redraw paints small pieces cut from the scan (a viewer would otherwise paint the whole scan
    // under every clip, seconds per page); only the original draw paints the whole scan, and only the
    // strip below the table is a large piece.
    const { doc } = await loadPdf(res.bytes);
    const xobjects = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const sizeOf = (name: string) => {
      const d = xobjects.lookup(PDFName.of(name), PDFStream).dict;
      return d.lookup(PDFName.of('Width'), PDFNumber).asNumber() * d.lookup(PDFName.of('Height'), PDFNumber).asNumber();
    };
    const painted = [...new TextDecoder().decode(pageContentBytes(doc.getPage(0))).matchAll(/\/(\w+) Do/g)].map((m) => sizeOf(m[1]!));
    const scan = Math.max(...painted);
    expect(painted.length).toBeGreaterThan(30);
    expect(painted.filter((n) => n === scan)).toHaveLength(1);
    expect(painted.filter((n) => n < scan && n >= scan / 10)).toHaveLength(1);
    // Inserted rows are blank paper inside their borders.
    for (const r of [1, 6]) {
      let ink = 255;
      for (let c = 0; c < 4; c++) for (let y = nys[r + 1]! + 3; y < nys[r]! - 3; y += step) for (let x = xs[c]! + 3; x < xs[c + 1]! - 3; x += step) ink = Math.min(ink, b.at(x, y));
      expect(ink, `row ${r}`).toBeGreaterThan(240);
    }
    // The edited cell (original row 1, col 1, now row 2): scan bars gone, new text drawn in the ink colour.
    const report = res.reports.find((r) => r.elementId === 't-scan:2,1')!;
    expect(report.strategy).not.toBe('none');
    const items = await pdfjsItems(res.bytes);
    expect(items.map((i) => i.str).join('')).toContain('New value');
    let dark = 0;
    for (let y = nys[3]! + 3; y < nys[2]! - 3; y += step) for (let x = 300; x < 327; x += step) dark = Math.max(dark, 255 - b.at(x, y));
    expect(dark, 'right part of the edited cell is paper').toBeLessThan(10);
  });

  it('the model\'s scan fills follow their cells into the new grid (inserted rows as drawn, a set background included)', async () => {
    const fills = ys.slice(0, -1).map((_, r) => xs.slice(0, -1).map((_, c) => (r === 0 ? grey(212) : r === 2 && c === 1 ? grey(180) : null)));
    const res = await applyEdits(fixture('scanned-table.pdf'), [
      { ...define, raster: { ...define.raster, fills } },
      { type: 'tableInsertRow', tableId: 't-scan', index: 1, position: 'above' },
      { type: 'setCellText', tableId: 't-scan', row: 4, col: 2, text: 'x', background: grey(100) },
    ]);
    const moved = res.pages[0]!.tables[0]!.setup!.raster!.fills!;
    expect(moved).toHaveLength(6);
    expect(moved[0]).toEqual(fills[0]);
    // The inserted row takes the nearest body cell of each column, the original row 1.
    expect(moved[1]).toEqual(fills[1]);
    expect(moved[2]).toEqual(fills[1]);
    expect(moved[3]).toEqual(fills[2]);
    expect(moved[4]).toEqual([null, null, grey(100), null]);
    expect(moved[5]).toEqual(fills[4]);
  });

  it('text in an empty (inserted) cell is laid out first: it wraps in the cell at the size estimated from the ink, and its row grows', async () => {
    const original = fixture('scanned-table.pdf');
    const inkBoxes = ys.slice(0, -1).map((_, r) => xs.slice(0, -1).map((x) => ({ x0: x + 4, x1: x + 60, y0: ys[r + 1]! + 8, y1: ys[r + 1]! + 16, line: 8, ascent: 6.6 })));
    // Lines without descenders: the ascent gives the larger estimate, 6.6 / 0.75 = 8.8 pt (the full line only 8 / 0.95).
    const size = 6.6 / INK_ASCENT_EM;
    const long = 'A much longer value than the column is wide, so it has to wrap over several lines';
    const res = await applyEdits(original, [
      { ...define, raster: { ...define.raster, inkBoxes } },
      { type: 'tableInsertRow', tableId: 't-scan', index: 1, position: 'above' },
      { type: 'setCellText', tableId: 't-scan', row: 1, col: 1, text: long },
    ]);
    expect(res.reports.find((r) => r.elementId === 't-scan:1,1')!.strategy).not.toBe('none');
    const t = res.pages[0]!.tables[0]!;
    const hs = t.rows.map((r) => r.y1 - r.y0);
    // At least three wrapped lines at 1.2 × the estimated size: more than the original 26 pt.
    expect(hs[1]).toBeGreaterThan(3 * 1.2 * size);
    expect(hs.filter((_, i) => i !== 1)).toEqual([30, 26, 26, 26, 26]);
    // The model's ink boxes follow their cells into the new grid (the editor's size estimate and a reopened file read them by row).
    const moved = t.setup!.raster!.inkBoxes!;
    expect(moved).toHaveLength(6);
    expect(moved[0]).toEqual(inkBoxes[0]);
    expect(moved[1]!.every((b) => b === null)).toBe(true);
    expect(moved[2]![0]!.y1 - t.rows[2]!.y1).toBeCloseTo(inkBoxes[1]![0]!.y1 - ys[1]!, 6);
    expect(moved[5]![3]!.y0 - t.rows[5]!.y0).toBeCloseTo(inkBoxes[4]![3]!.y0 - ys[5]!, 6);
    const row = t.rows[1]!;
    const items = (await pdfjsItems(res.bytes)).filter((i) => long.includes(i.str.trim()) && i.str.trim().length > 1);
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.map((i) => i.str.trim()).join(' ')).toBe(long);
    for (const i of items) {
      expect(i.size).toBeCloseTo(size, 3);
      expect(i.x).toBeGreaterThanOrEqual(xs[1]!);
      expect(i.x + i.w).toBeLessThanOrEqual(xs[2]!);
      expect(i.y).toBeGreaterThan(row.y0);
      expect(i.y + i.size).toBeLessThan(row.y1);
    }
  });

  it('a scanned cell keeps the room for its ink: resizeTable smaller than the ink box is rejected until the cell is rewritten', async () => {
    const original = fixture('scanned-table.pdf');
    const inkBoxes = ys.slice(0, -1).map((_, r) => xs.slice(0, -1).map((_, c) => (r === 1 && c === 1 ? { x0: 205, x1: 300, y0: 650, y1: 664, line: 10, ascent: 8 } : null)));
    const def = { ...define, raster: { ...define.raster, inkBoxes } };
    const res = await applyEdits(original, [def]);
    expect(res.pages[0]!.tables[0]!.cells.find((c) => c.row === 1 && c.col === 1)!.minSize).toEqual({ width: 102, height: 22 });
    const widths = (w1: number) => [140, w1, 120, 90];
    await expect(applyEdits(original, [def, { type: 'resizeTable', tableId: 't-scan', colWidths: widths(100) }])).rejects.toThrow(/scanned content and can't be smaller than 102\.0 × 22\.0 pt/);
    await expect(applyEdits(original, [def, { type: 'resizeTable', tableId: 't-scan', rowHeights: [30, 20, 26, 26, 26] }])).rejects.toThrow(/can't be smaller/);
    await expect(applyEdits(original, [def, { type: 'resizeTable', tableId: 't-scan', colWidths: widths(102) }])).resolves.toBeDefined();
    await expect(applyEdits(original, [def, { type: 'setCellText', tableId: 't-scan', row: 1, col: 1, text: 'x' }, { type: 'resizeTable', tableId: 't-scan', colWidths: widths(60) }])).resolves.toBeDefined();
  });

  it("inserting a column with fit 'shrink' keeps scanned columns at least as wide as their ink and narrows the others more", async () => {
    const original = fixture('scanned-table.pdf');
    const ink = (x1s: number[]) => ys.slice(0, -1).map((_, r) => xs.slice(0, -1).map((x, c) => (r === 2 ? { x0: x + 4, x1: x1s[c]!, y0: 624, y1: 631, line: 7, ascent: 7 } : null)));
    const insert = { type: 'tableInsertCol' as const, tableId: 't-scan', index: 0, position: 'right' as const, fit: 'shrink' as const };
    // Last column: ink to 535, so at least 535 − 450 + 2 = 87 pt; a plain proportional shrink would give it 63.75.
    const def = { ...define, raster: { ...define.raster, inkBoxes: ink([100, 230, 360, 535]) } };
    const t = (await applyEdits(original, [def, insert])).pages[0]!.tables[0]!;
    const k = (480 - 140 - 87) / (480 - 90);
    expect(t.cols.map((c) => c.x1 - c.x0).map((w) => Math.round(w * 100) / 100)).toEqual([140 * k, 140, 130 * k, 120 * k, 87].map((w) => Math.round(w * 100) / 100));
    expect(t.bbox.x1).toBeCloseTo(540, 6);
    const full = { ...define, raster: { ...define.raster, inkBoxes: ink([195, 325, 445, 535]) } };
    await expect(applyEdits(original, [full, insert])).rejects.toThrow(/other columns can't shrink enough/);
  });
});

/** Text items of every page (pdf.js), as `str@baseline` per page. */
async function pageTexts(bytes: Uint8Array) {
  const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, standardFontDataUrl: fontsDir, verbosity: 0 }).promise;
  const pages: { str: string; y: number }[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.flatMap((x) => ('str' in x && x.str.trim() ? [{ str: x.str, y: Math.round((x.transform[5] as number) * 100) / 100 }] : [])));
  }
  await doc.destroy();
  return pages;
}

describe('table paging (paged-table.pdf)', () => {
  const body = (n: number) => `Body paragraph line ${n} of the page.`;
  const under = 'Line under the table.';
  const setup = async () => {
    const original = fixture('paged-table.pdf');
    const t = analyzeDocument((await loadPdf(original)).doc)[0]!.model.tables[0]!;
    return { original, t };
  };

  it('pushed content continues at the top of the next page, whose body moves down; header and footer stay; no text is duplicated', async () => {
    const { original, t } = await setup();
    const long = Array.from({ length: 9 }, (_, i) => `Long cell line ${i + 1}`).join(' ');
    const res = await applyEdits(original, [{ type: 'setCellText', tableId: t.id, row: 2, col: 0, text: long }]);
    expect(res.overflows).toEqual([]);
    const [before, after] = await Promise.all([pageTexts(original), pageTexts(res.bytes)]);
    const at = (p: { str: string; y: number }[], s: string) => p.filter((x) => x.str === s).map((x) => x.y);
    // Each string once per page: clipped-away copies are removed from the text layer.
    for (const p of after) expect(new Set(p.map((x) => `${x.str}@${x.y}`)).size).toBe(p.length);
    expect(at(after[0]!, under)).toEqual([]);
    expect(at(after[1]!, under)).toEqual([at(before[1]!, body(1))[0]]);
    for (const page of [0, 1]) {
      expect(at(after[page]!, 'Quarterly report')).toEqual(at(before[page]!, 'Quarterly report'));
      expect(at(after[page]!, `Page ${page + 1}`)).toEqual(at(before[page]!, `Page ${page + 1}`));
    }
    const shift = at(before[1]!, body(1))[0]! - at(after[1]!, body(1))[0]!;
    expect(shift).toBeGreaterThan(12);
    for (let n = 1; n <= 8; n++) expect(at(after[1]!, body(n))[0]).toBeCloseTo(at(before[1]!, body(n))[0]! - shift, 2);
    // The model keeps the moved box's id, on the page that shows it.
    const box = res.pages[1]!.textBoxes.find((b) => b.text === under)!;
    expect(box.id).toBe(analyzeDocument((await loadPdf(original)).doc)[0]!.model.textBoxes.find((b) => b.text === under)!.id);
    expect(res.pages[1]!.flowIn).toHaveLength(1);
  });

  it('past the last page: needsPage until the user picks; copy repeats the header/footer bands, empty does not; the table is split under one id; save → reopen', async () => {
    const { original, t } = await setup();
    const rows = Array.from({ length: 30 }, () => ({ type: 'tableInsertRow' as const, tableId: t.id, index: 3, position: 'below' as const }));
    const ask = await applyEdits(original, rows);
    expect(ask.pages).toHaveLength(2);
    expect(ask.overflows).toMatchObject([{ pageIndex: 1, needsPage: true }]);

    const copy = await applyEdits(original, [...rows, { type: 'setPageFlow', newPages: 'copy' }]);
    expect(copy.overflows).toEqual([]);
    expect(copy.pages).toHaveLength(3);
    const parts = copy.pages.map((p) => p.tables.filter((x) => x.id === t.id));
    expect(parts[0]).toHaveLength(1);
    expect(parts[1]).toHaveLength(1);
    expect(parts[0]![0]!.rows.length + parts[1]![0]!.rows.length).toBe(t.rows.length + 30);
    expect(copy.pages[2]!.added).toBe(true);
    const [before, after] = await Promise.all([pageTexts(original), pageTexts(copy.bytes)]);
    const page3 = after[2]!;
    for (const s of ['Quarterly report', 'Page 2']) expect(page3.filter((x) => x.str === s).map((x) => x.y)).toEqual(before[1]!.filter((x) => x.str === s).map((x) => x.y));
    // The new page's body starts where the last page's did.
    expect(page3.find((x) => x.str === body(1))!.y).toBeCloseTo(before[1]!.find((x) => x.str === body(1))!.y, 2);

    const empty = await applyEdits(original, [...rows, { type: 'setPageFlow', newPages: 'empty' }]);
    const e3 = (await pageTexts(empty.bytes))[2]!;
    expect(e3.some((x) => x.str === 'Quarterly report' || x.str === 'Page 2')).toBe(false);
    expect(e3.filter((x) => x.str.startsWith('Body paragraph'))).toHaveLength(8);

    // Incremental: the original is a prefix, the new page is in the page tree, and the result reopens.
    expect(Buffer.from(copy.bytes.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true);
    const reopened = analyzeDocument((await loadPdf(copy.bytes)).doc);
    expect(reopened).toHaveLength(3);
    expect(reopened[2]!.model.textBoxes.map((b) => b.text).join('\n')).toContain(body(8));
  });

  it('a cut table asks about its header rows; repeated, they top every continued part and push its rows down by their height', async () => {
    const { original, t } = await setup();
    const rows = Array.from({ length: 60 }, () => ({ type: 'tableInsertRow' as const, tableId: t.id, index: 3, position: 'below' as const }));
    const ask = await applyEdits(original, rows);
    // Cut onto page 2 and again onto the new pages: the table is asked about once, at its first cut.
    expect(ask.continuations).toEqual([{ tableId: t.id, pageIndex: 1 }]);
    const flow = { type: 'setPageFlow' as const, newPages: 'copy' as const };
    const run = (repeatHeader: boolean) => applyEdits(original, [...rows, flow, { type: 'tableContinuation', tableId: t.id, repeatHeader }]);
    const [yes, no] = await Promise.all([run(true), run(false)]);
    expect(yes.continuations).toEqual([]);
    expect(no.continuations).toEqual([]);
    const headerH = t.rows[0]!.y1 - t.rows[0]!.y0;
    const item = (texts: { str: string; y: number }[][]) => texts.map((p) => p.filter((x) => x.str === 'Item').length);
    const [yesTexts, noTexts] = await Promise.all([pageTexts(yes.bytes), pageTexts(no.bytes)]);
    expect(item(noTexts)).toEqual([1, 0, 0, 0]);
    expect(item(yesTexts)).toEqual([1, 1, 1, 1]);
    for (const k of [1, 2, 3]) {
      const piece = yes.pages[k]!.tables.find((x) => x.id === t.id)!;
      expect(piece.rows[0]!.index).toBe(0);
      expect(piece.cells.find((c) => c.row === 0 && c.col === 0)!.text).toBe('Item');
      expect(piece.rows[1]!.y1).toBeCloseTo(piece.rows[0]!.y0, 1);
      if (k === 1) {
        // Where the part without a header starts, the header now sits; the rows move down by its height.
        const plain = no.pages[1]!.tables.find((x) => x.id === t.id)!;
        expect(piece.rows[0]!.y1).toBeCloseTo(plain.rows[0]!.y1, 1);
        expect(piece.rows[1]!.y1).toBeCloseTo(plain.rows[0]!.y1 - headerH, 1);
      }
      // The header's text sits at the top of the continued part, above its rows.
      const yItem = yesTexts[k]!.find((x) => x.str === 'Item')!.y;
      expect(yItem).toBeGreaterThan(piece.rows[1]!.y1);
      expect(yItem).toBeLessThan(piece.rows[0]!.y1);
    }
    expect(yes.pages.reduce((n, p) => n + p.tables[0]!.rows.length, 0)).toBe(t.rows.length + 60 + 3);

    // Without the header, a continued part starts with the table's top edge (2 pt black), not the row line it had (0.8 pt grey);
    // a part followed by a cut ends with the table's bottom edge.
    const S = 4;
    const dark = (img: Awaited<ReturnType<typeof renderGray>>, y: number) => {
      let n = 0;
      for (let v = y - 3; v < y + 3; v += 1 / S) if (img.at(140, v) < 40) n++;
      return n;
    };
    const [orig0, no0, no1, no2] = await Promise.all([renderGray(original, S, 0), renderGray(no.bytes, S, 0), renderGray(no.bytes, S, 1), renderGray(no.bytes, S, 2)]);
    const edge = dark(orig0, t.rows[0]!.y1);
    expect(edge).toBeGreaterThanOrEqual(7);
    expect(dark(orig0, t.rows[1]!.y1)).toBe(0);
    for (const [k, img] of [[1, no1], [2, no2]] as const) {
      const top = no.pages[k]!.tables.find((x) => x.id === t.id)!.rows[0]!.y1;
      expect(Math.abs(dark(img, top) - edge), `page ${k + 1}`).toBeLessThanOrEqual(1);
    }
    expect(dark(orig0, t.rows.at(-1)!.y0), 'original bottom edge').toBe(edge);
    for (const [k, img] of [[0, no0], [1, no1], [2, no2]] as const) {
      const bottom = no.pages[k]!.tables.find((x) => x.id === t.id)!.rows.at(-1)!.y0;
      expect(Math.abs(dark(img, bottom) - edge), `bottom of page ${k + 1}`).toBeLessThanOrEqual(1);
    }
  });

  it('a header row that would end a page goes to the next page with the rows under it', () => {
    const view = { x0: 0, y0: 0, x1: 595, y1: 842 };
    const row = (n: number, y0: number, oy0: number) => ({ y0, y1: y0 + 20, orig: { y0: oy0, y1: oy0 + 20 }, table: true, pushed: true, tableId: 't', row: n });
    const text = (y0: number) => ({ y0, y1: y0 + 20, orig: { y0, y1: y0 + 20 } });
    // The table grew above, so its header row (72..92) still fits over the body bottom (70) but its first row doesn't.
    const pages: FlowPage[] = [
      { view, units: [text(740), row(0, 72, 110), row(1, 52, 90), row(2, 32, 70)], headers: { t: { y0: 72, y1: 92 } } },
      { view, units: [text(740), text(400)] },
    ];
    const plan = planFlow(pages, undefined);
    expect(plan.splits).toEqual([]);
    const p0 = plan.pages[0]!.draws.filter((d) => d.src === 0 && d.dy === 0);
    expect(Math.min(...p0.map((d) => d.y0))).toBeGreaterThan(92);
    const header = plan.pages[1]!.draws.find((d) => d.src === 0 && d.y0 <= 72 && d.y1 >= 92)!;
    expect(header.dy).toBeCloseTo(760 - 92, 6);
    // Unchanged when the first row fits under the header too: the table is cut below it.
    const fits = planFlow([{ ...pages[0]!, units: [text(740), row(0, 92, 130), row(1, 72, 110), row(2, 52, 90)], headers: { t: { y0: 92, y1: 112 } } }, pages[1]!], undefined);
    expect(fits.splits).toEqual([{ tableId: 't', pageIndex: 1 }]);
  });

  it('a copied page-number footer is reported with the overflow and is left out on copy pages when asked', async () => {
    const { original, t } = await setup();
    const rows = Array.from({ length: 30 }, () => ({ type: 'tableInsertRow' as const, tableId: t.id, index: 3, position: 'below' as const }));
    const ask = await applyEdits(original, rows);
    expect(ask.overflows).toMatchObject([{ pageIndex: 1, needsPage: true, pageNumber: 'Page 2' }]);
    const omit = await applyEdits(original, [...rows, { type: 'setPageFlow', newPages: 'copy', pageNumbers: 'omit' }]);
    const texts = await pageTexts(omit.bytes);
    expect(texts[2]!.some((x) => x.str === 'Page 2')).toBe(false);
    expect(texts[2]!.filter((x) => x.str === 'Quarterly report')).toHaveLength(1);
    expect(texts[1]!.filter((x) => x.str === 'Page 2')).toHaveLength(1);
  });

  it('a JPEG scan is cut into pieces decoded by pdf.js, which render exactly like the scan', async () => {
    const original = fixture('paged-scan-jpeg.pdf');
    const xs = [60, 220, 340, 460, 535];
    const ys = [230, 206, 182, 158, 134];
    const grey = (v: number) => ({ space: 'gray' as const, values: [v / 255] });
    const define = { type: 'defineTable' as const, tableId: 't-scan', pageIndex: 0, spans: [], vertices: ys.map((y) => xs.map((x) => ({ x, y, snapped: true }))), borderWidth: 1.5, headerRows: 1, origin: 'raster' as const, raster: { paper: grey(246), ink: grey(50) } };
    const res = await applyEdits(original, [define, { type: 'tableInsertRow', tableId: 't-scan', index: 1, position: 'above' }]);
    const { doc } = await loadPdf(res.bytes);
    const xobjects = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const dicts = [...new TextDecoder().decode(pageContentBytes(doc.getPage(0))).matchAll(/\/(\w+) Do/g)].map((m) => xobjects.lookup(PDFName.of(m[1]!), PDFStream).dict);
    const pieces = dicts.filter((d) => d.lookup(PDFName.of('Filter'))?.toString() === '/FlateDecode');
    expect(dicts.filter((d) => d.lookup(PDFName.of('Filter'))?.toString() === '/DCTDecode')).toHaveLength(1);
    expect(pieces.length).toBeGreaterThan(20);
    for (const d of pieces) expect(d.lookup(PDFName.of('ColorSpace'))?.toString()).toBe('/DeviceRGB');
    // Native resolution (2 px/pt): the header row stays and the body cells move down by one row (24 pt), pixel
    // for pixel (borders are tiles cut from one piece of an edge, so their JPEG noise and ringing, up to
    // 4 pt off the line, differ).
    const S = 2;
    const [a, b] = await Promise.all([renderGray(original, S), renderGray(res.bytes, S)]);
    let diff = 0;
    const clear = (x: number, y: number) => !xs.some((v) => Math.abs(x - v) < 4) && !ys.some((v) => Math.abs(y - v) < 4);
    for (let y = ys[4]!; y < ys[0]!; y += 1 / S) for (let x = xs[0]!; x < xs[4]!; x += 1 / S) if (clear(x, y)) diff = Math.max(diff, Math.abs(a.at(x, y) - b.at(x, y > ys[1]! ? y : y - 24)));
    expect(diff).toBeLessThanOrEqual(2);
  });

  it('scanned page: asks for a measured layout, then copies the scan bands as crops onto paper', async () => {
    const original = fixture('paged-scan.pdf');
    const xs = [60, 220, 340, 460, 535];
    const ys = [230, 206, 182, 158, 134];
    const grey = (v: number) => ({ space: 'gray' as const, values: [v / 255] });
    const define = { type: 'defineTable' as const, tableId: 't-scan', pageIndex: 0, spans: [], vertices: ys.map((y) => xs.map((x) => ({ x, y, snapped: true }))), borderWidth: 1.5, headerRows: 1, origin: 'raster' as const, raster: { paper: grey(246), ink: grey(50) } };
    const rows = Array.from({ length: 6 }, () => ({ type: 'tableInsertRow' as const, tableId: 't-scan', index: 3, position: 'below' as const }));
    expect((await applyEdits(original, [define, ...rows])).overflows).toEqual([{ pageIndex: 0, by: 0, needsLayout: [0] }]);
    const lines = [{ y0: 798, y1: 808 }, ...Array.from({ length: 16 }, (_, i) => ({ y0: 740 - i * 16, y1: 748 - i * 16 })), { y0: 100, y1: 108 }, { y0: 28, y1: 38 }];
    const layout = { type: 'scanLayout' as const, pageIndex: 0, lines, paper: grey(246) };
    const ask = await applyEdits(original, [define, ...rows, layout]);
    expect(ask.overflows).toMatchObject([{ pageIndex: 0, needsPage: true }]);
    // No page-number question on a scan (no text), but the table the new page would cut is asked about.
    expect(ask.overflows[0]!.pageNumber).toBeUndefined();
    expect(ask.continuations).toEqual([{ tableId: 't-scan', pageIndex: 1 }]);
    const res = await applyEdits(original, [define, ...rows, layout, { type: 'setPageFlow', newPages: 'copy' }]);
    expect(res.pages).toHaveLength(2);
    const [p0, p1] = res.pages.map((p) => p.tables.find((x) => x.id === 't-scan')!);
    expect(p0!.rows.length + p1!.rows.length).toBe(4 + 6);
    // Continued rows start at the top of the body (the first ink line of the scan's body).
    expect(p1!.bbox.y1).toBeCloseTo(748, 0);
    const { doc } = await loadPdf(res.bytes);
    const content = new TextDecoder().decode(pageContentBytes(doc.getPage(1)));
    const clips = [...content.matchAll(/q ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re W n 1 0 0 1 0 ([-\d.]+) cm \/\w+ Do Q/g)].map((m) => ({ y0: Number(m[2]), y1: Number(m[2]) + Number(m[4]) }));
    // Paper first, then the continued body under the header, and the header and footer bands at their original places.
    expect(content.startsWith(`q ${(246 / 255).toPrecision(12)} g 0 0 595 842 re f Q`)).toBe(true);
    expect(clips).toContainEqual({ y0: 797, y1: 809 });
    expect(clips).toContainEqual({ y0: 27, y1: 39 });
    expect(clips.some((c) => c.y1 > 740 && c.y1 < 790)).toBe(true);
  });
});
