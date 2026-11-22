import { z } from 'zod';

export const RectSchema = z.object({
  x0: z.number(),
  y0: z.number(),
  x1: z.number(),
  y1: z.number(),
});
export type Rect = z.infer<typeof RectSchema>;

export const MatrixSchema = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]);
export type Matrix = z.infer<typeof MatrixSchema>;

export const ColorSchema = z.object({
  space: z.enum(['gray', 'rgb', 'cmyk', 'other']),
  values: z.array(z.number()),
});
export type Color = z.infer<typeof ColorSchema>;
