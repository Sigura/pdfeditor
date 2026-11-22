import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../src/app.ts';
import { sanitizeFileName } from '../src/http.ts';
import { makePdf } from '../../../packages/pdf-core/test/helpers.ts';

describe('POST /api/merge', () => {
  it('merges ordered uploads with ranges', async () => {
    const form = new FormData();
    form.append('files', new File([await (await makePdf(3, 'A')).save()], 'a.pdf', { type: 'application/pdf' }));
    form.append('files', new File([await (await makePdf(4, 'B')).save()], 'b.pdf', { type: 'application/pdf' }));
    form.append('ranges', JSON.stringify(['', '2-3']));
    const res = await createApp().app.request('/api/merge', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const doc = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    expect(doc.getPageCount()).toBe(5);
  });

  it('accepts segments for an interleaved page order', async () => {
    const form = new FormData();
    form.append('files', new File([await (await makePdf(3, 'A')).save()], 'a.pdf'));
    form.append('files', new File([await (await makePdf(2, 'B')).save()], 'b.pdf'));
    form.append('segments', JSON.stringify([{ file: 1, pages: '2' }, { file: 0, pages: '1-3' }, { file: 1, pages: '1' }]));
    const res = await createApp().app.request('/api/merge', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    expect((await PDFDocument.load(new Uint8Array(await res.arrayBuffer()))).getPageCount()).toBe(5);
  });

  it('rejects non-PDF uploads and bad ranges with JSON errors', async () => {
    const form = new FormData();
    form.append('files', new File(['hello'], 'x.pdf'));
    const res = await createApp().app.request('/api/merge', { method: 'POST', body: form });
    expect(res.status).toBe(415);
    const form2 = new FormData();
    form2.append('files', new File([await (await makePdf(1, 'A')).save()], 'a.pdf'));
    form2.append('ranges', JSON.stringify(['5']));
    const res2 = await createApp().app.request('/api/merge', { method: 'POST', body: form2 });
    expect(res2.status).toBe(400);
    expect(((await res2.json()) as { error: { code: string } }).error.code).toBe('INVALID_RANGE');
  });
});

describe('sanitizeFileName', () => {
  it('strips paths and control characters', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd.pdf');
    expect(sanitizeFileName('a"b\r\n.pdf')).toBe('ab.pdf');
    expect(sanitizeFileName('...')).toBe('document.pdf');
  });
});

describe('documents API', () => {
  it('uploads, returns page models, serves the PDF, and 404s unknown ids', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { DocumentStore } = await import('../src/store.ts');
    const store = new DocumentStore(await mkdtemp(path.join(os.tmpdir(), 'pdft-')), 60_000);
    const { app } = createApp({ store });
    const form = new FormData();
    form.append('file', new File([await (await makePdf(2, 'Doc')).save()], 'my doc.pdf'));
    const res = await app.request('/api/documents', { method: 'POST', body: form });
    expect(res.status).toBe(201);
    const info = (await res.json()) as { docId: string; pageCount: number; pages: { textBoxes: { text: string }[] }[] };
    expect(info.pageCount).toBe(2);
    expect(info.pages[1]!.textBoxes[0]!.text).toBe('Doc page 2');
    const model = await app.request(`/api/documents/${info.docId}/pages/0/model`);
    expect(((await model.json()) as { textBoxes: { text: string }[] }).textBoxes[0]!.text).toBe('Doc page 1');
    const dl = await app.request(`/api/documents/${info.docId}/download`);
    expect(dl.headers.get('content-disposition')).toContain('my doc.pdf');
    expect((await app.request('/api/documents/00000000-0000-0000-0000-000000000000/pages/0/model')).status).toBe(404);
    expect((await app.request('/api/documents/../../etc/pages/0/model')).status).toBe(404);
  });
});
