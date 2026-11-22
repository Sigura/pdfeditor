import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 3001),
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(import.meta.dirname, '..', 'data')),
  maxFileBytes: num(process.env.MAX_FILE_MB, 50) * 1024 * 1024,
  maxFiles: num(process.env.MAX_FILES, 20),
  ttlMs: num(process.env.DOC_TTL_MIN, 60) * 60 * 1000,
  fontsDir: path.resolve(process.env.FONTS_DIR ?? path.join(import.meta.dirname, '..', '..', '..', 'fonts')),
  systemFonts: process.env.SYSTEM_FONTS !== '0',
  bundledFonts: process.env.BUNDLED_FONTS === '0' ? [] : bundledFontDirs(),
};

/** The @expo-google-fonts/* dependencies: one full TTF per weight and style, with LICENSE_FONT. */
function bundledFontDirs(): string[] {
  const pkg = path.join(import.meta.dirname, '..', 'package.json');
  const deps = Object.keys((JSON.parse(readFileSync(pkg, 'utf8')) as { dependencies: Record<string, string> }).dependencies);
  const require = createRequire(pkg);
  return deps.filter((d) => d.startsWith('@expo-google-fonts/')).map((d) => path.dirname(require.resolve(`${d}/package.json`)));
}
