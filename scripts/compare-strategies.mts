// Visual check of the font strategies: the same word 5× in a cross, the center one re-rendered
// through a forced strategy, rendered with pdf.js in headless Chromium. Writes <case>.pdf/.png to
// the output dir and fails when a strategy that should look like the original drifts.
// Run: pnpm compare-strategies <out dir>
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFName, StandardFonts, type PDFRef } from 'pdf-lib';
import { chromium } from '@playwright/test';
import { applyEdits, type ForceStrategy } from '../packages/pdf-core/src/edit/apply.ts';
import { configureFonts } from '../packages/pdf-core/src/fonts/lookup.ts';
import { loadPdf } from '../packages/pdf-core/src/load.ts';
import { analyzeDocument } from '../packages/pdf-core/src/model/extract.ts';

const out = process.argv[2];
if (!out || !existsSync(out)) {
  console.error('usage: pnpm compare-strategies <existing output dir>');
  process.exit(2);
}
const req = createRequire(path.resolve('packages/pdf-core/package.json'));
const pdfjs = path.dirname(req.resolve('pdfjs-dist/package.json'));
configureFonts({ dirs: [path.join(pdfjs, 'standard_fonts')], system: false });

const base = await PDFDocument.load(readFileSync('fixtures/type1-cff.pdf'));
base.registerFontkit(fontkit);
const cffRef = base.getPage(0).node.Resources()!.lookup(PDFName.of('Font'))!.get(PDFName.of('C1')) as PDFRef;
const helv = await base.embedFont(StandardFonts.HelveticaBold);
const lib = await base.embedFont(readFileSync(path.join(pdfjs, 'standard_fonts', 'LiberationSans-Regular.ttf')));
await base.flush();
/** maxDiff: pixel difference (normalized by ink) above which the case fails. */
type Case = { name: string; label: string; font: PDFRef; word: string; width: number; force: ForceStrategy; maxDiff: number };
const cases: Case[] = [
  { name: 's2', label: 'S2 substitute: Helvetica-Bold → Liberation Sans Bold', font: helv.ref, word: 'Quarterly', width: helv.widthOfTextAtSize('Quarterly', 28), force: 'substitute', maxDiff: 0.02 },
  { name: 's3-outline', label: 'S3a outline from the embedded TrueType program', font: lib.ref, word: 'Kerned', width: lib.widthOfTextAtSize('Kerned', 28), force: 'outline', maxDiff: 0.15 },
  { name: 's3-compose', label: 'S3b composition (é = e + ´) in a bare CFF font', font: cffRef, word: 'Café', width: 50, force: 'compose', maxDiff: 0.15 },
  { name: 's3-fallback', label: 'S3c fallback: Foxit Serif word drawn with scaled Liberation Sans', font: cffRef, word: 'Serif', width: 56, force: 'fallback', maxDiff: 0.6 },
];
const W = 595, H = 340, cx = W / 2, cy = 170, gap = 95;
for (const c of cases) {
  const page = base.addPage([W, H]);
  page.node.setFontDictionary(PDFName.of('F'), c.font);
  const hex = c.font === lib.ref ? lib.encodeText(c.word).toString() : `(${c.word})`;
  const at = (x: number, y: number) => `BT /F 28 Tf ${x.toFixed(2)} ${y} Td ${hex} Tj ET`;
  const x0 = cx - c.width / 2;
  const content = [at(x0, cy + gap), at(x0 - c.width - 90, cy), at(x0, cy), at(x0 + c.width + 90, cy), at(x0, cy - gap)].join('\n');
  page.node.set(PDFName.of('Contents'), base.context.register(base.context.flateStream(content)));
}
base.removePage(0);
await base.flush();
const src = await base.save({ useObjectStreams: false });

console.log('applying forced strategies');
const pdfs: { file: string; c: Case }[] = [];
for (const [i, c] of cases.entries()) {
  const model = analyzeDocument((await loadPdf(src)).doc)[i]!.model;
  if (model.textBoxes.length !== 5) throw new Error(`${c.name}: expected 5 boxes, got ${JSON.stringify(model.textBoxes.map((b) => b.text))}`);
  const center = model.textBoxes.find((b) => Math.abs((b.bbox.x0 + b.bbox.x1) / 2 - cx) < 5 && b.bbox.y0 < cy + 5 && b.bbox.y1 > cy)!;
  const res = await applyEdits(src, [{ type: 'replaceText', elementId: center.id, text: c.word, overflow: 'overflow' }], { force: c.force });
  console.log(c.name, JSON.stringify(res.reports[0]!.glyphs), res.reports[0]!.strategy, res.reports[0]!.substituteFont ?? '');
  const file = path.resolve(out, `${c.name}.pdf`);
  writeFileSync(file, res.bytes);
  pdfs.push({ file, c });
}

const server = createServer((rq, rs) => {
  const u = decodeURIComponent(rq.url!.split('?')[0]!);
  const p = u.startsWith('/pdfjs/') ? path.join(pdfjs, u.slice(7)) : u.startsWith('/file/') ? u.slice(5) : null;
  if (!p) return void rs.writeHead(200, { 'content-type': 'text/html' }).end('<body style="margin:0;font:14px sans-serif"><div id=l style="padding:6px 10px"></div><canvas id=c></canvas></body>');
  rs.writeHead(200, { 'content-type': p.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream' }).end(readFileSync(p));
}).listen(0);
const port = (server.address() as { port: number }).port;
let failed = 0;
console.log('rendering with pdf.js in headless Chromium');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://localhost:${port}/`);
for (const [i, { file, c }] of pdfs.entries()) {
  await page.evaluate(async ({ file, port, i, label, width }) => {
    const lib = await import(`http://localhost:${port}/pdfjs/build/pdf.mjs`);
    lib.GlobalWorkerOptions.workerSrc = `http://localhost:${port}/pdfjs/build/pdf.worker.mjs`;
    const doc = await lib.getDocument({ url: `/file${file}`, standardFontDataUrl: `/pdfjs/standard_fonts/`, useSystemFonts: false, isEvalSupported: false }).promise;
    const pg = await doc.getPage(i + 1);
    const vp = pg.getViewport({ scale: 3 });
    const c = document.getElementById('c') as HTMLCanvasElement;
    c.width = vp.width; c.height = vp.height;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    // Pixel difference between the center word and the top word (same x, 95 pt higher).
    const wpx = Math.round(3 * (width + 20)), x = Math.round((vp.width - wpx) / 2), hpx = 3 * 40;
    const yc = Math.round(vp.height / 2 - 3 * 30), yt = yc - 3 * 95;
    const a = ctx.getImageData(x, yc, wpx, hpx).data, b = ctx.getImageData(x, yt, wpx, hpx).data;
    let diff = 0, ink = 0;
    for (let k = 0; k < a.length; k += 4) { const da = 255 - a[k]!, db = 255 - b[k]!; diff += Math.abs(da - db); ink += db; }
    (window as unknown as { diff: number }).diff = diff / Math.max(1, ink);
    // Mark the re-rendered center word.
    ctx.strokeStyle = 'rgba(220,0,0,0.6)'; ctx.lineWidth = 2;
    ctx.strokeRect(vp.width / 2 - 140, vp.height / 2 - 75 * 1.2, 280 * 1.4, 130);
    document.getElementById('l')!.textContent = `${label}  (center = re-rendered, others = original)`;
  }, { file, port, i, label: c.label, width: c.width });
  const diff = await page.evaluate(() => (window as unknown as { diff: number }).diff);
  const ok = diff <= c.maxDiff;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: pixel diff vs original ${diff.toFixed(3)} (max ${c.maxDiff})`);
  await page.locator('body').screenshot({ path: file.replace(/\.pdf$/, '.png') });
}
await browser.close();
server.close();
console.log(`images in ${path.resolve(out)}`);
if (failed) process.exit(1);
