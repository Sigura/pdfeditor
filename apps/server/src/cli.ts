import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { PdfError, mergePdfs, type BlankPage, type CopyPage, type MergeInput } from '@pdf-toolkit/pdf-core';

const USAGE = `Usage:
  pdf-tool merge <input>... -o <out.pdf> [--password <file>=<pw>]...

An input is a file with optional page ranges and rotation, <file>[:<ranges>][@90|@180|@270],
the word "blank" for an empty page the size of the page before it, or "copy" / "copy:<n>" for a copy of the
page before it / of output page n that shares its content, fonts and images (use ./blank or ./copy for such file names).

Examples:
  pdf-tool merge a.pdf b.pdf:1-3 -o out.pdf
  pdf-tool merge scan.pdf@90 blank notes.pdf:2-4@180 -o out.pdf
  pdf-tool merge form.pdf:1 copy copy:1 -o three-forms.pdf
  pdf-tool merge secret.pdf:2- --password secret.pdf=hunter2 -o out.pdf`;

/**
 * Splits "path:ranges@rotate" (both parts optional) at the last colon followed by a valid range spec,
 * so "C:\\x.pdf" still works.
 */
export function splitFileArg(arg: string): { path: string; pages?: string; rotate?: number } {
  const r = /^(.+)@(90|180|270)$/.exec(arg);
  const rest = r ? r[1]! : arg;
  const rotate = r ? Number(r[2]) : undefined;
  const m = /^(.*):([\d\s,\-]+)$/.exec(rest);
  return { ...(m && m[1] ? { path: m[1], pages: m[2] } : { path: rest }), ...(rotate && { rotate }) };
}

class CliError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (cmd !== 'merge') {
    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { output: { type: 'string', short: 'o' }, password: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!values.output || positionals.length === 0) {
    console.error(USAGE);
    return 2;
  }
  const passwords = new Map<string, string>();
  for (const p of values.password ?? []) {
    const i = p.indexOf('=');
    if (i <= 0) throw new CliError(`--password must be <file>=<password>, got "${p}"`);
    passwords.set(p.slice(0, i), p.slice(i + 1));
  }
  const inputPaths = new Set(positionals.map((a) => splitFileArg(a).path));
  for (const file of passwords.keys()) {
    if (!inputPaths.has(file)) throw new CliError(`--password names "${file}", which is not one of the inputs`);
  }
  const inputs: (MergeInput | BlankPage | CopyPage)[] = [];
  for (const arg of positionals) {
    if (arg === 'blank') {
      inputs.push({ blank: true });
      continue;
    }
    const copy = /^copy(?::(\d+))?$/.exec(arg);
    if (copy) {
      if (copy[1] && !Number(copy[1])) throw new PdfError('INVALID_RANGE', 'copy:<n> counts pages from 1');
      inputs.push({ copy: copy[1] ? Number(copy[1]) - 1 : -1 });
      continue;
    }
    const { path, pages, rotate } = splitFileArg(arg);
    const bytes = await readFile(path).catch((e: NodeJS.ErrnoException) => {
      throw new CliError(e.code === 'ENOENT' ? `File not found: ${path}` : e.code === 'EISDIR' ? `Not a file: ${path}` : `Cannot read ${path}: ${e.message}`);
    });
    inputs.push({ file: new Uint8Array(bytes), pages, rotate, password: passwords.get(path), name: path.split(/[\\/]/).pop()?.replace(/\.pdf$/i, '') });
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
      console.error(e instanceof PdfError ? `Error (${e.code}): ${e.message}` : e instanceof CliError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS') ? `Error: ${(e as Error).message}` : e);
      process.exit(1);
    },
  );
}
