import type { ApiError, EditOperation, EditResult } from '@pdf-toolkit/shared';

export async function apiError(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as ApiError;
    return new Error(`${body.error.message} (${body.error.code})`);
  } catch {
    return new Error(`Request failed with HTTP ${res.status}`);
  }
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
