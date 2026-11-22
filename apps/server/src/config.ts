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
};
