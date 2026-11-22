import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { inkFontSize } from '../packages/shared/src/tableMesh.ts';

const fixture = (name: string) => path.join(import.meta.dirname, '..', 'fixtures', name);
const fontsDir = path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/';

async function textItems(bytes: Uint8Array) {
  const doc = await getDocument({ data: bytes, isEvalSupported: false, standardFontDataUrl: fontsDir, verbosity: 0 }).promise;
  const content = await (await doc.getPage(1)).getTextContent();
  await doc.destroy();
  return content.items.flatMap((i) => ('str' in i && i.str ? [{ str: i.str, x: i.transform[4] as number, y: i.transform[5] as number }] : []));
}

async function open(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'edit', exact: true }).click();
  await page.getByTestId('editor-input').setInputFiles(fixture(name));
  await expect(page.getByTestId('overlay')).toBeVisible();
}

const changes = (page: Page) => page.getByTestId('change-item');

test('edit text, nudge, restyle, undo one change and download', async ({ page }) => {
  await open(page, 'latin-standard14.pdf');
  const box = page.getByTestId('text-box').first();
  const id = (await box.getAttribute('data-box-id'))!;
  const target = page.locator(`[data-box-id="${id}"]`);

  await target.click();
  await target.click();
  await expect(page.getByTestId('box-editor')).toBeFocused();
  await page.keyboard.type('Edited title');
  await page.keyboard.press('Control+Enter');
  await expect(target.getByTestId('strategy-badge')).toHaveText('S1 original');
  await expect(changes(page)).toHaveCount(1);

  // The box stays selected: arrow keys nudge it, and the presses are sent as one move.
  const x0 = Number(await page.getByTestId('insp-x').inputValue());
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(changes(page)).toHaveCount(2);
  await expect(changes(page).nth(1)).toContainText('Move');
  await expect(changes(page).nth(1)).toContainText('(3.0, -10.0 pt)');
  await expect(page.getByTestId('insp-x')).toHaveValue(String(Number((x0 + 3).toFixed(2))));

  await page.getByTestId('insp-align').getByTitle('Align right').click();
  await expect(changes(page)).toHaveCount(3);
  await expect(changes(page).nth(2)).toContainText('Style');
  await page.keyboard.press('Control+z');
  await expect(changes(page)).toHaveCount(2);

  // Per-change undo: drop the text edit, keep the move.
  await changes(page).nth(0).hover();
  await changes(page).nth(0).getByTestId('change-undo').click();
  await expect(changes(page)).toHaveCount(1);
  await expect(changes(page).first()).toContainText('Move');
  await expect(page.getByTestId('thumb-changes').first()).toHaveText('1');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
  const edited = await textItems(new Uint8Array(readFileSync((await download.path())!)));
  const original = await textItems(new Uint8Array(readFileSync(fixture('latin-standard14.pdf'))));
  const before = original.find((i) => i.str === 'Quarterly Report')!;
  const after = edited.find((i) => i.str === 'Quarterly Report')!;
  expect(after.x).toBeCloseTo(before.x + 3, 3);
  expect(after.y).toBeCloseTo(before.y - 10, 3);
  expect(edited.map((i) => i.str)).not.toContain('Edited title');
});

test('table: Tab moves between cell editors, dragging a border resizes the column', async ({ page }) => {
  await open(page, 'table.pdf');
  const cells = page.getByTestId('table-cell');
  await cells.nth(4).dblclick();
  await page.keyboard.type('Plums');
  await page.keyboard.press('Tab');
  await expect(changes(page)).toHaveCount(1);
  await expect(page.getByTestId('box-editor')).toHaveText('10');
  await page.keyboard.press('Escape');
  await expect(changes(page).first()).toContainText('R2C1');

  const before = (await cells.nth(0).boundingBox())!;
  const border = (await page.getByTestId('col-border').first().boundingBox())!;
  await page.mouse.move(border.x + border.width / 2, border.y + border.height / 2);
  await page.mouse.down();
  await page.mouse.move(border.x + border.width / 2 + 40, border.y + border.height / 2, { steps: 5 });
  await expect(page.getByTestId('readout')).toContainText('col 1');
  await page.mouse.up();
  await expect(changes(page)).toHaveCount(2);
  await expect(changes(page).nth(1)).toContainText('Resize table columns');
  await expect.poll(async () => (await cells.nth(0).boundingBox())!.width).toBeGreaterThan(before.width + 30);
});

test('inspector: cell width/height fields resize the table, colour picker restyles text', async ({ page }) => {
  await open(page, 'table.pdf');
  const cells = page.getByTestId('table-cell');
  const before = (await cells.nth(1).boundingBox())!;
  await cells.nth(1).click();
  const width = page.getByTestId('insp-col-width');
  const height = page.getByTestId('insp-row-height');
  await expect(width).toHaveValue('120');
  await expect(height).toHaveValue('24');

  await width.fill('150');
  await width.press('Enter');
  await expect(changes(page)).toHaveCount(1);
  await expect(changes(page).first()).toContainText('Resize table columns');
  await expect.poll(async () => (await cells.nth(1).boundingBox())!.width).toBeGreaterThan(before.width * 1.2);

  await cells.nth(1).click();
  await height.fill('36');
  await height.press('Enter');
  await expect(changes(page)).toHaveCount(2);
  await expect(changes(page).nth(1)).toContainText('Resize table rows');
  await cells.nth(1).click();
  await expect(width).toHaveValue('150');
  await expect(height).toHaveValue('36');
  // Values below the minimum cell size are rejected without a request.
  await height.fill('1');
  await height.press('Enter');
  await expect(height).toHaveValue('36');
  await expect(changes(page)).toHaveCount(2);

  await page.getByTestId('text-box').first().click();
  await expect(page.getByTestId('insp-text-color')).toContainText('#000000');
  await page.getByTestId('insp-color').fill('#cc0000');
  await expect(changes(page)).toHaveCount(3);
  await expect(changes(page).nth(2)).toContainText('Style');
  await expect(changes(page).nth(2)).toContainText('colour');
  await expect(page.getByTestId('insp-text-color')).toContainText('#cc0000');
});

test('text moved onto a filled area gets a fill in the detected colour, which can be turned off', async ({ page }) => {
  await open(page, 'table.pdf');
  const title = page.getByTestId('text-box').first();
  await title.click();
  await expect(page.getByTestId('insp-fill')).not.toBeChecked();
  await expect(page.getByTestId('insp-bg-detected')).toHaveAttribute('data-source', 'pixels');

  const from = (await title.boundingBox())!;
  const to = (await page.getByTestId('table-cell').nth(1).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(changes(page)).toHaveCount(1);
  await expect(changes(page).first()).toContainText('Move');
  await expect(changes(page).first()).toContainText('fill');

  const detected = page.getByTestId('insp-bg-detected');
  await expect(detected).toHaveAttribute('data-source', 'shape');
  await expect(detected).toContainText('#d9e6f7');
  await expect(page.getByTestId('insp-fill')).toBeChecked();
  await expect(page.getByTestId('insp-fill-color')).toHaveValue('#d9e6f7');

  await page.getByTestId('insp-fill-color').fill('#ffee00');
  await expect(changes(page)).toHaveCount(2);
  await expect(page.getByTestId('insp-fill-color')).toHaveValue('#ffee00');
  // The checkbox reflects the saved state, so it flips once the server answers.
  await page.getByTestId('insp-fill').click();
  await expect(changes(page)).toHaveCount(3);
  await expect(changes(page).nth(2)).toContainText('no fill');
  await expect(page.getByTestId('insp-fill')).not.toBeChecked();
  await expect(page.getByTestId('insp-fill-color')).toBeDisabled();
});

test('arrow keys nudge a selected table; nudges of two boxes never overlap requests', async ({ page }) => {
  let inFlight = 0;
  let maxInFlight = 0;
  await page.route('**/edits', async (route) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 700));
    const response = await route.fetch();
    inFlight--;
    await route.fulfill({ response });
  });
  await open(page, 'table.pdf');

  const table = page.getByTestId('table').first();
  const t0 = (await table.boundingBox())!;
  await page.getByTestId('table-handle').click();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(changes(page)).toHaveCount(1);
  await expect(changes(page).first()).toContainText('(1.0, -10.0 pt)');
  await expect.poll(async () => (await table.boundingBox())!.y - t0.y).toBeCloseTo(10 * 1.25, 0);

  // Nudge box A, and while its request is in flight select box B and nudge it.
  const boxes = page.getByTestId('text-box');
  await boxes.nth(0).click();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => inFlight).toBe(1);
  await boxes.nth(1).click();
  await page.keyboard.press('ArrowLeft');
  await expect(changes(page)).toHaveCount(3);
  await expect(changes(page).nth(1)).toContainText('(-1.0, 0.0 pt)');
  await expect(changes(page).nth(2)).toContainText('(-1.0, 0.0 pt)');
  expect(maxInFlight).toBe(1);
  await expect(page.getByTestId('editor-error')).toHaveCount(0);
});

test('table setup: detected defaults snap every vertex, nudge and merge, Confirm adds one change', async ({ page }) => {
  await open(page, 'table.pdf');
  await page.getByTestId('tools').getByRole('button', { name: 'Table', exact: true }).click();
  await page.getByTestId('table-setup-start').click();
  await expect(page.getByTestId('setup-cols')).toHaveValue('4');
  await expect(page.getByTestId('setup-rows')).toHaveValue('4');
  await expect(page.getByTestId('setup-borderWidth')).toHaveValue('0.8');
  await expect(page.getByTestId('setup-headerRows')).toHaveValue('1');
  await page.getByTestId('setup-ok').click();

  const vertices = page.getByTestId('setup-vertex');
  await expect(vertices).toHaveCount(25);
  await expect(page.locator('[data-testid=setup-vertex][data-snapped=true]')).toHaveCount(25);
  await expect(page.locator('[data-testid=setup-edge]:not([data-status=ok])')).toHaveCount(0);

  // Arrow keys move a vertex 0.25 pt together with its column line (cells stay rectangles): the column's
  // vertices turn yellow and its vertical edges red, back on the junctions green again.
  const v = vertices.nth(6);
  const box = (await v.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await expect(v).toHaveAttribute('data-snapped', 'false');
  await expect(page.getByTestId('setup-warnings')).toContainText('R2C2');
  await expect(vertices.nth(1)).toHaveAttribute('data-snapped', 'false');
  await expect(vertices.nth(5)).toHaveAttribute('data-snapped', 'true');
  await expect(page.locator('[data-testid=setup-edge][data-status=off]')).toHaveCount(4);
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  await expect(v).toHaveAttribute('data-snapped', 'true');
  await expect(page.getByTestId('setup-warnings')).toHaveCount(0);

  // Merge the last row's first two cells: one inner edge less.
  const cells = page.getByTestId('setup-cell');
  await cells.nth(12).click();
  await cells.nth(13).click({ modifiers: ['Shift'] });
  await page.getByTestId('setup-merge').click();
  await expect(page.getByTestId('setup-edge')).toHaveCount(39);

  await page.getByTestId('setup-confirm').click();
  await expect(changes(page)).toHaveCount(1);
  await expect(changes(page).first()).toContainText('Table setup 4×4, 1 merged');
  await expect(page.getByTestId('setup-mesh')).toHaveCount(0);
  await expect(page.getByTestId('table-cell')).toHaveCount(15);
});

test('image table: a column past the page edge asks to shrink the others; a row with an image stops at its minimum height', async ({ page }) => {
  await open(page, 'image-table.pdf');
  const cells = page.getByTestId('table-cell');
  await expect(cells).toHaveCount(12);
  await cells.nth(2).click();
  await page.getByTitle('Insert column right').click();
  await expect(page.getByTestId('prompt')).toContainText('exceed the page width by 105.0 pt');
  await page.getByRole('button', { name: 'Shrink other columns' }).click();
  await expect(changes(page)).toHaveCount(1);
  await expect(cells).toHaveCount(16);
  await expect(page.getByTestId('prompt')).toHaveCount(0);

  // Border under the picture row, dragged far up: the height stops at the image's 34 pt.
  const border = (await page.getByTestId('row-border').nth(2).boundingBox())!;
  await page.mouse.move(border.x + 20, border.y + border.height / 2);
  await page.mouse.down();
  await page.mouse.move(border.x + 20, border.y - 60, { steps: 5 });
  await expect(page.getByTestId('readout')).toContainText('row 3: 34.0 pt (min 34.0 pt: image)');
  await page.mouse.up();
  await expect(changes(page)).toHaveCount(2);
  await expect(page.getByTestId('editor-error')).toHaveCount(0);
});

test('scanned table: Confirm sends the ink box of every cell, a row border stops at the ink', async ({ page }) => {
  await open(page, 'scanned-table.pdf');
  const ov = (await page.getByTestId('overlay').boundingBox())!;
  const at = (x: number, y: number) => [ov.x + (x / 595) * ov.width, ov.y + ((842 - y) / 842) * ov.height] as const;
  await page.getByTestId('tools').getByRole('button', { name: 'Table', exact: true }).click();
  await page.mouse.move(...at(50, 710));
  await page.mouse.down();
  await page.mouse.move(...at(550, 556), { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('setup-cols')).toHaveValue('4');
  await expect(page.getByTestId('setup-rows')).toHaveValue('5');
  await page.getByTestId('setup-ok').click();

  const defined = page.waitForRequest((r) => r.url().endsWith('/edits') && r.method() === 'POST');
  await page.getByTestId('setup-confirm').click();
  const op = (await defined).postDataJSON().ops[0];
  expect(op.origin).toBe('raster');
  // Fixture: 7 pt "text" bars centred in every cell, rows 30 / 26 pt high (generate.ts scannedTable). Ink is
  // measured on a 4 px/pt render, so to 0.25 pt.
  const boxes = op.raster.inkBoxes as ({ y0: number; y1: number; line: number; ascent: number } | null)[][];
  expect(boxes.map((r) => r.length)).toEqual([4, 4, 4, 4, 4]);
  const mids = [685, 657, 631, 605, 579];
  boxes.forEach((row, r) =>
    row.forEach((b) => {
      expect(Math.abs(b!.line - 7)).toBeLessThanOrEqual(0.25);
      expect(b!.ascent).toBeCloseTo(b!.line, 6);
      expect(Math.abs(b!.y0 - (mids[r]! - 3.5))).toBeLessThanOrEqual(0.25);
    }),
  );
  await expect(changes(page)).toHaveCount(1);
  const cells = page.getByTestId('table-cell');
  await expect(cells).toHaveCount(20);

  // Row 2's top border is centred at 669.75 in the fixture's 2 px/pt pixels and its ink starts at 653.5: min
  // height = 669.75 − 653.5 + 2 pt clearance. Lines and ink are both found on a 4 px/pt render.
  const border = (await page.getByTestId('row-border').nth(1).boundingBox())!;
  await page.mouse.move(border.x + 20, border.y + border.height / 2);
  await page.mouse.down();
  await page.mouse.move(border.x + 20, border.y - 60, { steps: 5 });
  const readout = page.getByTestId('readout');
  await expect(readout).toContainText('pt: ink)');
  const [, size, min] = (await readout.textContent())!.match(/^row 2: ([\d.]+) pt \(min ([\d.]+) pt: ink\)$/)!;
  expect(size).toBe(min);
  expect(Math.abs(Number(min) - 18.25)).toBeLessThanOrEqual(0.3); // one 4× pixel + the readout's rounding
  const resized = page.waitForRequest((r) => r.url().endsWith('/edits') && r.method() === 'POST');
  await page.mouse.up();
  const heights = (await resized).postDataJSON().ops[0].rowHeights as number[];
  expect(heights[1]!.toFixed(1)).toBe(min);
  await expect(changes(page)).toHaveCount(2);
  await expect(page.getByTestId('editor-error')).toHaveCount(0);

  // The Inspector's height field has the same minimum: smaller values are reverted without a request.
  await cells.nth(4).click();
  const height = page.getByTestId('insp-row-height');
  await expect(height).toHaveAttribute('title', `min ${min} pt`);
  await height.fill('10');
  await height.press('Enter');
  await expect(height).toHaveValue(String(Number(heights[1]!.toFixed(2))));
  await expect(changes(page)).toHaveCount(2);
});

test('cell editor style bar: Esc cancels from the bar, a picked font keeps the editor focused, Tab walks back into the text', async ({ page }) => {
  await open(page, 'table.pdf');
  const cells = page.getByTestId('table-cell');
  const editor = page.getByTestId('box-editor');
  await cells.nth(4).dblclick();
  await page.keyboard.type('Plums');
  await page.getByTitle('Font size (pt)').click();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(changes(page)).toHaveCount(0);

  // The picked font's button unmounts: focus must not end up on the body, or blur would never commit.
  await cells.nth(4).dblclick();
  await page.keyboard.type('Plums');
  await page.getByTitle('Font for new text').click();
  await page.getByRole('button', { name: /Courier/ }).first().click();
  await expect(editor).toBeFocused();
  const sent = page.waitForRequest((r) => r.url().endsWith('/edits') && r.method() === 'POST');
  await page.mouse.click(5, 500);
  expect((await sent).postDataJSON().ops[0]).toMatchObject({ type: 'setCellText', text: 'Plums', fontFamily: expect.stringMatching(/Courier/) });
  await expect(editor).toHaveCount(0);
  await expect(changes(page)).toHaveCount(1);

  await cells.nth(8).dblclick();
  await page.getByTitle('Font size (pt)').fill('14');
  // Size → text colour → Fill checkbox (the fill colour is disabled) → the text.
  for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
  await expect(editor).toBeFocused();
  await expect(changes(page)).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(changes(page)).toHaveCount(2);
  await expect(editor).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
});

test('ink measurement on real glyphs: the font size estimate is right with and without descenders', async ({ page }) => {
  await open(page, 'table.pdf');
  // 11 pt Helvetica cells: "Item" and "Total" have no descenders, "Qty" and "Apples" do.
  const boxes = await page.evaluate(async (bytes) => {
    const { renderRegion } = await import('/src/editor/background.ts');
    const { measureLook } = await import('/src/editor/rasterGrid.ts');
    const { useEditor } = await import('/src/editor/store.ts');
    const { openPdf } = await import('/src/lib/pdfjs.ts');
    const st = useEditor.getState();
    const pdf = await openPdf(new Uint8Array(bytes));
    const out: Record<string, { line: number; ascent: number }> = {};
    for (const c of st.pages[0]!.tables[0]!.cells.filter((x) => ['Item', 'Total', 'Qty', 'Apples'].includes(x.text))) {
      const inner = { x0: c.bbox.x0 + 2, y0: c.bbox.y0 + 2, x1: c.bbox.x1 - 2, y1: c.bbox.y1 - 2 };
      const region = await renderRegion(pdf, 0, c.bbox, 4);
      out[c.text] = measureLook(region, region.toPx, [[inner]])!.inkBoxes[0]![0]!;
    }
    return out;
  }, [...readFileSync(fixture('table.pdf'))]);
  expect(Object.keys(boxes).sort()).toEqual(['Apples', 'Item', 'Qty', 'Total']);
  for (const b of Object.values(boxes)) expect(Math.abs(inkFontSize(b) - 11)).toBeLessThanOrEqual(0.55);
});

test('paging: a cut table asks about its header rows; rows pushed past the last page ask how to continue and about the page number; Copy header/footer adds a page; slow requests show progress', async ({ page }) => {
  await open(page, 'paged-table.pdf');
  const thumbs = page.locator('img[alt^="Page "]');
  await expect(thumbs).toHaveCount(2);
  const cells = page.getByTestId('table-cell');
  await cells.nth(12).click();
  // Rows first flow onto page 2, which asks once whether the header rows repeat there.
  for (let i = 0; i < 40 && !(await page.getByTestId('prompt').count()); i++) {
    const n = await changes(page).count();
    await page.getByTitle('Insert row below').click();
    await expect(changes(page)).toHaveCount(n + 1);
  }
  await expect(page.getByTestId('prompt')).toContainText('A table continues on page 2. Repeat header rows');
  const yes = page.waitForResponse((r) => r.url().endsWith('/edits') && r.request().postDataJSON().ops[0]?.type === 'tableContinuation');
  await page.getByTestId('prompt-yes').click();
  const answered = await yes;
  expect(answered.request().postDataJSON().ops).toEqual([expect.objectContaining({ type: 'tableContinuation', repeatHeader: true })]);
  await expect(page.getByTestId('prompt')).toHaveCount(0);
  // The continued part on page 2 starts with the header row.
  const part = (await answered.json()).pages[1].tables[0];
  expect(part.cells.find((c: { row: number; col: number }) => c.row === 0 && c.col === 0).text).toBe('Item');
  await cells.nth(12).click();
  // The new-page prompt comes once page 2 runs out too; the table was answered for, the copied footer's page number is asked about.
  for (let i = 0; i < 40 && !(await page.getByTestId('prompt').count()); i++) {
    const n = await changes(page).count();
    await page.getByTitle('Insert row below').click();
    await expect(changes(page)).toHaveCount(n + 1);
  }
  await expect(page.getByTestId('prompt')).toContainText('past the bottom of the last page (2)');
  await expect(page.getByTestId('prompt-repeat-yes')).toHaveCount(0);
  await expect(page.getByTestId('prompt')).toContainText('“Page 2”');
  await expect(page.getByTestId('prompt-number-omit')).toBeChecked();
  const before = await changes(page).count();
  await page.route('**/api/documents/*/edits', async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });
  const flowReq = page.waitForRequest((r) => r.url().endsWith('/edits') && r.postDataJSON().ops[0]?.type === 'setPageFlow');
  await page.getByTestId('prompt-copy').click();
  expect((await flowReq).postDataJSON().ops).toEqual([{ type: 'setPageFlow', newPages: 'copy', pageNumbers: 'omit' }]);
  await expect(page.getByTestId('progress')).toContainText('Applying changes…');
  await expect(thumbs).toHaveCount(3);
  await expect(page.getByTestId('progress')).toHaveCount(0);
  await expect(changes(page)).toHaveCount(before + 1);
  await page.unroute('**/api/documents/*/edits');

  // The added page: content continued from page 2, marked, and no new text can be placed there.
  await thumbs.nth(2).click();
  await expect(page.getByTestId('flow-in')).toHaveCount(1);
  await page.getByRole('button', { name: 'Add text' }).click();
  await page.getByTestId('overlay').click({ position: { x: 300, y: 300 } });
  await expect(page.getByTestId('editor-error')).toContainText('continued from an earlier page');
  await expect(changes(page)).toHaveCount(before + 1);
});

test('paging on a scan: the layout is measured in the browser, sent with the change, and the copy page gets the scan bands', async ({ page }) => {
  await open(page, 'paged-scan.pdf');
  const ov = (await page.getByTestId('overlay').boundingBox())!;
  const at = (x: number, y: number) => [ov.x + (x / 595) * ov.width, ov.y + ((842 - y) / 842) * ov.height] as const;
  await page.getByTestId('tools').getByRole('button', { name: 'Table', exact: true }).click();
  await page.mouse.move(...at(50, 240));
  await page.mouse.down();
  await page.mouse.move(...at(545, 124), { steps: 5 });
  await page.mouse.up();
  await page.getByTestId('setup-ok').click();
  await page.getByTestId('setup-confirm').click();
  await expect(changes(page)).toHaveCount(1);
  await page.getByTestId('tools').getByRole('button', { name: 'Select', exact: true }).click();
  const layout = page.waitForRequest((r) => r.url().endsWith('/edits') && r.postDataJSON().ops[0]?.type === 'scanLayout');
  await page.getByTestId('table-cell').nth(12).click();
  await page.getByTitle('Insert row below').click();
  const op = (await layout).postDataJSON().ops[0];
  // Fixture (generate.ts pagedScan): header bar 798–808, footer bar 28–38, 16 text bars from 740 down, the line under the table at 100–108.
  const near = (y0: number, y1: number) => op.lines.some((l: { y0: number; y1: number }) => Math.abs(l.y0 - y0) < 1 && Math.abs(l.y1 - y1) < 1);
  expect(near(798, 808) && near(28, 38) && near(740, 748) && near(100, 108)).toBe(true);
  await expect(changes(page)).toHaveCount(3);
  // A taller row 2 pushes the rows under it past the page: the table is cut, onto a new page.
  await page.getByTestId('table-cell').nth(4).click();
  await page.getByTestId('insp-row-height').fill('150');
  await page.getByTestId('insp-row-height').press('Enter');
  await expect(page.getByTestId('prompt')).toContainText('past the bottom of the last page (1)');
  // The first cut of the table is onto the new page: the new-page prompt asks about its header rows too; a scan has no page-number text to ask about.
  await expect(page.getByTestId('prompt-repeat-yes')).toBeChecked();
  await expect(page.getByTestId('prompt-number-keep')).toHaveCount(0);
  await page.getByTestId('prompt-repeat-no').click();
  const flowReq = page.waitForRequest((r) => r.url().endsWith('/edits') && r.postDataJSON().ops[0]?.type === 'setPageFlow');
  await page.getByTestId('prompt-copy').click();
  expect((await flowReq).postDataJSON().ops).toEqual([{ type: 'setPageFlow', newPages: 'copy' }, expect.objectContaining({ type: 'tableContinuation', repeatHeader: false })]);
  await expect(page.locator('img[alt^="Page "]')).toHaveCount(2);
  await expect(page.getByTestId('prompt')).toHaveCount(0);
});
