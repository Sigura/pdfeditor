import {
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFObject,
  PDFObjectStreamParser,
  PDFParser,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';
import { PdfError } from './errors.ts';
import { StandardDecryptor, readEncryptParams } from './crypto/standard.ts';

export type LoadedPdf = {
  doc: PDFDocument;
  /** True when the source was encrypted and has been decrypted in memory. */
  decrypted: boolean;
};

type ForStream = typeof PDFObjectStreamParser.forStream;
type HeaderParser = { parseIndirectObjectHeader: () => PDFRef };

const headerProto = PDFParser.prototype as unknown as HeaderParser;
const originalHeader = headerProto.parseIndirectObjectHeader;
const originalForStream: ForStream = PDFObjectStreamParser.forStream;

type ParseHook = (raw: PDFRawStream, ref: PDFRef) => PDFObjectStreamParser;

// pdf-lib parses object streams while it reads the file. For encrypted files those streams must be
// decrypted first, and the key depends on the object number, which forStream() doesn't receive.
// The header patch records the ref of the object being parsed; header parsing and forStream() run in
// the same synchronous slice, so the last ref seen is the object stream's own ref.
let lastRef: PDFRef | null = null;
let activeHook: ParseHook | null = null;

async function loadWithHook(bytes: Uint8Array, hook: ParseHook): Promise<PDFDocument> {
  if (activeHook) throw new PdfError('UNSUPPORTED', 'Concurrent encrypted loads are serialized; retry');
  activeHook = hook;
  headerProto.parseIndirectObjectHeader = function patched(this: HeaderParser) {
    const ref = originalHeader.call(this);
    lastRef = ref;
    return ref;
  };
  PDFObjectStreamParser.forStream = (raw, tick) => {
    const h = activeHook;
    if (h && lastRef) return h(raw, lastRef);
    return originalForStream(raw, tick);
  };
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } finally {
    activeHook = null;
    lastRef = null;
    headerProto.parseIndirectObjectHeader = originalHeader;
    PDFObjectStreamParser.forStream = originalForStream;
  }
}

let encryptedQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = encryptedQueue.then(fn, fn);
  encryptedQueue = run.catch(() => undefined);
  return run;
}

const looksEncrypted = (bytes: Uint8Array): boolean => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes('/Encrypt');

export async function loadPdf(bytes: Uint8Array, opts: { password?: string } = {}): Promise<LoadedPdf> {
  if (!Buffer.from(bytes.subarray(0, 1024)).includes('%PDF-')) {
    throw new PdfError('INVALID_PDF', 'Not a PDF file (missing %PDF- header)');
  }
  let plainError: unknown;
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return { doc, decrypted: false };
  } catch (e) {
    if (!(e instanceof EncryptedPDFError) && !looksEncrypted(bytes)) {
      throw new PdfError('INVALID_PDF', `Could not parse PDF: ${(e as Error).message}`);
    }
    plainError = e;
  }
  return serialized(() => loadEncrypted(bytes, opts.password, plainError));
}

const skipObjectStream: ParseHook = () => ({ parseIntoContext: async () => undefined }) as unknown as PDFObjectStreamParser;

async function loadEncrypted(bytes: Uint8Array, password: string | undefined, plainError: unknown): Promise<LoadedPdf> {
  const probe = await loadWithHook(bytes, skipObjectStream);
  const encRaw = probe.context.trailerInfo.Encrypt;
  const encrypt = encRaw instanceof PDFRef ? probe.context.lookup(encRaw) : encRaw;
  if (!(encrypt instanceof PDFDict)) {
    throw new PdfError('INVALID_PDF', `Could not parse PDF: ${(plainError as Error).message}`);
  }
  const idRaw = probe.context.trailerInfo.ID;
  const id = idRaw instanceof PDFRef ? probe.context.lookup(idRaw) : idRaw;
  const params = readEncryptParams(encrypt, id instanceof PDFArray ? id : undefined);

  const decryptor = StandardDecryptor.open(params, password ?? '') ?? (password === undefined ? null : undefined);
  if (decryptor === null) throw new PdfError('ENCRYPTED', 'The PDF is password-protected; a password is required');
  if (decryptor === undefined) throw new PdfError('BAD_PASSWORD', 'The password is incorrect');

  const objStmMembers = new Set<number>();
  const doc = await loadWithHook(bytes, (raw, ref) => {
    const plain = PDFRawStream.of(raw.dict, decryptor.decryptStream(ref.objectNumber, ref.generationNumber, raw.contents));
    for (const n of objectStreamMembers(plain)) objStmMembers.add(n);
    return originalForStream(plain);
  });

  const encryptRef = encRaw instanceof PDFRef ? encRaw : undefined;
  const ctx = doc.context;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (objStmMembers.has(ref.objectNumber)) continue;
    if (encryptRef && ref === encryptRef) continue;
    const decStr = (s: PDFString | PDFHexString): PDFObject =>
      PDFHexString.of(Buffer.from(decryptor.decryptString(ref.objectNumber, ref.generationNumber, s.asBytes())).toString('hex'));
    if (obj instanceof PDFRawStream) {
      const type = obj.dict.lookup(PDFName.of('Type'));
      if (type === PDFName.of('XRef')) continue;
      transformStrings(obj.dict, decStr);
      const skipMeta = type === PDFName.of('Metadata') && !params.encryptMetadata;
      if (!skipMeta) {
        ctx.assign(ref, PDFRawStream.of(obj.dict, decryptor.decryptStream(ref.objectNumber, ref.generationNumber, obj.contents)));
      }
    } else {
      const replaced = transformStrings(obj, decStr);
      if (replaced !== obj) ctx.assign(ref, replaced);
    }
  }
  ctx.trailerInfo.Encrypt = undefined;
  return { doc, decrypted: true };
}

function objectStreamMembers(raw: PDFRawStream): number[] {
  const n = raw.dict.lookup(PDFName.of('N'));
  const first = raw.dict.lookup(PDFName.of('First'));
  if (!n || !first) return [];
  const data = decodePDFRawStream(raw).decode();
  const header = Buffer.from(data.subarray(0, Number(first.toString()))).toString('latin1');
  const nums = header.trim().split(/\s+/).map(Number);
  const out: number[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push(nums[i]!);
  return out;
}

/** Applies fn to every string reachable without following references; returns the (possibly new) object. */
function transformStrings(obj: PDFObject, fn: (s: PDFString | PDFHexString) => PDFObject): PDFObject {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return fn(obj);
  if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const item = obj.get(i);
      const t = transformStrings(item, fn);
      if (t !== item) obj.set(i, t);
    }
  } else if (obj instanceof PDFDict) {
    for (const [k, v] of obj.entries()) {
      const t = transformStrings(v, fn);
      if (t !== v) obj.set(k, t);
    }
  }
  return obj;
}
