import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { EditOperationSchema, StrategyReportSchema } from '@pdf-toolkit/shared';
import { HttpError } from './http.ts';

const MetaSchema = z.object({
  docId: z.string(),
  fileName: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  revision: z.number().int(),
  encrypted: z.boolean(),
  ops: z.array(EditOperationSchema),
  reports: z.array(StrategyReportSchema).default([]),
  warnings: z.array(z.string()).default([]),
});
export type DocMeta = z.infer<typeof MetaSchema>;

const ID_RE = /^[0-9a-f-]{36}$/;

export class DocumentStore {
  private timer: NodeJS.Timeout | undefined;

  constructor(readonly root: string, readonly ttlMs: number) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.cleanup();
    this.timer = setInterval(() => void this.cleanup(), Math.min(this.ttlMs, 5 * 60 * 1000));
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private dir(docId: string): string {
    if (!ID_RE.test(docId)) throw new HttpError(404, 'NOT_FOUND', 'Document not found');
    return path.join(this.root, docId);
  }

  async create(fileName: string, bytes: Uint8Array, encrypted: boolean): Promise<DocMeta> {
    const docId = randomUUID();
    const dir = this.dir(docId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'original.pdf'), bytes);
    const now = Date.now();
    const meta: DocMeta = { docId, fileName, createdAt: now, updatedAt: now, revision: 0, encrypted, ops: [], reports: [], warnings: [] };
    await this.saveMeta(meta);
    return meta;
  }

  // Every document request reads the meta, so touching meta.json here makes the TTL count from the last use.
  async meta(docId: string): Promise<DocMeta> {
    const file = path.join(this.dir(docId), 'meta.json');
    try {
      const meta = MetaSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      const now = new Date();
      await utimes(file, now, now);
      return meta;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HttpError(404, 'NOT_FOUND', `This document has expired (files are kept ${Math.round(this.ttlMs / 60000)} minutes after their last use). Reopen the file.`);
      }
      throw e;
    }
  }

  async saveMeta(meta: DocMeta): Promise<void> {
    meta.updatedAt = Date.now();
    await writeFile(path.join(this.dir(meta.docId), 'meta.json'), JSON.stringify(meta));
  }

  original(docId: string): Promise<Buffer> {
    return readFile(path.join(this.dir(docId), 'original.pdf'));
  }

  async current(docId: string): Promise<Buffer> {
    const meta = await this.meta(docId);
    if (meta.revision === 0) return this.original(docId);
    return readFile(path.join(this.dir(docId), 'current.pdf'));
  }

  async writeCurrent(docId: string, bytes: Uint8Array | null): Promise<void> {
    const file = path.join(this.dir(docId), 'current.pdf');
    if (bytes) await writeFile(file, bytes);
    else await rm(file, { force: true });
  }

  async cleanup(): Promise<void> {
    const now = Date.now();
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      if (!ID_RE.test(name)) continue;
      const dir = path.join(this.root, name);
      const st = await stat(path.join(dir, 'meta.json')).catch(() => null);
      if (!st || now - st.mtimeMs > this.ttlMs) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
}
