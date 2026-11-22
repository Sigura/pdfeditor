import { z } from 'zod';
import { PageModelSchema } from './model.ts';
import { EditOperationSchema, StrategyReportSchema } from './edits.ts';

export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const MergeRangesSchema = z.array(z.string().max(1000).optional());
export const MergeSegmentsSchema = z.array(z.object({ file: z.number().int().min(0), pages: z.string().max(1000).optional() })).max(10_000);
export type MergeSegment = z.infer<typeof MergeSegmentsSchema>[number];

export const DocumentInfoSchema = z.object({
  docId: z.string(),
  fileName: z.string(),
  pageCount: z.number().int(),
  pages: z.array(PageModelSchema),
});
export type DocumentInfo = z.infer<typeof DocumentInfoSchema>;

export const PageOverflowSchema = z.object({ pageIndex: z.number().int(), by: z.number() });
export type PageOverflow = z.infer<typeof PageOverflowSchema>;

export const EditResultSchema = z.object({
  docId: z.string(),
  revision: z.number().int(),
  ops: z.array(EditOperationSchema),
  reports: z.array(StrategyReportSchema),
  warnings: z.array(z.string()),
  /** Pages whose content was pushed past the bottom edge by growing tables, and by how many points. */
  overflows: z.array(PageOverflowSchema),
  pages: z.array(PageModelSchema),
});
export type EditResult = z.infer<typeof EditResultSchema>;
