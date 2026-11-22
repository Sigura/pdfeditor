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
