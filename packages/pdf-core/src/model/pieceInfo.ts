import { PDFDict, PDFStream, PDFString, type PDFDocument, type PDFPage } from 'pdf-lib';
import { StoredTablesSchema, type StoredTable } from '@pdf-toolkit/shared';
import { N, getDict, streamBytes } from '../pdf/util.ts';

/** Our key in the page's /PieceInfo (app-private data, ISO 32000 §14.5). */
const APP = 'PDFToolkit';

/** Table models saved in the page's /PieceInfo, or a warning when the data is there but unreadable. */
export function readStoredTables(page: PDFPage): { tables: StoredTable[]; warning?: string } {
  const priv = getDict(getDict(page.node, 'PieceInfo'), APP)?.lookup(N('Private'));
  if (!priv) return { tables: [] };
  if (!(priv instanceof PDFStream)) return { tables: [], warning: 'Stored table model (/PieceInfo) is not a stream; ignored' };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(streamBytes(priv)));
  } catch (e) {
    return { tables: [], warning: `Stored table model (/PieceInfo) is not valid JSON (${(e as Error).message}); ignored` };
  }
  const parsed = StoredTablesSchema.safeParse(json);
  if (!parsed.success) return { tables: [], warning: `Stored table model (/PieceInfo) has an unknown shape; ignored` };
  return { tables: parsed.data.tables };
}

const pdfDate = (d: Date) => `D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;

/** Writes (or with an empty list, removes) the page's table models. /LastModified is required next to /PieceInfo data. */
export function writeStoredTables(doc: PDFDocument, page: PDFPage, tables: StoredTable[]): void {
  const pieceInfo = getDict(page.node, 'PieceInfo');
  if (!tables.length) {
    pieceInfo?.delete(N(APP));
    if (pieceInfo && pieceInfo.keys().length === 0) page.node.delete(N('PieceInfo'));
    return;
  }
  const now = PDFString.of(pdfDate(new Date()));
  const stream = doc.context.flateStream(JSON.stringify({ version: 1, tables }));
  const data = doc.context.obj({}) as PDFDict;
  data.set(N('LastModified'), now);
  data.set(N('Private'), doc.context.register(stream));
  const target = pieceInfo ?? (doc.context.obj({}) as PDFDict);
  target.set(N(APP), data);
  if (!pieceInfo) page.node.set(N('PieceInfo'), target);
  page.node.set(N('LastModified'), now);
}
