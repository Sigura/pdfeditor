/** Sorts names as people read them: "file2" before "file10", "file02" next to "file2", case ignored. */
export const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

/** Files of dropped items, folders read recursively, with their paths ("folder/sub/a.pdf"). Call it in the drop event, before any await. */
export function droppedFiles(items: DataTransferItemList): Promise<{ file: File; path: string; inFolder: boolean }[]> {
  const entries = Array.from(items, (i) => i.webkitGetAsEntry()).filter((e): e is FileSystemEntry => !!e);
  const walk = async (entry: FileSystemEntry, inFolder: boolean): Promise<{ file: File; path: string; inFolder: boolean }[]> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      return [{ file, path: entry.fullPath.replace(/^\//, ''), inFolder }];
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const all: FileSystemEntry[] = [];
    // readEntries returns at most 100 entries per call.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      all.push(...batch);
    }
    return (await Promise.all(all.map((e) => walk(e, true)))).flat();
  };
  return Promise.all(entries.map((e) => walk(e, false))).then((l) => l.flat());
}

export const isZip = (f: File) => /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed';

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The files in a zip archive whose names `keep` accepts, in natural order of their paths. Stored and
 * deflated entries only; Zip64 and encrypted entries are rejected.
 */
export async function readZip(bytes: Uint8Array, keep: (name: string) => boolean): Promise<{ name: string; bytes: Uint8Array }[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  // The end record is 22 bytes plus a comment of at most 65535 bytes.
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error('Zip64 archives are not supported');
  const entries: { name: string; method: number; flags: number; size: number; offset: number }[] = [];
  const utf8 = new TextDecoder();
  const cp437 = new TextDecoder('latin1');
  for (let k = 0; k < count; k++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new Error('damaged zip directory');
    const flags = view.getUint16(p + 8, true);
    const nameLen = view.getUint16(p + 28, true);
    const raw = bytes.subarray(p + 46, p + 46 + nameLen);
    entries.push({
      name: (flags & 0x800 ? utf8 : cp437).decode(raw),
      method: view.getUint16(p + 10, true),
      flags,
      size: view.getUint32(p + 20, true),
      offset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  const wanted = entries.filter((e) => !e.name.endsWith('/') && !e.name.startsWith('__MACOSX/') && keep(e.name)).sort((a, b) => naturalCompare(a.name, b.name));
  const out: { name: string; bytes: Uint8Array }[] = [];
  for (const e of wanted) {
    if (e.flags & 1) throw new Error(`${e.name} is encrypted`);
    if (view.getUint32(e.offset, true) !== 0x04034b50) throw new Error(`damaged entry ${e.name}`);
    const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
    const data = bytes.subarray(start, start + e.size);
    if (e.method === 0) out.push({ name: e.name, bytes: data.slice() });
    else if (e.method === 8) out.push({ name: e.name, bytes: await inflateRaw(data) });
    else throw new Error(`${e.name} uses an unsupported compression method (${e.method})`);
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive of `files`, stored without compression (PDFs are compressed already); names are UTF-8. */
export function writeZip(files: { name: string; bytes: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.bytes);
    if (f.bytes.length >= 0xffffffff || offset >= 0xffffffff) throw new Error('The export is too large for a zip file (4 GB)');
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.bytes.length, true);
    lv.setUint32(22, f.bytes.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x800, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, f.bytes.length, true);
    dv.setUint32(24, f.bytes.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, offset, true);
    dir.set(name, 46);
    parts.push(local, f.bytes);
    central.push(dir);
    offset += local.length + f.bytes.length;
  }
  const size = central.reduce((n, d) => n + d.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end].map((p) => p.slice()), { type: 'application/zip' });
}

/** `name`, or "name (2).ext" and so on when it is taken already. */
export function uniqueName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let out = name;
  for (let n = 2; used.has(out.toLowerCase()); n++) out = `${base} (${n})${ext}`;
  used.add(out.toLowerCase());
  return out;
}
