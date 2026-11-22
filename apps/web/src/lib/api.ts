import type { ApiError, EditOperation, EditResult } from '@pdf-toolkit/shared';

/** An error response of the API: `message` is a sentence for the user, `code` the server's error code. */
export class ApiRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function sentence(code: string, message: string): string {
  switch (code) {
    case 'INVALID_EDIT':
      return `The change couldn't be applied: ${message.replace(/^Op \d+: /, '')}.`.replace(/\.\.$/, '.');
    case 'INVALID_PDF':
      return `The file isn't a readable PDF (${message}).`;
    case 'INVALID_RANGE':
      return `Page selection: ${message}.`;
    case 'INTERNAL':
      return 'Something went wrong on the server. Try again; if it keeps happening, reload the page.';
    default:
      return message;
  }
}

export async function apiError(res: Response): Promise<ApiRequestError> {
  let body: ApiError;
  try {
    body = (await res.json()) as ApiError;
  } catch {
    return new ApiRequestError(`HTTP_${res.status}`, res.status >= 500 ? `The server isn't responding (HTTP ${res.status}). Is the API server running?` : `Request failed with HTTP ${res.status}`);
  }
  return new ApiRequestError(body.error.code, sentence(body.error.code, body.error.message));
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** An installed font as GET /api/fonts lists it; `id` addresses its file at /api/fonts/:id. */
export type InstalledFont = {
  id: number;
  postscriptName: string;
  family: string;
  style: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  source: 'local' | 'bundled' | 'system';
  license: { id: string; free: boolean; url?: string };
  embeddable: boolean;
};

export type ServerLimits = { maxFileBytes: number; maxFiles: number };
let limits: Promise<ServerLimits> | undefined;
/** Upload limits the server enforces (MAX_FILE_MB, MAX_FILES). */
export function serverLimits(): Promise<ServerLimits> {
  limits ??= fetch('/api/health').then(async (res) => {
    if (!res.ok) throw await apiError(res);
    return ((await res.json()) as { limits: ServerLimits }).limits;
  });
  limits.catch(() => (limits = undefined));
  return limits;
}

let installed: Promise<InstalledFont[]> | undefined;
export function installedFonts(): Promise<InstalledFont[]> {
  installed ??= fetch('/api/fonts').then(async (res) => {
    if (!res.ok) throw await apiError(res);
    return ((await res.json()) as { fonts: InstalledFont[] }).fonts;
  });
  installed.catch(() => (installed = undefined));
  return installed;
}

export async function postEdits(docId: string, ops: EditOperation[], mode: 'append' | 'replace'): Promise<EditResult> {
  const res = await fetch(`/api/documents/${docId}/edits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ops, mode }),
  });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as EditResult;
}
