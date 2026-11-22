import { describe, expect, it } from 'vitest';
import { applyPatch, emptyPatch, parseContent } from '../src/content/parser.ts';

const enc = (s: string) => Buffer.from(s, 'latin1');

describe('content stream parser', () => {
  it('tokenizes operands, strings and keeps exact byte ranges', () => {
    const src = 'BT /F1 12 Tf 1 0 0 1 72.5 -.5 Tm (a\\(b\\)\\101\\n) Tj [<0041> -250 (x)] TJ ET % comment\nq 1 0 0 rg Q';
    const { ops } = parseContent(enc(src));
    expect(ops.map((o) => o.op)).toEqual(['BT', 'Tf', 'Tm', 'Tj', 'TJ', 'ET', 'q', 'rg', 'Q']);
    const tj = ops[3]!;
    expect(tj.operands[0]).toMatchObject({ t: 'str' });
    expect(Buffer.from((tj.operands[0] as { v: Uint8Array }).v).toString('latin1')).toBe('a(b)A\n');
    expect(ops[2]!.operands.map((o) => (o as { v: number }).v)).toEqual([1, 0, 0, 1, 72.5, -0.5]);
    for (const op of ops) expect(src.slice(op.start, op.end).endsWith(op.op)).toBe(true);
    const tjArr = ops[4]!.operands[0] as { t: 'arr'; v: { t: string }[] };
    expect(tjArr.v.map((o) => o.t)).toEqual(['str', 'num', 'str']);
  });

  it('skips inline image data containing operator-like bytes', () => {
    const src = 'q BI /W 2 /H 1 /CS /G /BPC 8 ID \x00EI\x01 EI Q';
    const { ops } = parseContent(enc(src));
    expect(ops.map((o) => o.op)).toEqual(['q', 'BI', 'Q']);
    expect(Array.from(ops[1]!.inlineData!)).toEqual([0, 0x45, 0x49, 1]);
  });

  it('patches only touched operators and preserves all other bytes', () => {
    const src = 'BT  /F1 12 Tf\r\n(Hello) Tj   (World) Tj ET';
    const parsed = parseContent(enc(src));
    const patch = emptyPatch();
    patch.replace.set(2, '[-2000] TJ');
    patch.insertAfter.set(4, ['q BT ET Q']);
    const out = Buffer.from(applyPatch(parsed, patch)).toString('latin1');
    expect(out).toBe('BT  /F1 12 Tf\r\n[-2000] TJ   (World) Tj ET\nq BT ET Q');
    expect(Buffer.from(applyPatch(parsed, emptyPatch())).toString('latin1')).toBe(src);
  });
});
