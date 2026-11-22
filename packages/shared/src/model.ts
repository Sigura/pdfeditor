import { z } from 'zod';
import { ColorSchema, MatrixSchema, RectSchema } from './geometry.ts';
import { PointSchema, RulingSchema, TablePatternSchema, TableSetupSchema } from './tableMesh.ts';

export const ContentRefSchema = z.object({
  streamId: z.string(),
  opStart: z.number().int(),
  opEnd: z.number().int(),
});
export type ContentRef = z.infer<typeof ContentRefSchema>;

export const TextRunSchema = z.object({
  id: z.string(),
  pageIndex: z.number().int(),
  text: z.string(),
  bbox: RectSchema,
  fontRef: z.string(),
  fontName: z.string(),
  fontSize: z.number(),
  color: ColorSchema,
  matrix: MatrixSchema,
  charSpacing: z.number(),
  wordSpacing: z.number(),
  horizontalScale: z.number(),
  decodable: z.boolean(),
  contentStreamRef: ContentRefSchema,
});
export type TextRun = z.infer<typeof TextRunSchema>;

export const AlignSchema = z.enum(['left', 'center', 'right', 'justify']);
export type Align = z.infer<typeof AlignSchema>;

export const TextBoxSchema = z.object({
  id: z.string(),
  runs: z.array(TextRunSchema),
  bbox: RectSchema,
  lineHeight: z.number(),
  align: AlignSchema,
  text: z.string(),
});
export type TextBox = z.infer<typeof TextBoxSchema>;

export const BorderStyleSchema = z.object({
  width: z.number(),
  color: ColorSchema,
});
export type BorderStyle = z.infer<typeof BorderStyleSchema>;

export const RowSchema = z.object({ index: z.number().int(), y0: z.number(), y1: z.number() });
export const ColSchema = z.object({ index: z.number().int(), x0: z.number(), x1: z.number() });
export type Row = z.infer<typeof RowSchema>;
export type Col = z.infer<typeof ColSchema>;

export const CellSchema = z.object({
  row: z.number().int(),
  col: z.number().int(),
  bbox: RectSchema,
  text: z.string(),
  runIds: z.array(z.string()),
  fill: ColorSchema.nullable(),
  /** Merged cells (defineTable): the anchor cell has the spans and the merged bbox; the cells it covers are `covered`. */
  rowSpan: z.number().int().optional(),
  colSpan: z.number().int().optional(),
  covered: z.boolean().optional(),
  /** Boxes of the cell's text runs (content preview in the table setup). */
  runBoxes: z.array(RectSchema).optional(),
  /** Images in the cell (original size, only ever translated) and the smallest cell size that still holds them with their padding. */
  images: z.array(RectSchema).optional(),
  minSize: z.object({ width: z.number(), height: z.number() }).optional(),
});
export type Cell = z.infer<typeof CellSchema>;

export const TableSchema = z.object({
  id: z.string(),
  pageIndex: z.number().int(),
  bbox: RectSchema,
  rows: z.array(RowSchema),
  cols: z.array(ColSchema),
  cells: z.array(CellSchema),
  borderStyle: BorderStyleSchema.nullable(),
  bordered: z.boolean(),
  confidence: z.number(),
  /** The confirmed setup (defineTable), when there is one. */
  setup: TableSetupSchema.optional(),
  /** Border look cut from the original (vector tables with drawn borders); regeneration draws from it. */
  pattern: TablePatternSchema.optional(),
});
export type Table = z.infer<typeof TableSchema>;

/** Painted area that can sit behind text, in paint order. `color` null: image or a colour space we can't convert (use pixels). */
export const BackgroundSchema = z.object({ bbox: RectSchema, color: ColorSchema.nullable() });
export type Background = z.infer<typeof BackgroundSchema>;

export const PageModelSchema = z.object({
  pageIndex: z.number().int(),
  width: z.number(),
  height: z.number(),
  rotate: z.number().int(),
  view: RectSchema,
  textBoxes: z.array(TextBoxSchema),
  tables: z.array(TableSchema),
  backgrounds: z.array(BackgroundSchema),
  /** Drawn border segments and their intersections (cell-corner snap targets for the table setup). */
  rulings: z.array(RulingSchema),
  junctions: z.array(PointSchema),
  editable: z.boolean(),
  warnings: z.array(z.string()),
  /** Areas holding content continued from earlier pages (their elements keep their ids). */
  flowIn: z.array(RectSchema).optional(),
  /** Where the content in flowIn comes from: page `src`, its band y0..y1 (this page's coordinates) drawn shifted by `dy`. */
  flowFrom: z.array(z.object({ src: z.number().int(), y0: z.number(), y1: z.number(), dy: z.number() })).optional(),
  /** Page added by the flow after the last original page. */
  added: z.boolean().optional(),
});
export type PageModel = z.infer<typeof PageModelSchema>;
