import type { Context } from 'hono';
import { PdfError } from '@pdf-toolkit/pdf-core';
import { config } from './config.ts';

export class HttpError extends Error {
  constructor(readonly status: 400 | 404 | 413 | 415 | 422 | 500, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

const PDF_STATUS: Record<string, 400 | 404 | 422> = {
  INVALID_RANGE: 400,
  INVALID_PDF: 422,
  ENCRYPTED: 422,
  BAD_PASSWORD: 422,
  UNSUPPORTED_ENCRYPTION: 422,
  NOT_FOUND: 404,
  UNSUPPORTED: 422,
  NO_GLYPH_SOURCE: 422,
  INVALID_EDIT: 400,
};

export function errorResponse(err: unknown, c: Context) {
  if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  if (err instanceof PdfError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, PDF_STATUS[err.code] ?? 422);
  console.error(err);
  return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500);
}

/** Keeps a safe, readable file name for Content-Disposition. */
export function sanitizeFileName(name: string, fallback = 'document.pdf'): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.normalize('NFKC').replace(/[\u0000-\u001f\u007f"<>:|?*;]/g, '').replace(/^\.+/, '').trim().slice(0, 150);
  if (!clean) return fallback;
  return clean.toLowerCase().endsWith('.pdf') ? clean : `${clean}.pdf`;
}

export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function readPdfFile(file: unknown, label: string): Promise<{ bytes: Uint8Array; name: string }> {
  if (!(file instanceof File)) throw new HttpError(400, 'BAD_REQUEST', `${label}: expected a file upload`);
  if (file.size > config.maxFileBytes) throw new HttpError(413, 'TOO_LARGE', `${label}: file exceeds ${config.maxFileBytes / 1024 / 1024} MB`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!Buffer.from(bytes.subarray(0, 1024)).includes('%PDF-')) throw new HttpError(415, 'NOT_PDF', `${label}: not a PDF file`);
  return { bytes, name: sanitizeFileName(file.name) };
}
