// Regenerates the sample PDFs in fixtures/. Run: pnpm fixtures
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

const require = createRequire(import.meta.url);
const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
const outDir = import.meta.dirname;

const liberation = (style: 'Regular' | 'Bold' | 'Italic') => readFile(path.join(pdfjsDir, 'standard_fonts', `LiberationSans-${style}.ttf`));

function paragraph(page: PDFPage, lines: string[], x: number, y: number, font: PDFFont, size: number, lineGap = 1.25) {
  lines.forEach((line, i) => page.drawText(line, { x, y: y - i * size * lineGap, size, font, color: rgb(0.1, 0.1, 0.1) }));
}

async function save(name: string, doc: PDFDocument) {
  doc.setTitle(name.replace(/\.pdf$/, ''));
  doc.setProducer('pdf-toolkit fixtures');
  doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  await writeFile(path.join(outDir, name), await doc.save({ useObjectStreams: false }));
  console.log(`wrote ${name}`);
}

async function latinStandard14() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const page = doc.addPage([595, 842]);
  page.drawText('Quarterly Report', { x: 60, y: 770, size: 24, font: helvBold });
  paragraph(page, ['The quick brown fox jumps over the lazy dog.', 'Sales grew by 12% compared to last year.', 'All figures are in thousands of euros.'], 60, 720, helv, 12);
  paragraph(page, ['Times Roman paragraph: café, naïve, résumé.', 'Second line of the serif paragraph.'], 60, 640, times, 12);
  const p2 = doc.addPage([595, 842]);
  p2.drawText('Page two heading', { x: 60, y: 770, size: 18, font: helvBold });
  paragraph(p2, ['Text on the second page.'], 60, 730, helv, 12);
  await save('latin-standard14.pdf', doc);
}

async function embeddedSubset(name: string, lines: string[], heading: string) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(await liberation('Regular'), { subset: true });
  const bold = await doc.embedFont(await liberation('Bold'), { subset: true });
  const page = doc.addPage([595, 842]);
  page.drawText(heading, { x: 60, y: 770, size: 22, font: bold });
  paragraph(page, lines, 60, 720, regular, 13);
  await save(name, doc);
}

/** Simple (non-CID) TrueType font with WinAnsiEncoding and /Widths, the way office suites write it. */
async function simpleTrueType() {
  const doc = await PDFDocument.create();
  const ttf = await liberation('Regular');
  const fk = fontkit.create(new Uint8Array(ttf));
  const widths: number[] = [];
  for (let code = 32; code <= 255; code++) {
    const ch = code < 128 ? String.fromCharCode(code) : new TextDecoder('windows-1252').decode(Uint8Array.of(code));
    widths.push(Math.round((fk.layout(ch).advanceWidth * 1000) / fk.unitsPerEm));
  }
  const ctx = doc.context;
  const fontFile = ctx.flateStream(new Uint8Array(ttf), { Length1: ttf.length });
  const descriptor = ctx.obj({
    Type: 'FontDescriptor',
    FontName: 'ABCDEF+LiberationSans',
    Flags: 32,
    FontBBox: [-203, -303, 1050, 910],
    ItalicAngle: 0,
    Ascent: 905,
    Descent: -212,
    CapHeight: 729,
    XHeight: 519,
    StemV: 80,
    FontFile2: ctx.register(fontFile),
  });
  const font = ctx.obj({
    Type: 'Font',
    Subtype: 'TrueType',
    BaseFont: 'ABCDEF+LiberationSans',
    FirstChar: 32,
    LastChar: 255,
    Widths: widths,
    Encoding: 'WinAnsiEncoding',
    FontDescriptor: ctx.register(descriptor),
  });
  const fontRef = ctx.register(font);
  const page = doc.addPage([595, 842]);
  page.node.setFontDictionary(PDFName.of('TT1'), fontRef);
  const content = [
    'BT /TT1 14 Tf 60 770 Td (Simple TrueType font, WinAnsi) Tj ET',
    'BT /TT1 12 Tf 14.4 TL 60 730 Td (First line of a paragraph with ) Tj (two show operators.) Tj',
    "(Second line via the quote operator.) ' [(Kerned ) -250 (TJ array)] TJ ET",
    '0 0 1 rg BT /TT1 12 Tf 60 680 Td 1 Tc (Spaced blue) Tj ET',
  ].join('\n');
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(content)));
  await save('simple-truetype.pdf', doc);
}

async function scanned() {
  const doc = await PDFDocument.create();
  const w = 400;
  const h = 560;
  const px = new Uint8Array(w * h).fill(250);
  // Dark bars that look like lines of text, plus noise.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let line = 0; line < 30; line++) {
    const y0 = 40 + line * 16;
    let x = 40;
    while (x < w - 60) {
      const word = 10 + Math.floor(rnd() * 40);
      for (let y = y0; y < y0 + 8; y++) for (let xx = x; xx < Math.min(x + word, w - 40); xx++) px[y * w + xx] = 40 + Math.floor(rnd() * 40);
      x += word + 6;
    }
  }
  const ctx = doc.context;
  const img = ctx.register(ctx.flateStream(px, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
  const page = doc.addPage([595, 842]);
  page.node.setXObject(PDFName.of('Im1'), img);
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('q 595 0 0 842 0 0 cm /Im1 Do Q')));
  await save('scanned.pdf', doc);
}

/** Scan of a bordered 4 × 6 table (grey header row) at 2 px/pt, with "text" bars in the cells, above and below it. No text layer. */
async function scannedTable() {
  const doc = await PDFDocument.create();
  const s = 2;
  const [pw, ph] = [595, 842];
  const w = pw * s;
  const h = ph * s;
  const px = new Uint8Array(w * h).fill(248);
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rect = (x0: number, y0: number, x1: number, y1: number, v: () => number) => {
    for (let y = Math.round((ph - y1) * s); y < Math.round((ph - y0) * s); y++) for (let x = Math.round(x0 * s); x < Math.round(x1 * s); x++) px[y * w + x] = v();
  };
  const words = (x0: number, x1: number, y: number) => {
    let x = x0;
    while (x < x1 - 8) {
      const word = Math.min(8 + Math.floor(rnd() * 30), x1 - x);
      rect(x, y, x + word, y + 7, () => 40 + Math.floor(rnd() * 30));
      x += word + 4;
    }
  };
  const xs = [60, 200, 330, 450, 540];
  const ys = [700, 670, 644, 618, 592, 566];
  const half = 0.75;
  rect(xs[0]!, ys[1]!, xs[4]!, ys[0]!, () => 212);
  for (let r = 0; r < ys.length - 1; r++) {
    for (let c = 0; c < xs.length - 1; c++) words(xs[c]! + 6, xs[c]! + 6 + (xs[c + 1]! - xs[c]! - 12) * (0.4 + 0.5 * rnd()), (ys[r]! + ys[r + 1]!) / 2 - 3.5);
  }
  for (const y of ys) rect(xs[0]! - half, y - half, xs[4]! + half, y + half, () => 45 + Math.floor(rnd() * 12));
  for (const x of xs) rect(x - half, ys[5]! - half, x + half, ys[0]! + half, () => 45 + Math.floor(rnd() * 12));
  words(60, 400, 740);
  for (let y = 540; y > 380; y -= 16) words(60, 540, y);
  const ctx = doc.context;
  const img = ctx.register(ctx.flateStream(px, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
  const page = doc.addPage([pw, ph]);
  page.node.setXObject(PDFName.of('Im1'), img);
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(`q ${pw} 0 0 ${ph} 0 0 cm /Im1 Do Q`)));
  await save('scanned-table.pdf', doc);

  // The same page with the scan stored a quarter turn round and placed rotated back (as some scanners do).
  const rot = await PDFDocument.create();
  const turned = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) turned[(w - 1 - x) * h + y] = px[y * w + x]!;
  const rimg = rot.context.register(rot.context.flateStream(turned, { Type: 'XObject', Subtype: 'Image', Width: h, Height: w, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
  const rpage = rot.addPage([pw, ph]);
  rpage.node.setXObject(PDFName.of('Im1'), rimg);
  rpage.node.set(PDFName.of('Contents'), rot.context.register(rot.context.flateStream(`q 0 -${ph} ${pw} 0 0 ${ph} cm /Im1 Do Q`)));
  await save('scanned-table-rotated.pdf', rot);
}

async function table() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595, 842]);
  page.drawText('Inventory', { x: 60, y: 780, size: 20, font: bold });
  const cols = [60, 220, 340, 460];
  const rowH = 24;
  const top = 750;
  const data = [
    ['Item', 'Qty', 'Price', 'Total'],
    ['Apples', '10', '1.20', '12.00'],
    ['Pears', '4', '2.50', '10.00'],
    ['Cherries', '200', '0.10', '20.00'],
  ];
  const right = 540;
  page.drawRectangle({ x: cols[0]!, y: top - rowH, width: right - cols[0]!, height: rowH, color: rgb(0.85, 0.9, 0.97) });
  data.forEach((row, r) => {
    row.forEach((cell, c) => {
      page.drawText(cell, { x: cols[c]! + 6, y: top - (r + 1) * rowH + 8, size: 11, font: r === 0 ? bold : helv });
    });
  });
  const border = { thickness: 0.8, color: rgb(0.3, 0.3, 0.3) };
  for (let r = 0; r <= data.length; r++) page.drawLine({ start: { x: cols[0]!, y: top - r * rowH }, end: { x: right, y: top - r * rowH }, ...border });
  for (const x of [...cols, right]) page.drawLine({ start: { x, y: top }, end: { x, y: top - data.length * rowH }, ...border });
  paragraph(page, ['Text below the table moves when rows are added or removed.', 'A second line under the table.'], 60, 600, helv, 12);
  await save('table.pdf', doc);
}

/** 4 columns × 5 rows: header band with a thicker separator, zebra body rows, a "Total" row merged over three columns. */
async function zebraTable() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595, 842]);
  page.drawText('Orders', { x: 60, y: 780, size: 20, font: bold });
  const xs = [60, 220, 340, 440, 540];
  const rowH = 24;
  const ys = Array.from({ length: 6 }, (_, i) => 750 - i * rowH);
  const fills = [rgb(0.85, 0.9, 0.97), null, rgb(0.93, 0.93, 0.93), null, rgb(1, 0.96, 0.85)];
  fills.forEach((color, r) => color && page.drawRectangle({ x: xs[0]!, y: ys[r + 1]!, width: xs[4]! - xs[0]!, height: rowH, color }));
  const data = [
    ['Item', 'Qty', 'Price', 'Total'],
    ['Apples', '10', '1.20', '12.00'],
    ['Pears', '4', '2.50', '10.00'],
    ['Cherries', '200', '0.10', '20.00'],
  ];
  data.forEach((row, r) => row.forEach((cell, c) => page.drawText(cell, { x: xs[c]! + 6, y: ys[r + 1]! + 8, size: 11, font: r === 0 ? bold : helv })));
  page.drawText('Total', { x: xs[0]! + 6, y: ys[5]! + 8, size: 11, font: bold });
  page.drawText('42.00', { x: xs[3]! + 6, y: ys[5]! + 8, size: 11, font: bold });
  const inner = { thickness: 0.6, color: rgb(0.45, 0.45, 0.45) };
  for (const r of [2, 3, 4]) page.drawLine({ start: { x: xs[0]!, y: ys[r]! }, end: { x: xs[4]!, y: ys[r]! }, ...inner });
  for (const c of [1, 2]) page.drawLine({ start: { x: xs[c]!, y: ys[0]! }, end: { x: xs[c]!, y: ys[4]! }, ...inner });
  page.drawLine({ start: { x: xs[3]!, y: ys[0]! }, end: { x: xs[3]!, y: ys[5]! }, ...inner });
  page.drawLine({ start: { x: xs[0]!, y: ys[1]! }, end: { x: xs[4]!, y: ys[1]! }, thickness: 1.6, color: rgb(0.2, 0.2, 0.2) });
  page.drawRectangle({ x: xs[0]!, y: ys[5]!, width: xs[4]! - xs[0]!, height: ys[0]! - ys[5]!, borderWidth: 1.2, borderColor: rgb(0.2, 0.2, 0.2) });
  paragraph(page, ['Text below the table moves when rows are added or removed.'], 60, 590, helv, 12);
  await save('zebra-table.pdf', doc);
}

/** RGB image XObject (flate, no codec) drawn at (x, y) with size w × h pt. */
function drawRgbImage(doc: PDFDocument, page: PDFPage, name: string, px: number, py: number, x: number, y: number, w: number, h: number, colour: (i: number, j: number) => [number, number, number]) {
  const data = new Uint8Array(px * py * 3);
  for (let j = 0; j < py; j++) for (let i = 0; i < px; i++) data.set(colour(i, j), (j * px + i) * 3);
  const ref = doc.context.register(doc.context.flateStream(data, { Type: 'XObject', Subtype: 'Image', Width: px, Height: py, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
  page.node.setXObject(PDFName.of(name), ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, x, y), drawObject(name), popGraphicsState());
}

/** 3 × 4 table with centred header text and a picture centred in a body cell; text, a rule and a logo image under it. */
async function imageTable() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595, 842]);
  page.drawText('Products', { x: 60, y: 780, size: 20, font: bold });
  const xs = [60, 200, 380, 540];
  const ys = [750, 726, 676, 626, 576];
  ['Item', 'Picture', 'Notes'].forEach((t, c) => page.drawText(t, { x: (xs[c]! + xs[c + 1]! - bold.widthOfTextAtSize(t, 11)) / 2, y: ys[1]! + 8, size: 11, font: bold }));
  const body = [
    ['Apples', '', 'Fresh'],
    ['Pears', '', 'Ripe'],
    ['Cherries', '', 'Sweet'],
  ];
  body.forEach((row, r) => row.forEach((t, c) => t && page.drawText(t, { x: xs[c]! + 6, y: ys[r + 2]! + 21, size: 11, font: helv })));
  drawRgbImage(doc, page, 'Pic', 8, 6, 270, 636, 40, 30, (i, j) => [i * 32, j * 40, 128]);
  const border = { thickness: 0.8, color: rgb(0.3, 0.3, 0.3) };
  for (const y of ys) page.drawLine({ start: { x: xs[0]!, y }, end: { x: xs[3]!, y }, ...border });
  for (const x of xs) page.drawLine({ start: { x, y: ys[0]! }, end: { x, y: ys[4]! }, ...border });
  paragraph(page, ['Text below the table moves with it.'], 60, 545, helv, 12);
  page.drawLine({ start: { x: 60, y: 530 }, end: { x: 540, y: 530 }, thickness: 1, color: rgb(0.5, 0.1, 0.1) });
  drawRgbImage(doc, page, 'Logo', 4, 4, 60, 480, 40, 40, (i, j) => [200, i * 60, j * 60]);
  await save('image-table.pdf', doc);
}

function t1Number(n: number): number[] {
  if (n >= -107 && n <= 107) return [n + 139];
  if (n >= 108 && n <= 1131) return [247 + ((n - 108) >> 8), (n - 108) & 255];
  if (n >= -1131 && n <= -108) return [251 + ((-n - 108) >> 8), (-n - 108) & 255];
  return [255, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function t1Encrypt(data: number[] | Uint8Array, key: number, lead: number): Uint8Array {
  let r = key;
  const plain = [...new Array(lead).fill(0), ...data];
  return Uint8Array.from(plain, (p) => {
    const c = p ^ (r >> 8);
    r = ((c + r) * 52845 + 22719) & 0xffff;
    return c;
  });
}

/** Builds a charstring from numbers and operator names. */
function t1CharString(prog: (number | string)[]): Uint8Array {
  const ops: Record<string, number[]> = { hsbw: [13], rmoveto: [21], rlineto: [5], closepath: [9], endchar: [14], callsubr: [10], return: [11], seac: [12, 6], vstem: [3] };
  return t1Encrypt(prog.flatMap((t) => (typeof t === 'number' ? t1Number(t) : ops[t]!)), 4330, 4);
}

const box = (x: number, y: number, w: number, h: number) => [x, y, 'rmoveto', w, 0, 'rlineto', 0, h, 'rlineto', -w, 0, 'rlineto', 'closepath'];

/** Synthetic Type1 program (box-shaped glyphs) with subrs and a seac composite. */
function syntheticType1(): { bytes: Uint8Array; length1: number; length2: number } {
  const glyphs: Record<string, (number | string)[]> = {
    '.notdef': [0, 500, 'hsbw', 'endchar'],
    space: [0, 250, 'hsbw', 'endchar'],
    A: [20, 700, 'hsbw', ...box(0, 0, 660, 680), 'endchar'],
    B: [40, 640, 'hsbw', 0, 0, 'rmoveto', 4, 'callsubr', 0, 680, 'rlineto', -560, 0, 'rlineto', 'closepath', 'endchar'],
    a: [30, 500, 'hsbw', ...box(0, 0, 440, 460), 'endchar'],
    e: [30, 500, 'hsbw', ...box(0, 0, 440, 460), 20, 200, 'rmoveto', 400, 0, 'rlineto', 0, 40, 'rlineto', -400, 0, 'rlineto', 'closepath', 'endchar'],
    s: [40, 420, 'hsbw', ...box(0, 0, 340, 460), 'endchar'],
    acute: [100, 333, 'hsbw', ...box(50, 510, 130, 170), 'endchar'],
    cedilla: [80, 333, 'hsbw', ...box(60, -200, 50, 200), 'endchar'],
    Aacute: [20, 700, 'hsbw', 100, 260, 220, 65, 194, 'seac'],
  };
  const subrs = [['return'], ['return'], ['return'], ['return'], [560, 0, 'rlineto', 'return']];
  const parts: Uint8Array[] = [];
  const text = (s: string) => parts.push(new Uint8Array(Buffer.from(s, 'latin1')));
  text('dup /Private 8 dict dup begin\n/RD{string currentfile exch readstring pop}executeonly def\n/ND{noaccess def}executeonly def\n/NP{noaccess put}executeonly def\n/lenIV 4 def\n');
  text(`/Subrs ${subrs.length} array\n`);
  subrs.forEach((sr, i) => {
    const cs = t1CharString(sr);
    text(`dup ${i} ${cs.length} RD `);
    parts.push(cs);
    text(' NP\n');
  });
  text(`ND\n2 index /CharStrings ${Object.keys(glyphs).length} dict dup begin\n`);
  for (const [name, prog] of Object.entries(glyphs)) {
    const cs = t1CharString(prog);
    text(`/${name} ${cs.length} RD `);
    parts.push(cs);
    text(' ND\n');
  }
  text('end\nend\nreadonly put\nnoaccess put\ndup/FontName get exch definefont pop\nmark currentfile closefile\n');
  const priv = t1Encrypt(Buffer.concat(parts), 55665, 4);
  const clear = Buffer.from(
    '%!PS-AdobeFont-1.0: TestType1 001.000\n12 dict begin\n/FontName /TestType1 def\n/FontType 1 def\n/PaintType 0 def\n' +
      '/FontMatrix [0.001 0 0 0.001 0 0] readonly def\n/FontBBox {0 -200 1000 900} readonly def\n/Encoding StandardEncoding def\ncurrentdict end\ncurrentfile eexec\n',
    'latin1',
  );
  return { bytes: Buffer.concat([clear, priv]), length1: clear.length, length2: priv.length };
}

/** Embedded Type1 (synthetic program) and bare CFF (pdf.js's Foxit Serif) simple fonts. */
async function embeddedType1AndCff() {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const page = doc.addPage([595, 842]);

  const t1 = syntheticType1();
  const t1Widths: Record<number, number> = { 32: 250, 65: 700, 97: 500, 101: 500, 115: 420, 193: 700, 233: 500 };
  const t1Font = ctx.obj({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'TestType1',
    FirstChar: 32,
    LastChar: 233,
    Widths: Array.from({ length: 202 }, (_, i) => t1Widths[32 + i] ?? 0),
    // Code 66 is remapped, so "B" has no code and is only reachable as an outline (S3a).
    Encoding: ctx.obj({ Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [66, PDFName.of('bullet')] }),
    FontDescriptor: ctx.register(
      ctx.obj({
        Type: 'FontDescriptor', FontName: 'TestType1', Flags: 32, FontBBox: [0, -200, 1000, 900], ItalicAngle: 0,
        Ascent: 900, Descent: -200, CapHeight: 680, XHeight: 460, StemV: 80,
        FontFile: ctx.register(ctx.flateStream(t1.bytes, { Length1: t1.length1, Length2: t1.length2, Length3: 0 })),
      }),
    ),
  });

  const cff = await readFile(path.join(pdfjsDir, 'standard_fonts', 'FoxitSerif.pfb'));
  // Foxit Serif is metric-compatible with Times-Roman, so the AFM widths fit.
  const times = await PDFDocument.create().then((d) => d.embedFont(StandardFonts.TimesRoman));
  const cffWidths: number[] = [];
  for (let code = 32; code <= 255; code++) {
    const ch = new TextDecoder('windows-1252').decode(Uint8Array.of(code));
    cffWidths.push(code >= 127 && code <= 160 && ch.charCodeAt(0) === code ? 0 : Math.round(times.widthOfTextAtSize(ch, 1000)));
  }
  const cffFont = ctx.obj({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'ABCDEF+FoxitSerif',
    FirstChar: 32,
    LastChar: 255,
    Widths: cffWidths,
    Encoding: 'WinAnsiEncoding',
    FontDescriptor: ctx.register(
      ctx.obj({
        Type: 'FontDescriptor', FontName: 'ABCDEF+FoxitSerif', Flags: 34, FontBBox: [-168, -218, 1000, 898], ItalicAngle: 0,
        Ascent: 683, Descent: -217, CapHeight: 662, XHeight: 450, StemV: 84,
        FontFile3: ctx.register(ctx.flateStream(new Uint8Array(cff), { Subtype: 'Type1C' })),
      }),
    ),
  });
  page.node.setFontDictionary(PDFName.of('T1'), ctx.register(t1Font));
  page.node.setFontDictionary(PDFName.of('C1'), ctx.register(cffFont));
  const content = ['BT /T1 24 Tf 60 760 Td (Aa es) Tj ET', 'BT /C1 16 Tf 60 700 Td (Serif text in a bare CFF font) Tj ET'].join('\n');
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(content)));
  await save('type1-cff.pdf', doc);
}

/** Two pages with a running header (text + rule) and footer; page 1 ends with a table and a line under it, page 2 has body text. */
async function pagedTable() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = Array.from({ length: 8 }, (_, i) => `Body paragraph line ${i + 1} of the page.`);
  for (let n = 1; n <= 2; n++) {
    const page = doc.addPage([595, 842]);
    page.drawText('Quarterly report', { x: 60, y: 800, size: 10, font: helv });
    page.drawLine({ start: { x: 60, y: 792 }, end: { x: 535, y: 792 }, thickness: 0.5, color: rgb(0.4, 0.4, 0.4) });
    page.drawText(`Page ${n}`, { x: 280, y: 30, size: 10, font: helv });
    if (n === 2) {
      paragraph(page, body, 60, 740, helv, 12);
      continue;
    }
    paragraph(page, body, 60, 740, helv, 12);
    const cols = [60, 220, 340, 460];
    const right = 535;
    const rowH = 24;
    const top = 230;
    const data = [
      ['Item', 'Qty', 'Price', 'Total'],
      ['Apples', '10', '1.20', '12.00'],
      ['Pears', '4', '2.50', '10.00'],
      ['Cherries', '200', '0.10', '20.00'],
    ];
    data.forEach((row, r) => row.forEach((cell, c) => page.drawText(cell, { x: cols[c]! + 6, y: top - (r + 1) * rowH + 8, size: 11, font: r === 0 ? bold : helv })));
    const border = { thickness: 0.8, color: rgb(0.3, 0.3, 0.3) };
    const outer = { thickness: 2, color: rgb(0, 0, 0) };
    for (let r = 0; r <= data.length; r++) page.drawLine({ start: { x: cols[0]!, y: top - r * rowH }, end: { x: right, y: top - r * rowH }, ...(r === 0 || r === data.length ? outer : border) });
    for (const x of [...cols, right]) page.drawLine({ start: { x, y: top }, end: { x, y: top - data.length * rowH }, ...border });
    page.drawText('Line under the table.', { x: 60, y: 100, size: 12, font: helv });
  }
  await save('paged-table.pdf', doc);
}

/** One scanned page (2 px/pt): header and footer bars, text bars, and a bordered 4 × 4 table near the bottom. No text layer. */
/** Page scan at 2 px/pt: header line, body bars, a bordered 4 × 4 table, a bar below it, a footer bar. */
function pagedScanPixels() {
  const s = 2;
  const [pw, ph] = [595, 842];
  const w = pw * s;
  const h = ph * s;
  const px = new Uint8Array(w * h).fill(246);
  const rect = (x0: number, y0: number, x1: number, y1: number, v: number) => {
    for (let y = Math.round((ph - y1) * s); y < Math.round((ph - y0) * s); y++) for (let x = Math.round(x0 * s); x < Math.round(x1 * s); x++) px[y * w + x] = v;
  };
  rect(60, 798, 220, 808, 50);
  rect(260, 28, 330, 38, 50);
  for (let y = 740; y > 500; y -= 16) rect(60, y, 520, y + 8, 60);
  const xs = [60, 220, 340, 460, 535];
  const ys = [230, 206, 182, 158, 134];
  for (let r = 0; r < ys.length - 1; r++) for (let c = 0; c < xs.length - 1; c++) rect(xs[c]! + 6, ys[r + 1]! + 8, xs[c]! + 50, ys[r + 1]! + 15, 55);
  for (const y of ys) rect(xs[0]! - 0.75, y - 0.75, xs[4]! + 0.75, y + 0.75, 45);
  for (const x of xs) rect(x - 0.75, ys[4]! - 0.75, x + 0.75, ys[0]! + 0.75, 45);
  rect(60, 100, 300, 108, 60);
  return { px, w, h, pw, ph };
}

async function scanPage(name: string, image: (doc: PDFDocument, px: Uint8Array, w: number, h: number) => ReturnType<PDFDocument['context']['register']>) {
  const doc = await PDFDocument.create();
  const { px, w, h, pw, ph } = pagedScanPixels();
  const ctx = doc.context;
  const img = image(doc, px, w, h);
  const page = doc.addPage([pw, ph]);
  page.node.setXObject(PDFName.of('Im1'), img);
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(`q ${pw} 0 0 ${ph} 0 0 cm /Im1 Do Q`)));
  await save(name, doc);
}

async function pagedScan() {
  await scanPage('paged-scan.pdf', (doc, px, w, h) => doc.context.register(doc.context.flateStream(px, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8 })));
}

/** paged-scan.pdf stored as a JPEG (DCTDecode, RGB, quality 90), like most scanner output; encoded with pdf.js's canvas package. */
async function pagedScanJpeg() {
  const { createCanvas } = createRequire(require.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
  await scanPage('paged-scan-jpeg.pdf', (doc, px, w, h) => {
    const canvas = createCanvas(w, h);
    const g = canvas.getContext('2d');
    const data = g.createImageData(w, h);
    for (let i = 0; i < w * h; i++) data.data.set([px[i]!, px[i]!, px[i]!, 255], i * 4);
    g.putImageData(data, 0, 0);
    const jpeg = canvas.toBuffer('image/jpeg', 90);
    const dict = doc.context.obj({ Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' });
    return doc.context.register(PDFRawStream.of(dict, new Uint8Array(jpeg)));
  });
}

await mkdir(outDir, { recursive: true });
await latinStandard14();
await embeddedSubset('cyrillic-subset.pdf', ['Привет, мир! Это проверка редактора.', 'Съешь же ещё этих мягких французских булок.'], 'Отчёт за квартал');
await embeddedSubset('turkish-subset.pdf', ["Şişli'de ılık bir gün geçirdik.", 'İğdır, Çanakkale ve Muğla şehirleri.'], 'Türkçe Başlık');
await simpleTrueType();
await scanned();
await scannedTable();
await table();
await zebraTable();
await imageTable();
await embeddedType1AndCff();
await pagedTable();
await pagedScan();
await pagedScanJpeg();
