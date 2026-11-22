import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { PdfError, mergePdfs, type MergeInput } from '@pdf-toolkit/pdf-core';

const USAGE = `Usage:
  pdf-tool merge <file[:ranges]>... -o <out.pdf> [--password <file>=<pw>]...

Examples:
  pdf-tool merge a.pdf b.pdf:1-3 -o out.pdf
  pdf-tool merge secret.pdf:2- --password secret.pdf=hunter2 -o out.pdf`;

/** Splits "path:ranges" at the last colon followed by a valid range spec, so "C:\\x.pdf" still works. */
export function splitFileArg(arg: string): { path: string; pages?: string } {
  const m = /^(.*):([\d\s,\-]+)$/.exec(arg);
  return m && m[1] ? { path: m[1], pages: m[2] } : { path: arg };
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== 'merge') {
    console.error(USAGE);
    return cmd === undefined || cmd === '--help' ? 0 : 2;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { output: { type: 'string', short: 'o' }, password: { type: 'string', multiple: true } },
  });
  if (!values.output || positionals.length === 0) {
    console.error(USAGE);
    return 2;
  }
  const passwords = new Map<string, string>();
  for (const p of values.password ?? []) {
    const i = p.indexOf('=');
    if (i > 0) passwords.set(p.slice(0, i), p.slice(i + 1));
  }
  const inputs: MergeInput[] = [];
  for (const arg of positionals) {
    const { path, pages } = splitFileArg(arg);
    inputs.push({ file: new Uint8Array(await readFile(path)), pages, password: passwords.get(path), name: path.split(/[\\/]/).pop()?.replace(/\.pdf$/i, '') });
  }
  const out = await mergePdfs(inputs);
  await writeFile(values.output, out);
  console.log(`Wrote ${values.output} (${out.length} bytes)`);
  return 0;
}

if (process.argv[1] && /cli\.ts$|pdf-tool(\.mjs)?$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof PdfError ? `Error (${e.code}): ${e.message}` : e);
      process.exit(1);
    },
  );
}
