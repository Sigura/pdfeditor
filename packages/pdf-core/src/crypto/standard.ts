import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFString,
} from 'pdf-lib';
import { PdfError } from '../errors.ts';

const PASSWORD_PADDING = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

export type CipherMethod = 'none' | 'rc4' | 'aes128' | 'aes256';

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff;
    const t = s[i]!;
    s[i] = s[j]!;
    s[j] = t;
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 0xff;
    b = (b + s[a]!) & 0xff;
    const t = s[a]!;
    s[a] = s[b]!;
    s[b] = t;
    out[k] = data[k]! ^ s[(s[a]! + s[b]!) & 0xff]!;
  }
  return out;
}

const md5 = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash('md5');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

const sha = (alg: 'sha256' | 'sha384' | 'sha512', ...parts: Uint8Array[]): Uint8Array => {
  const h = createHash(alg);
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export function aesDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 16) return new Uint8Array(0);
  const iv = data.subarray(0, 16);
  const body = data.subarray(16);
  const alg = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
  // PDF writers in the wild produce bad padding; decrypt raw and strip valid PKCS#7 padding only.
  const d = createDecipheriv(alg, key, iv);
  d.setAutoPadding(false);
  const usable = body.subarray(0, body.length - (body.length % 16));
  const out = new Uint8Array(Buffer.concat([d.update(usable), d.final()]));
  const pad = out[out.length - 1] ?? 0;
  if (pad >= 1 && pad <= 16 && out.length >= pad && out.subarray(out.length - pad).every((v) => v === pad)) {
    return out.subarray(0, out.length - pad);
  }
  return out;
}

export function aesEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array, pad = true): Uint8Array {
  const alg = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
  const c = createCipheriv(alg, key, iv);
  c.setAutoPadding(pad);
  return new Uint8Array(Buffer.concat([c.update(data), c.final()]));
}

function padPassword(pw: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  const n = Math.min(32, pw.length);
  out.set(pw.subarray(0, n));
  out.set(PASSWORD_PADDING.subarray(0, 32 - n), n);
  return out;
}

const le32 = (v: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, true);
  return b;
};

export type EncryptParams = {
  v: number;
  r: number;
  lengthBytes: number;
  o: Uint8Array;
  u: Uint8Array;
  oe?: Uint8Array;
  ue?: Uint8Array;
  p: number;
  id0: Uint8Array;
  encryptMetadata: boolean;
  stmMethod: CipherMethod;
  strMethod: CipherMethod;
};

/** Algorithm 2 (R2–R4). */
export function computeLegacyKey(params: EncryptParams, password: Uint8Array): Uint8Array {
  const parts = [padPassword(password), params.o, le32(params.p), params.id0];
  if (params.r >= 4 && !params.encryptMetadata) parts.push(Uint8Array.from([0xff, 0xff, 0xff, 0xff]));
  let h = md5(...parts);
  const n = params.r === 2 ? 5 : params.lengthBytes;
  if (params.r >= 3) {
    for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  }
  return h.subarray(0, n);
}

/** Algorithms 4/5: the U value for a given key. */
export function computeLegacyU(params: EncryptParams, key: Uint8Array): Uint8Array {
  if (params.r === 2) return rc4(key, PASSWORD_PADDING);
  let x = rc4(key, md5(PASSWORD_PADDING, params.id0));
  for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
  return concat(x, new Uint8Array(16));
}

/** Algorithm 3: the O value (also used to recover the user password from the owner password). */
function ownerRc4Key(params: EncryptParams, ownerPassword: Uint8Array): Uint8Array {
  let h = md5(padPassword(ownerPassword));
  if (params.r >= 3) for (let i = 0; i < 50; i++) h = md5(h);
  return h.subarray(0, params.r === 2 ? 5 : params.lengthBytes);
}

export function computeLegacyO(params: Omit<EncryptParams, 'o'>, ownerPassword: Uint8Array, userPassword: Uint8Array): Uint8Array {
  const key = ownerRc4Key({ ...params, o: new Uint8Array(0) }, ownerPassword);
  let x = rc4(key, padPassword(userPassword));
  if (params.r >= 3) for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
  return x;
}

function checkLegacyUser(params: EncryptParams, password: Uint8Array): Uint8Array | null {
  const key = computeLegacyKey(params, password);
  const u = computeLegacyU(params, key);
  const cmpLen = params.r === 2 ? 32 : 16;
  return equalBytes(u.subarray(0, cmpLen), params.u.subarray(0, cmpLen)) ? key : null;
}

function checkLegacyOwner(params: EncryptParams, password: Uint8Array): Uint8Array | null {
  const key = ownerRc4Key(params, password);
  let x = params.o.subarray(0, 32);
  if (params.r === 2) x = rc4(key, x);
  else for (let i = 19; i >= 0; i--) x = rc4(key.map((b) => b ^ i), x);
  return checkLegacyUser(params, x);
}

/** Algorithm 2.B (R6); R5 uses a single SHA-256. */
export function hashR6(password: Uint8Array, salt: Uint8Array, udata: Uint8Array, r: number): Uint8Array {
  let k = sha('sha256', password, salt, udata);
  if (r === 5) return k;
  for (let i = 0; ; i++) {
    const k1 = concat(password, k, udata);
    const block = new Uint8Array(k1.length * 64);
    for (let j = 0; j < 64; j++) block.set(k1, j * k1.length);
    const e = aesEncrypt(k.subarray(0, 16), k.subarray(16, 32), block, false);
    let mod = 0;
    for (let j = 0; j < 16; j++) mod += e[j]!;
    mod %= 3;
    k = sha(mod === 0 ? 'sha256' : mod === 1 ? 'sha384' : 'sha512', e);
    if (i >= 63 && e[e.length - 1]! <= i - 32) break;
  }
  return k.subarray(0, 32);
}

function checkAes256(params: EncryptParams, password: Uint8Array): Uint8Array | null {
  const pw = password.subarray(0, 127);
  const zeroIv = new Uint8Array(16);
  const u48 = params.u.subarray(0, 48);
  const decryptKey = (wrapped: Uint8Array | undefined, k: Uint8Array): Uint8Array | null => {
    if (!wrapped || wrapped.length < 32) return null;
    const d = createDecipheriv('aes-256-cbc', k, zeroIv);
    d.setAutoPadding(false);
    return new Uint8Array(Buffer.concat([d.update(wrapped.subarray(0, 32)), d.final()]));
  };
  if (equalBytes(hashR6(pw, params.o.subarray(32, 40), u48, params.r), params.o.subarray(0, 32))) {
    return decryptKey(params.oe, hashR6(pw, params.o.subarray(40, 48), u48, params.r));
  }
  if (equalBytes(hashR6(pw, params.u.subarray(32, 40), new Uint8Array(0), params.r), params.u.subarray(0, 32))) {
    return decryptKey(params.ue, hashR6(pw, params.u.subarray(40, 48), new Uint8Array(0), params.r));
  }
  return null;
}

const bytesOf = (obj: PDFObject | undefined): Uint8Array | undefined => {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.asBytes();
  return undefined;
};

function methodFromCfm(cfm: PDFObject | undefined, v: number): CipherMethod {
  if (!(cfm instanceof PDFName)) return 'none';
  switch (cfm.decodeText()) {
    case 'V2':
      return 'rc4';
    case 'AESV2':
      return 'aes128';
    case 'AESV3':
      return 'aes256';
    case 'None':
      return 'none';
    default:
      throw new PdfError('UNSUPPORTED_ENCRYPTION', `Unsupported crypt filter method ${cfm.decodeText()} (V${v})`);
  }
}

export function readEncryptParams(encrypt: PDFDict, idArray: PDFArray | undefined): EncryptParams {
  const filter = encrypt.lookup(PDFName.of('Filter'));
  if (!(filter instanceof PDFName) || filter.decodeText() !== 'Standard') {
    const name = filter instanceof PDFName ? filter.decodeText() : 'unknown';
    throw new PdfError('UNSUPPORTED_ENCRYPTION', `Unsupported security handler "${name}" (only the standard password handler is supported)`);
  }
  const num = (key: string, dflt: number): number => {
    const v = encrypt.lookup(PDFName.of(key));
    return v instanceof PDFNumber ? v.asNumber() : dflt;
  };
  const v = num('V', 0);
  const r = num('R', 2);
  const o = bytesOf(encrypt.lookup(PDFName.of('O')));
  const u = bytesOf(encrypt.lookup(PDFName.of('U')));
  if (!o || !u) throw new PdfError('INVALID_PDF', 'Encrypt dictionary lacks /O or /U');
  const em = encrypt.lookup(PDFName.of('EncryptMetadata'));
  const id0 = idArray ? (bytesOf(idArray.lookup(0)) ?? new Uint8Array(0)) : new Uint8Array(0);
  let stmMethod: CipherMethod = 'rc4';
  let strMethod: CipherMethod = 'rc4';
  let lengthBytes = v === 1 ? 5 : num('Length', 40) / 8;
  if (v === 4 || v === 5) {
    const cf = encrypt.lookup(PDFName.of('CF'));
    const resolve = (key: string): CipherMethod => {
      const name = encrypt.lookup(PDFName.of(key));
      const n = name instanceof PDFName ? name.decodeText() : 'Identity';
      if (n === 'Identity') return 'none';
      const filterDict = cf instanceof PDFDict ? cf.lookup(PDFName.of(n)) : undefined;
      if (!(filterDict instanceof PDFDict)) throw new PdfError('INVALID_PDF', `Crypt filter ${n} not found`);
      const len = filterDict.lookup(PDFName.of('Length'));
      if (len instanceof PDFNumber && v === 4) lengthBytes = len.asNumber() > 32 ? len.asNumber() / 8 : len.asNumber();
      return methodFromCfm(filterDict.lookup(PDFName.of('CFM')), v);
    };
    stmMethod = resolve('StmF');
    strMethod = resolve('StrF');
    if (v === 5) lengthBytes = 32;
  } else if (v !== 1 && v !== 2) {
    throw new PdfError('UNSUPPORTED_ENCRYPTION', `Unsupported encryption version V${v}`);
  }
  if (lengthBytes < 5 || lengthBytes > 32) lengthBytes = 16;
  return {
    v,
    r,
    lengthBytes,
    o,
    u,
    oe: bytesOf(encrypt.lookup(PDFName.of('OE'))),
    ue: bytesOf(encrypt.lookup(PDFName.of('UE'))),
    p: num('P', 0) | 0,
    id0,
    encryptMetadata: !(em instanceof PDFBool) || em.asBoolean(),
    stmMethod,
    strMethod,
  };
}

export class StandardDecryptor {
  readonly params: EncryptParams;
  private readonly fileKey: Uint8Array;

  private constructor(params: EncryptParams, fileKey: Uint8Array) {
    this.params = params;
    this.fileKey = fileKey;
  }

  /** Tries the password as user then owner password. Returns null when it doesn't match. */
  static open(params: EncryptParams, password: string): StandardDecryptor | null {
    const pw =
      params.r >= 5 ? new TextEncoder().encode(password.normalize('NFKC')) : Uint8Array.from(Buffer.from(password, 'latin1'));
    const key = params.r >= 5 ? checkAes256(params, pw) : (checkLegacyUser(params, pw) ?? checkLegacyOwner(params, pw));
    return key ? new StandardDecryptor(params, key) : null;
  }

  private objectKey(objNum: number, gen: number, method: CipherMethod): Uint8Array {
    if (method === 'aes256') return this.fileKey;
    const extra = Uint8Array.from([objNum & 0xff, (objNum >> 8) & 0xff, (objNum >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]);
    const salt = method === 'aes128' ? Uint8Array.from([0x73, 0x41, 0x6c, 0x54]) : new Uint8Array(0);
    return md5(this.fileKey, extra, salt).subarray(0, Math.min(this.fileKey.length + 5, 16));
  }

  private run(method: CipherMethod, objNum: number, gen: number, data: Uint8Array): Uint8Array {
    if (method === 'none') return data;
    const key = this.objectKey(objNum, gen, method);
    return method === 'rc4' ? rc4(key, data) : aesDecrypt(key, data);
  }

  decryptString(objNum: number, gen: number, data: Uint8Array): Uint8Array {
    return this.run(this.params.strMethod, objNum, gen, data);
  }

  decryptStream(objNum: number, gen: number, data: Uint8Array): Uint8Array {
    return this.run(this.params.stmMethod, objNum, gen, data);
  }
}
