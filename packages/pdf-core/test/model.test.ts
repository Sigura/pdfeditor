import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeDocument } from '../src/model/extract.ts';
import { loadPdf } from '../src/load.ts';
import { applyEdits } from '../src/edit/apply.ts';
import { bandCheck, meshFromGrid, mergeCells, unsnappedVertices } from '@pdf-toolkit/shared';

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'fixtures', name));
const boxesOf = async (name: string, page = 0) => analyzeDocument((await loadPdf(fixture(name))).doc)[page]!;

describe('page model', () => {
  it('groups standard-14 text into paragraphs with op mapping', async () => {
    const p = await boxesOf('latin-standard14.pdf');
    expect(p.model.textBoxes.map((b) => b.text)).toEqual([
      'Quarterly Report',
      'The quick brown fox jumps over the lazy dog.\nSales grew by 12% compared to last year.\nAll figures are in thousands of euros.',
      'Times Roman paragraph: café, naïve, résumé.\nSecond line of the serif paragraph.',
    ]);
    const run = p.model.textBoxes[0]!.runs[0]!;
    expect(run.fontName).toBe('Helvetica-Bold');
    expect(run.contentStreamRef.streamId).toBe('page:0');
    expect(p.interp.streams.get('page:0')!.content.ops[run.contentStreamRef.opStart]!.op).toMatch(/^(Tj|TJ)$/);
  });

  it('decodes subset Type0 fonts (Cyrillic, Turkish) through ToUnicode', async () => {
    expect((await boxesOf('cyrillic-subset.pdf')).model.textBoxes[1]!.text).toBe('Привет, мир! Это проверка редактора.\nСъешь же ещё этих мягких французских булок.');
    expect((await boxesOf('turkish-subset.pdf')).model.textBoxes[1]!.text).toBe("Şişli'de ılık bir gün geçirdik.\nİğdır, Çanakkale ve Muğla şehirleri.");
  });

  it("handles simple TrueType with WinAnsi, ', TJ and Tc", async () => {
    const p = await boxesOf('simple-truetype.pdf');
    expect(p.model.textBoxes[1]!.text).toBe('First line of a paragraph with two show operators.\nSecond line via the quote operator.Kerned TJ array');
    const blue = p.model.textBoxes[2]!.runs[0]!;
    expect(blue.color).toEqual({ space: 'rgb', values: [0, 0, 1] });
    expect(blue.charSpacing).toBe(1);
  });

  it('marks scanned pages as not editable', async () => {
    const p = await boxesOf('scanned.pdf');
    expect(p.model.editable).toBe(false);
    expect(p.model.warnings.join()).toMatch(/Scanned page/);
  });
});

describe('table setup', () => {
  it('extracts junctions and checks border bands on table.pdf', async () => {
    const { model } = await boxesOf('table.pdf');
    const t = model.tables[0]!;
    const ys = [t.rows[0]!.y1, ...t.rows.map((r) => r.y0)];
    const xs = [t.cols[0]!.x0, ...t.cols.map((c) => c.x1)];
    // 5 row lines × 5 column lines, every crossing and corner.
    expect(model.junctions).toHaveLength(25);
    for (const y of ys) for (const x of xs) expect(model.junctions.some((j) => Math.abs(j.x - x) < 0.01 && Math.abs(j.y - y) < 0.01)).toBe(true);

    const mesh = meshFromGrid(ys, xs, model.junctions, 4);
    expect(unsnappedVertices(mesh)).toEqual([]);
    const width = t.borderStyle!.width;
    expect(width).toBeCloseTo(0.8, 3);
    expect(bandCheck(mesh, model.rulings, width).every((e) => e.status === 'ok')).toBe(true);
    // A band thinner than the drawn border doesn't cover it.
    expect(bandCheck(mesh, model.rulings, 0.4).every((e) => e.status === 'off')).toBe(true);
    // A vertex dragged 2 pt off its junction: only the four edges meeting there fail.
    const v = mesh.vertices.map((row) => row.map((p) => ({ ...p })));
    v[2]![2] = { x: v[2]![2]!.x + 2, y: v[2]![2]!.y - 2, snapped: false };
    const bad = bandCheck({ vertices: v, spans: [] }, model.rulings, width).filter((e) => e.status !== 'ok');
    expect(bad.map((e) => `${e.dir}${e.row},${e.col}`).sort()).toEqual(['h2,1', 'h2,2', 'v1,2', 'v2,2']);
    expect(bad.every((e) => e.status === 'off')).toBe(true);
    // Merging two cells drops the edge between them and hides no corner vertex.
    const merged = mergeCells(mesh, 3, 0, 3, 1);
    expect(bandCheck(merged, model.rulings, width).some((e) => e.dir === 'v' && e.row === 3 && e.col === 1)).toBe(false);
    expect(unsnappedVertices(merged)).toEqual([]);
  });

  it('defineTable redefines the detected table with merged cells', async () => {
    const original = fixture('table.pdf');
    const { model } = await boxesOf('table.pdf');
    const t = model.tables[0]!;
    const ys = [t.rows[0]!.y1, ...t.rows.map((r) => r.y0)];
    const xs = [t.cols[0]!.x0, ...t.cols.map((c) => c.x1)];
    const mesh = mergeCells(meshFromGrid(ys, xs, model.junctions, 4), 3, 0, 3, 1);
    const op = { type: 'defineTable' as const, tableId: t.id, pageIndex: 0, ...mesh, borderWidth: 0.8, headerRows: 1, origin: 'vector' as const };
    const res = await applyEdits(new Uint8Array(original), [op]);
    const nt = res.pages[0]!.tables[0]!;
    expect(nt.setup).toEqual({ vertices: mesh.vertices, spans: mesh.spans, borderWidth: 0.8, headerRows: 1, origin: 'vector' });
    const anchor = nt.cells.find((c) => c.row === 3 && c.col === 0)!;
    expect(anchor).toMatchObject({ rowSpan: 1, colSpan: 2 });
    expect(anchor.text.split(/\s+/)).toEqual(['Cherries', '200']);
    expect(nt.cells.find((c) => c.row === 3 && c.col === 1)).toMatchObject({ covered: true, text: '' });
    await expect(applyEdits(new Uint8Array(original), [{ ...op, spans: [...op.spans, { row: 3, col: 1, rowSpan: 1, colSpan: 1 }] }])).rejects.toThrow(/spans overlap/);
  });
});
