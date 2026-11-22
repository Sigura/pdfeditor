import { z } from 'zod';
import { ColorSchema, RectSchema } from './geometry.ts';
import { AlignSchema } from './model.ts';
import { TableSetupSchema } from './tableMesh.ts';

export const OverflowModeSchema = z.enum(['shrink', 'wrap', 'overflow']);
export type OverflowMode = z.infer<typeof OverflowModeSchema>;

const id = z.string().min(1).max(200);
const finite = z.number().finite();

export const ReplaceTextOp = z.object({
  type: z.literal('replaceText'),
  elementId: id,
  text: z.string().max(100_000),
  overflow: OverflowModeSchema.optional(),
});
export const AddTextBoxOp = z.object({
  type: z.literal('addTextBox'),
  id,
  pageIndex: z.number().int().min(0),
  bbox: RectSchema,
  text: z.string().max(100_000),
  fontSize: finite.positive().max(1000),
  fontFamily: z.string().max(200).optional(),
  color: ColorSchema.optional(),
  background: ColorSchema.nullable().optional(),
});
export const DeleteElementOp = z.object({ type: z.literal('deleteElement'), elementId: id });
export const MoveElementOp = z.object({
  type: z.literal('moveElement'),
  elementId: id,
  dx: finite,
  dy: finite,
  width: finite.positive().optional(),
  height: finite.positive().optional(),
  /** Text boxes only: sets the fill under the text at its new place, like setTextStyle `background`. */
  background: ColorSchema.nullable().optional(),
});
export const TableInsertRowOp = z.object({
  type: z.literal('tableInsertRow'),
  tableId: id,
  index: z.number().int().min(0),
  position: z.enum(['above', 'below']),
});
export const TableDeleteRowOp = z.object({ type: z.literal('tableDeleteRow'), tableId: id, index: z.number().int().min(0) });
export const TableInsertColOp = z.object({
  type: z.literal('tableInsertCol'),
  tableId: id,
  index: z.number().int().min(0),
  position: z.enum(['left', 'right']),
  /** When the wider table would leave the page: 'shrink' narrows the other columns proportionally (the table keeps its width); without it the op is rejected. */
  fit: z.literal('shrink').optional(),
});
export const TableDeleteColOp = z.object({ type: z.literal('tableDeleteCol'), tableId: id, index: z.number().int().min(0) });
export const SetCellTextOp = z.object({
  type: z.literal('setCellText'),
  tableId: id,
  row: z.number().int().min(0),
  col: z.number().int().min(0),
  text: z.string().max(100_000),
  /** Like addTextBox; omitted = the column (or template row) style, else for scanned cells the measured ink and size. `background`: the cell fill, null = none. */
  fontFamily: z.string().max(200).optional(),
  fontSize: finite.positive().max(1000).optional(),
  color: ColorSchema.optional(),
  background: ColorSchema.nullable().optional(),
});
/** Table setup confirmed in the Table tool: redefines a detected table (same id) or defines a new one. Original-page coordinates. */
export const DefineTableOp = TableSetupSchema.extend({
  type: z.literal('defineTable'),
  tableId: id,
  pageIndex: z.number().int().min(0),
});
/** `lineSpacing`: baseline distance as a multiple of the font size. `background`: fill painted under the text, null = none. */
export const SetTextStyleOp = z.object({
  type: z.literal('setTextStyle'),
  elementId: id,
  color: ColorSchema.optional(),
  align: AlignSchema.optional(),
  lineSpacing: finite.min(0.5).max(5).optional(),
  background: ColorSchema.nullable().optional(),
});
export const ResizeTableOp = z.object({
  type: z.literal('resizeTable'),
  tableId: id,
  rowHeights: z.array(finite.positive()).optional(),
  colWidths: z.array(finite.positive()).optional(),
});

/**
 * How the flow continues past the last page: new pages copy the previous page's header/footer bands
 * ('copy') or stay blank ('empty'). Without it, content past the last page's body bottom is reported
 * as an overflow with `needsPage`.
 */
export const SetPageFlowOp = z.object({ type: z.literal('setPageFlow'), newPages: z.enum(['copy', 'empty']) });
/**
 * Ink layout of a scanned page measured in the browser (original-page coordinates): `lines` are the
 * y ranges with ink outside tables, top first; `paper` the background colour. The flow cuts and keeps
 * header/footer bands there.
 */
export const ScanLayoutOp = z.object({
  type: z.literal('scanLayout'),
  pageIndex: z.number().int().min(0),
  lines: z.array(z.object({ y0: finite, y1: finite })).max(2000),
  paper: ColorSchema,
});

export const EditOperationSchema = z.discriminatedUnion('type', [
  ReplaceTextOp,
  AddTextBoxOp,
  DeleteElementOp,
  MoveElementOp,
  TableInsertRowOp,
  TableDeleteRowOp,
  TableInsertColOp,
  TableDeleteColOp,
  SetCellTextOp,
  DefineTableOp,
  ResizeTableOp,
  SetTextStyleOp,
  SetPageFlowOp,
  ScanLayoutOp,
]);
export type EditOperation = z.infer<typeof EditOperationSchema>;

export const EditBatchSchema = z.object({
  ops: z.array(EditOperationSchema).max(10_000),
  mode: z.enum(['append', 'replace']).default('append'),
});
export type EditBatch = z.infer<typeof EditBatchSchema>;

export const FontStrategySchema = z.enum(['original', 'substitute', 'emulated', 'none']);
export type FontStrategy = z.infer<typeof FontStrategySchema>;

export const StrategyReportSchema = z.object({
  elementId: z.string(),
  pageIndex: z.number().int(),
  strategy: FontStrategySchema,
  fontName: z.string(),
  substituteFont: z.string().optional(),
  /** Glyph sources: original font (S1 codes or S3 outlines), S3 compositions, S3 fallback glyphs, S2 substitute glyphs. */
  glyphs: z.object({ original: z.number(), composed: z.number(), fallback: z.number(), substitute: z.number().optional() }),
  warnings: z.array(z.string()),
});
export type StrategyReport = z.infer<typeof StrategyReportSchema>;
