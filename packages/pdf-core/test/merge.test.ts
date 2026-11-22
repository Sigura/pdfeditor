import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFArray, PDFHexString, PDFNumber, type PDFObject, type PDFPage, PDFRawStream, type PDFRef, PDFTextField, decodePDFRawStream } from 'pdf-lib';
import { arrangePdf, mergePdfs } from '../src/merge.ts';
import { addInternalLink, encryptRc4, makePdf } from './helpers.ts';

/** /PageLabels as [start, style, prefix, first number] per range. */
const labelRanges = (doc: PDFDocument) => {
  const nums = doc.catalog.lookup(PDFName.of('PageLabels'), PDFDict).lookup(PDFName.of('Nums'), PDFArray);
  const out: unknown[] = [];
  for (let i = 0; i < nums.size(); i += 2) {
    const d = nums.lookup(i + 1, PDFDict);
    const p = d.lookup(PDFName.of('P'));
    out.push([nums.lookup(i, PDFNumber).asNumber(), d.lookup(PDFName.of('S'))?.toString().slice(1), p instanceof PDFHexString ? p.decodeText() : undefined, d.lookupMaybe(PDFName.of('St'), PDFNumber)?.asNumber() ?? 1]);
  }
  return out;
};

describe('mergePdfs', () => {
  it('carries page labels over; pages of files without labels and blanks are numbered by position', async () => {
    const a = await makePdf(3, 'A');
    a.catalog.set(PDFName.of('PageLabels'), a.context.obj({ Nums: [0, { S: 'r' }] }));
    const b = await makePdf(2, 'B');
    const out = await PDFDocument.load(await mergePdfs([{ file: await a.save() , pages: '2-3' }, { blank: true }, { file: await b.save() }]));
    expect(labelRanges(out)).toEqual([[0, 'r', undefined, 2], [2, 'D', undefined, 3]]);
    const plain = await PDFDocument.load(await mergePdfs([{ file: await b.save() }]));
    expect(plain.catalog.has(PDFName.of('PageLabels'))).toBe(false);
  });

  it('concatenates ranges keeping size, rotation and file bookmarks', async () => {
    const a = await makePdf(3, 'A', { size: [300, 400] });
    const b = await makePdf(5, 'B', { size: [500, 200], rotate: 90 });
    const out = await PDFDocument.load(
      await mergePdfs([{ file: await a.save(), name: 'Alpha' }, { file: await b.save(), pages: '2-3,5' }]),
    );
    expect(out.getPageCount()).toBe(6);
    expect(out.getPage(0).getSize()).toEqual({ width: 300, height: 400 });
    expect(out.getPage(3).getSize()).toEqual({ width: 500, height: 200 });
    expect(out.getPage(3).getRotation().angle).toBe(90);

    const outlines = out.catalog.lookup(PDFName.of('Outlines'), PDFDict);
    const first = outlines.lookup(PDFName.of('First'), PDFDict);
    expect((first.lookup(PDFName.of('Title')) as PDFHexString).decodeText()).toBe('Alpha');
    const dest = first.lookup(PDFName.of('Dest'), PDFArray);
    expect(dest.get(0)).toBe(out.getPage(0).ref);
  });

  it('adds rotation per input and blank pages sized like the page shown before (or after, when first)', async () => {
    const b = await (await makePdf(2, 'B', { size: [500, 200], rotate: 90 })).save();
    const out = await PDFDocument.load(await mergePdfs([{ blank: true }, { file: b, pages: '1', rotate: 270 }, { file: b, pages: '2' }, { blank: true }]));
    expect(out.getPageCount()).toBe(4);
    expect(out.getPage(1).getRotation().angle).toBe(0);
    expect(out.getPage(2).getRotation().angle).toBe(90);
    // Page 2 is shown 200 × 500 (rotated 90°); the blank after it is that size, unrotated.
    expect(out.getPage(3).getSize()).toEqual({ width: 200, height: 500 });
    expect(out.getPage(3).getRotation().angle).toBe(0);
    expect(out.getPage(0).getSize()).toEqual({ width: 500, height: 200 });
    expect(out.getPage(0).node.Contents()).toBeUndefined();
  });

  it('copies output pages sharing content and resources, with their own links', async () => {
    const a = await makePdf(2, 'A', { size: [300, 400], rotate: 90 });
    addInternalLink(a, a.getPage(1), a.getPage(0));
    const bytes = await mergePdfs([{ blank: true }, { copy: 0 }, { file: await a.save() }, { copy: 3 }, { copy: -1 }, { copy: 1 }]);
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(7);
    const [, , , src, c1, c2] = out.getPages();
    for (const c of [c1!, c2!]) {
      // Same object numbers = shared objects.
      expect(String(c.node.get(PDFName.of('Contents')))).toBe(String(src!.node.get(PDFName.of('Contents'))));
      expect(String(c.node.Resources()!.get(PDFName.of('Font')))).toBe(String(src!.node.Resources()!.get(PDFName.of('Font'))));
      expect(c.getRotation().angle).toBe(90);
      const link = c.node.Annots()!.lookup(0, PDFDict);
      expect(link).not.toBe(src!.node.Annots()!.lookup(0, PDFDict));
      expect(link.get(PDFName.of('P'))).toBe(c.ref);
      expect(link.lookup(PDFName.of('Dest'), PDFArray).get(0)).toBe(out.getPage(2).ref);
    }
    // Copies of the leading blank: sized like the first real page as shown, before and after it.
    for (const k of [0, 1, 6]) expect(out.getPage(k).getSize()).toEqual({ width: 400, height: 300 });
    await expect(mergePdfs([{ copy: 0 }])).rejects.toThrow(/0 pages come before it/);
  });

  it('remaps internal links and drops links to excluded pages without orphan page copies', async () => {
    const a = await makePdf(3, 'A');
    addInternalLink(a, a.getPage(0), a.getPage(2));
    addInternalLink(a, a.getPage(1), a.getPage(0));
    const bytes = await mergePdfs([{ file: await a.save(), pages: '1,3' }]);
    const out = await PDFDocument.load(bytes);
    const annots0 = out.getPage(0).node.Annots()!;
    const dest = annots0.lookup(0, PDFDict).lookup(PDFName.of('Dest'), PDFArray);
    expect(dest.get(0)).toBe(out.getPage(1).ref);
    const pageObjs = out.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFDict && o.lookup(PDFName.of('Type')) === PDFName.of('Page'));
    expect(pageObjs.length).toBe(2);
  });

  it('renames colliding AcroForm fields', async () => {
    const make = async () => {
      const d = await makePdf(1, 'F');
      d.getForm().createTextField('name').addToPage(d.getPage(0), { x: 20, y: 20 });
      return d.save();
    };
    const out = await PDFDocument.load(await mergePdfs([{ file: await make() }, { file: await make() }]));
    const names = out.getForm().getFields().map((f) => f.getName()).sort();
    expect(names).toEqual(['name', 'name_2']);
    expect(out.getForm().getFields().every((f) => f instanceof PDFTextField)).toBe(true);
  });

  it('reports encrypted files clearly and opens them with the password', async () => {
    const enc = await encryptRc4(await makePdf(2, 'S'), 'user-pw', 'owner-pw');
    await expect(mergePdfs([{ file: enc }])).rejects.toMatchObject({ code: 'ENCRYPTED' });
    await expect(mergePdfs([{ file: enc, password: 'nope' }])).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
    for (const password of ['user-pw', 'owner-pw']) {
      const out = await PDFDocument.load(await mergePdfs([{ file: enc, password }]));
      expect(out.getPageCount()).toBe(2);
      const contents = out.getPage(0).node.Contents();
      const stream = (contents instanceof PDFArray ? contents.lookup(0) : contents) as PDFRawStream;
      const text = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      expect(text).toMatch(/BT[\s\S]*Tj[\s\S]*ET/);
    }
  });
});

describe('arrangePdf', () => {
  it('keeps each page its label when pages move or go', async () => {
    const doc = await makePdf(4, 'A');
    const ctx = doc.context;
    doc.catalog.set(PDFName.of('PageLabels'), ctx.obj({ Nums: [0, { S: 'r' }, 2, { S: 'D', P: PDFHexString.fromText('A-') }] }));
    const out = await PDFDocument.load(await arrangePdf(await doc.save({ useObjectStreams: false }), [{ page: 2 }, { page: 0 }, { page: 1 }, { page: 3 }]));
    expect(labelRanges(out)).toEqual([[0, 'D', 'A-', 1], [1, 'r', undefined, 1], [3, 'D', 'A-', 2]]);
  });

  it('removes links to removed pages from the pages it keeps', async () => {
    const doc = await makePdf(3, 'A');
    const [p0, p1, p2] = doc.getPages() as [PDFPage, PDFPage, PDFPage];
    addInternalLink(doc, p0, p1);
    addInternalLink(doc, p0, p2);
    const ctx = doc.context;
    p2.node.addAnnot(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 9, 9], A: { S: 'GoTo', D: PDFHexString.fromText('mid') } })));
    p2.node.addAnnot(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 9, 9], A: { S: 'URI', URI: PDFHexString.fromText('https://example.com') } })));
    doc.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: { Names: [PDFHexString.fromText('mid'), [p1.ref, 'Fit']] } }));

    const out = await PDFDocument.load(await arrangePdf(await doc.save({ useObjectStreams: false }), [{ page: 2 }, { page: 0 }]));
    const targets = (k: number) =>
      out.getPage(k).node.Annots()!.asArray().map((r) => {
        const annot = out.context.lookup(r, PDFDict);
        const dest = annot.lookupMaybe(PDFName.of('Dest'), PDFArray);
        return dest ? out.getPages().findIndex((p) => p.ref === dest.get(0)) : annot.lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('S'))!.toString();
      });
    expect(targets(1)).toEqual([0]);
    expect(targets(0)).toEqual(['/URI']);
  });

  it('unlinks outline items that point to removed pages, keeping their children and the open state', async () => {
    const doc = await makePdf(4, 'A');
    const ctx = doc.context;
    const [p0, p1, p2] = doc.getPages().map((p) => p.ref);
    const refs = Array.from({ length: 6 }, () => ctx.nextRef());
    const [root, part, kid0, kid1, gone, named] = refs as [PDFRef, PDFRef, PDFRef, PDFRef, PDFRef, PDFRef];
    const item = (title: string, extra: Record<string, unknown>) => ctx.obj({ Title: PDFHexString.fromText(title), ...extra });
    ctx.assign(root, ctx.obj({ Type: 'Outlines', First: part, Last: named, Count: 5 }));
    ctx.assign(part, item('Part', { Parent: root, Next: gone, First: kid0, Last: kid1, Count: 2, Dest: [p1, 'Fit'] }));
    ctx.assign(kid0, item('Kid 0', { Parent: part, Next: kid1, Dest: [p0, 'Fit'] }));
    ctx.assign(kid1, item('Kid 1', { Parent: part, Prev: kid0, A: { S: 'GoTo', D: [p1, 'XYZ', 0, 700, 0] } }));
    ctx.assign(gone, item('Page 3', { Parent: root, Prev: part, Next: named, Dest: [p2, 'Fit'] }));
    ctx.assign(named, item('Named', { Parent: root, Prev: gone, Dest: PDFName.of('there') }));
    doc.catalog.set(PDFName.of('Dests'), ctx.obj({ there: [p1, 'Fit'] }));
    doc.catalog.set(PDFName.of('Outlines'), root);

    const out = await PDFDocument.load(await arrangePdf(await doc.save({ useObjectStreams: false }), [{ page: 2 }, { page: 0 }, { page: 3 }]));
    const outlines = out.catalog.lookup(PDFName.of('Outlines'), PDFDict);
    const titles = (first: PDFObject | undefined): unknown[] => {
      const res: unknown[] = [];
      for (let cur = out.context.lookup(first); cur instanceof PDFDict; cur = out.context.lookup(cur.get(PDFName.of('Next')))) {
        const kids = titles(cur.get(PDFName.of('First')));
        const title = (cur.lookup(PDFName.of('Title')) as PDFHexString).decodeText();
        res.push(kids.length ? { [title]: kids, count: cur.lookup(PDFName.of('Count'), PDFNumber).asNumber() } : title);
      }
      return res;
    };
    expect(titles(outlines.get(PDFName.of('First')))).toEqual([{ Part: ['Kid 0'], count: 1 }, 'Page 3']);
    expect(outlines.lookup(PDFName.of('Count'), PDFNumber).asNumber()).toBe(3);
    const partOut = outlines.lookup(PDFName.of('First'), PDFDict);
    expect(partOut.has(PDFName.of('Dest'))).toBe(false);
    expect(out.context.lookup(outlines.get(PDFName.of('Last')))).toBe(out.context.lookup(partOut.get(PDFName.of('Next'))));
    const pageOut = out.context.lookup(outlines.get(PDFName.of('Last'))) as PDFDict;
    expect(pageOut.has(PDFName.of('Next'))).toBe(false);
    expect(pageOut.lookup(PDFName.of('Dest'), PDFArray).get(0)).toBe(out.getPage(0).ref);
  });
});
