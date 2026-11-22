import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { analyzePdf, applyEdits, mergePdfs, type BlankPage, type MergeInput, type PdfAnalysis } from '@pdf-toolkit/pdf-core';
import { EditBatchSchema, MergeRangesSchema, MergeSegmentsSchema, type DocumentInfo, type EditResult } from '@pdf-toolkit/shared';
import { config } from './config.ts';
import { HttpError, contentDisposition, errorResponse, readPdfFile } from './http.ts';
import { DocumentStore } from './store.ts';

export function createApp(opts: { store?: DocumentStore } = {}) {
  const store = opts.store ?? new DocumentStore(config.dataDir, config.ttlMs);
  const analyses = new Map<string, Promise<PdfAnalysis>>();
  const app = new Hono();
  app.onError(errorResponse);
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: config.maxFileBytes * config.maxFiles,
      onError: (c) => c.json({ error: { code: 'TOO_LARGE', message: 'Request body too large' } }, 413),
    }),
  );

  // Page models always come from the original plus the edit state, so element IDs stay stable
  // across revisions (a re-parse of an edited file would renumber operators).
  const analysisOf = async (docId: string): Promise<PdfAnalysis> => {
    const meta = await store.meta(docId);
    const key = `${docId}@${meta.revision}`;
    let a = analyses.get(key);
    if (!a) {
      a = store.original(docId).then(async (bytes): Promise<PdfAnalysis> => {
        if (meta.ops.length === 0) return analyzePdf(bytes);
        const res = await applyEdits(bytes, meta.ops);
        return { pageCount: res.pages.length, pages: res.pages, decrypted: false };
      });
      analyses.set(key, a);
      a.catch(() => analyses.delete(key));
      if (analyses.size > 50) analyses.delete(analyses.keys().next().value!);
    }
    return a;
  };

  app.get('/api/health', (c) => c.json({ ok: true }));

  // multipart: files[] (ordered); optional `ranges` and `passwords` = JSON arrays aligned with files;
  // optional `segments` = JSON [{file, pages, rotate?} | {blank: true}] for an arbitrary page order across
  // files, page rotation and blank pages (overrides ranges).
  app.post('/api/merge', async (c) => {
    const form = await c.req.formData();
    const files = form.getAll('files');
    if (files.length === 0) throw new HttpError(400, 'BAD_REQUEST', 'No files uploaded (field "files")');
    if (files.length > config.maxFiles) throw new HttpError(400, 'BAD_REQUEST', `At most ${config.maxFiles} files`);
    const parseJson = <T,>(field: string, schema: z.ZodType<T>, what: string): T | undefined => {
      const raw = form.get(field);
      if (raw === null) return undefined;
      try {
        return schema.parse(JSON.parse(String(raw)));
      } catch {
        throw new HttpError(400, 'BAD_REQUEST', `"${field}" must be ${what}`);
      }
    };
    const ranges = parseJson('ranges', MergeRangesSchema, 'a JSON array of strings') ?? [];
    const passwords = parseJson('passwords', MergeRangesSchema, 'a JSON array of strings') ?? [];
    const segments = parseJson('segments', MergeSegmentsSchema, 'a JSON array of {file, pages, rotate?} or {blank: true}');
    const uploads: MergeInput[] = [];
    for (const [i, f] of files.entries()) {
      const { bytes, name } = await readPdfFile(f, `File ${i + 1}`);
      uploads.push({ file: bytes, pages: ranges[i] || undefined, password: passwords[i] || undefined, name: name.replace(/\.pdf$/i, '') });
    }
    const inputs: (MergeInput | BlankPage)[] = segments
      ? segments.map((s) => {
          if ('blank' in s) return s;
          const up = uploads[s.file];
          if (!up) throw new HttpError(400, 'BAD_REQUEST', `Segment references missing file ${s.file}`);
          return { ...up, pages: s.pages || undefined, rotate: s.rotate || undefined };
        })
      : uploads;
    const merged = await mergePdfs(inputs);
    return c.body(new Uint8Array(merged), 200, { 'Content-Type': 'application/pdf', 'Content-Disposition': contentDisposition('merged.pdf') });
  });

  app.post('/api/documents', async (c) => {
    const form = await c.req.formData();
    const { bytes, name } = await readPdfFile(form.get('file'), 'file');
    const pw = form.get('password');
    const password = typeof pw === 'string' && pw !== '' ? pw : undefined;
    const analysis = await analyzePdf(bytes, { password });
    // Encrypted uploads are stored decrypted (inside the TTL-limited temp dir) so rendering and
    // editing never need the password again.
    const meta = await store.create(name, analysis.decryptedBytes ?? bytes, analysis.decrypted);
    analyses.set(`${meta.docId}@0`, Promise.resolve({ ...analysis, decryptedBytes: undefined }));
    const body: DocumentInfo = { docId: meta.docId, fileName: meta.fileName, pageCount: analysis.pageCount, pages: analysis.pages };
    return c.json(body, 201);
  });

  app.get('/api/documents/:id', async (c) => {
    const id = c.req.param('id');
    const [meta, analysis] = await Promise.all([store.meta(id), analysisOf(id)]);
    const body: DocumentInfo & { revision: number; ops: unknown[]; reports: unknown[]; warnings: string[] } = {
      docId: id,
      fileName: meta.fileName,
      pageCount: analysis.pageCount,
      pages: analysis.pages,
      revision: meta.revision,
      ops: meta.ops,
      reports: meta.reports,
      warnings: meta.warnings,
    };
    return c.json(body);
  });

  const locks = new Map<string, Promise<unknown>>();
  const withLock = <T,>(docId: string, fn: () => Promise<T>): Promise<T> => {
    const run = (locks.get(docId) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    locks.set(docId, tail);
    void tail.then(() => locks.get(docId) === tail && locks.delete(docId));
    return run;
  };

  // Body: { ops, mode: 'append' | 'replace' }. The full op list is re-applied to the original each
  // time, so undo is a 'replace' with a shorter list.
  app.post('/api/documents/:id/edits', async (c) => {
    const id = c.req.param('id');
    const raw: unknown = await c.req.json().catch(() => {
      throw new HttpError(400, 'BAD_REQUEST', 'Body must be JSON');
    });
    const parsed = EditBatchSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, 'BAD_REQUEST', 'Invalid edit batch', parsed.error.issues);
    const body = await withLock(id, async () => {
      const meta = await store.meta(id);
      const ops = parsed.data.mode === 'replace' ? parsed.data.ops : [...meta.ops, ...parsed.data.ops];
      const result = await applyEdits(await store.original(id), ops);
      await store.writeCurrent(id, result.bytes);
      meta.ops = ops;
      meta.reports = result.reports;
      meta.warnings = result.warnings;
      meta.revision += 1;
      await store.saveMeta(meta);
      analyses.set(`${id}@${meta.revision}`, Promise.resolve({ pageCount: result.pages.length, pages: result.pages, decrypted: false }));
      const out: EditResult = { docId: id, revision: meta.revision, ops, reports: result.reports, warnings: result.warnings, overflows: result.overflows, continuations: result.continuations, pages: result.pages };
      return out;
    });
    return c.json(body);
  });

  app.get('/api/documents/:id/pages/:n/model', async (c) => {
    const n = Number(c.req.param('n'));
    const analysis = await analysisOf(c.req.param('id'));
    const page = Number.isInteger(n) ? analysis.pages[n] : undefined;
    if (!page) throw new HttpError(404, 'NOT_FOUND', `Page ${c.req.param('n')} not found (0-based, ${analysis.pageCount} pages)`);
    return c.json(page);
  });

  // Current revision for in-browser rendering (?original=1: the uploaded file, for measurements in original coordinates).
  const sendCurrent = async (id: string, attachment: boolean, original = false) => {
    const meta = await store.meta(id);
    const bytes = original ? await store.original(id) : await store.current(id);
    const headers: Record<string, string> = { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' };
    if (attachment) headers['Content-Disposition'] = contentDisposition(meta.fileName.replace(/\.pdf$/i, '') + (meta.revision ? '-edited.pdf' : '.pdf'));
    return new Response(new Uint8Array(bytes), { status: 200, headers });
  };
  app.get('/api/documents/:id/pdf', (c) => sendCurrent(c.req.param('id'), false, c.req.query('original') === '1'));
  app.get('/api/documents/:id/download', (c) => sendCurrent(c.req.param('id'), true));

  return { app, store };
}
