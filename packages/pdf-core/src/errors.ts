export type PdfErrorCode =
  | 'INVALID_RANGE'
  | 'INVALID_PDF'
  | 'ENCRYPTED'
  | 'BAD_PASSWORD'
  | 'UNSUPPORTED_ENCRYPTION'
  | 'NOT_FOUND'
  | 'UNSUPPORTED'
  | 'NO_GLYPH_SOURCE'
  | 'INVALID_EDIT';

export class PdfError extends Error {
  readonly code: PdfErrorCode;
  readonly details: unknown;

  constructor(code: PdfErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'PdfError';
    this.code = code;
    this.details = details;
  }
}
