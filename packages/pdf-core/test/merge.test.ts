import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFArray, PDFHexString, PDFRawStream, PDFTextField, decodePDFRawStream } from 'pdf-lib';
import { mergePdfs } from '../src/merge.ts';
import { addInternalLink, encryptRc4, makePdf } from './helpers.ts';

describe('mergePdfs', () => {
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
