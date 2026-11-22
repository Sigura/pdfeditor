import { describe, expect, it } from 'vitest';
import { parsePageRanges } from '../src/ranges.ts';

describe('parsePageRanges', () => {
  it('parses mixed ranges, open ends and order', () => {
    expect(parsePageRanges('1-3,5,8-', 10)).toEqual([0, 1, 2, 4, 7, 8, 9]);
    expect(parsePageRanges('-2', 5)).toEqual([0, 1]);
    expect(parsePageRanges('4-2', 5)).toEqual([3, 2, 1]);
    expect(parsePageRanges(undefined, 3)).toEqual([0, 1, 2]);
    expect(parsePageRanges(' 2 , 2 ', 3)).toEqual([1, 1]);
  });

  it('rejects malformed and out-of-bounds specs', () => {
    for (const bad of ['0', '11', '1-11', 'a', '1,,2', '-', '1-2-3']) {
      expect(() => parsePageRanges(bad, 10), bad).toThrowError(/range|bounds/i);
    }
  });
});
