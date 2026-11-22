import pdfLibFontkit from '@pdf-lib/fontkit';
import { createHash } from 'node:crypto';
import { PDFArray, PDFDict, PDFName, PDFStream, type PDFDocument, type PDFFont } from 'pdf-lib';
import type { Color, EditOperation, EditResult, Matrix, PageModel, PageOverflow, Rect, StrategyReport, TextBox } from '@pdf-toolkit/shared';
import { faceCovers, findFallback, findSubstitute, loadFace, parseFontName, type FontRequest, type LoadedFace } from '../fonts/lookup.ts';
import type { BoxInternal } from '../model/group.ts';
import { applyPatch, emptyPatch, serializeOp, type StreamPatch } from '../content/parser.ts';
import { loadPdf } from '../load.ts';
import { analyzeDocument, type PageAnalysis } from '../model/extract.ts';
import type { ImageItem, PathItem, RunInternal, StreamInfo } from '../model/interpreter.ts';
import { snapshotObjects, writeIncremental } from '../save/incremental.ts';
import { encodeForFont, type EncodedItem } from './coverage.ts';
import { Emulator, fontRequest } from './emulate.ts';
import { layoutBox, originalEncoding, type BoxEncoding, type BoxLayout, type LayoutStyle } from './layout.ts';
import { tableDefinitions, reduceEdits, reflowBelow, type AddedBox } from './reduce.ts';
import { backgroundFill, colorOp, num, shiftRect, translateIn, union } from './ops.ts';
import { tableDrawer } from './tableDraw.ts';
import { writeStoredTables } from '../model/pieceInfo.ts';
import { headerRowsOf } from '../model/tablePattern.ts';
import { flowModels, planFlow, writeFlow, type FlowPage, type FlowUnit } from './paging.ts';

export type ApplyResult = {
  bytes: Uint8Array;
  reports: StrategyReport[];
  warnings: string[];
  /** Page models of the original with the edits applied (element IDs stay those of the original). */
  pages: PageModel[];
  /** Pages whose content was pushed past the bottom edge (growing tables, moves), by how many points. */
  overflows: PageOverflow[];
  continuations: EditResult['continuations'];
};

/** "Page 2", "2", "- 2 -", "2 of 5", "p. 2/5": text that a copied header/footer would repeat wrongly. */
const PAGE_NUMBER = /^(?:(?:page|p\.|pg\.?|seite|página|pagina|стр\.?|страница)\s*)?[-–—]?\s*\d{1,4}\s*[-–—]?(?:\s*(?:of|von|de|из|\/)\s*\d{1,4})?$/i;

/**
 * Replaces a show operator with one that has the same text-space advance and draws nothing, so
 * later text on the line keeps its position and the old glyphs are gone from the stream.
 */
export function removalOp(run: RunInternal): string {
  const k = run.state.size * run.state.hScale;
  const n = k === 0 ? 0 : (-run.advance * 1000) / k;
  const tj = serializeOp('TJ', [{ t: 'arr', v: [{ t: 'num', v: Math.round(n * 1000) / 1000 }] }]);
  const a = run.op.operands;
  if (run.op.op === "'") return `T* ${tj}`;
  if (run.op.op === '"') return `${serializeOp('Tw', a.slice(0, 1))} ${serializeOp('Tc', a.slice(1, 2))} T* ${tj}`;
  return tj;
}

function writeStream(doc: PDFDocument, pageIndex: number, info: StreamInfo, bytes: Uint8Array): void {
  const ctx = doc.context;
  const stream = ctx.flateStream(bytes);
  if (info.ref) {
    const orig = ctx.lookup(info.ref, PDFStream);
    for (const [k, v] of orig.dict.entries()) {
      if (!['Length', 'Filter', 'DecodeParms'].includes(k.decodeText())) stream.dict.set(k, v);
    }
    ctx.assign(info.ref, stream);
  } else {
    doc.getPage(pageIndex).node.set(PDFName.of('Contents'), ctx.register(stream));
  }
}

/** Embeds substitute / text-layer fonts once per document (subset Type0/Identity-H + ToUnicode). */
class FontEmbedder {
  private readonly fonts = new Map<string, PDFFont>();
  private readonly used = new Map<PDFFont, Set<string>>();
  private readonly keys = new Map<string, string>();
  constructor(private readonly doc: PDFDocument) {
    doc.registerFontkit(pdfLibFontkit);
  }

  async embed(face: LoadedFace): Promise<PDFFont> {
    let f = this.fonts.get(face.file);
    if (!f) {
      f = await this.doc.embedFont(face.bytes, { subset: true });
      this.fonts.set(face.file, f);
    }
    return f;
  }

  glyph(font: PDFFont, ch: string): { bytes: number[]; width: number } {
    const used = this.used.get(font) ?? new Set<string>();
    used.add(ch);
    this.used.set(font, used);
    return { bytes: [...font.encodeText(ch).asBytes()], width: font.widthOfTextAtSize(ch, 1000) };
  }

  /**
   * pdf-lib names subsets "Name-1234" with a random suffix. Rename them to the standard
   * "ABCDEF+Name" tag, derived from the glyphs used so the output stays deterministic.
   */
  finalize(): void {
    for (const [, font] of this.fonts) {
      const type0 = this.doc.context.lookup(font.ref, PDFDict);
      const cid = type0.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
      const desc = cid.lookup(PDFName.of('FontDescriptor'), PDFDict);
      const ps = font.name.replace(/-\d+$/, '');
      const digest = createHash('sha256').update(ps).update([...(this.used.get(font) ?? [])].sort().join('')).digest();
      const tag = [...digest.subarray(0, 6)].map((b) => String.fromCharCode(65 + (b % 26))).join('');
      const name = PDFName.of(`${tag}+${ps}`);
      type0.set(PDFName.of('BaseFont'), name);
      cid.set(PDFName.of('BaseFont'), name);
      desc.set(PDFName.of('FontName'), name);
    }
  }

  /** Resource name of `font` in the resources of `info` (added under a free /TKn name). */
  resourceKey(pageIndex: number, info: StreamInfo, font: PDFFont): string {
    const id = `${info.id}|${font.ref.toString()}`;
    const known = this.keys.get(id);
    if (known) return known;
    const ctx = this.doc.context;
    let res = info.resources;
    if (!res) {
      res = ctx.obj({});
      if (info.ref) ctx.lookup(info.ref, PDFStream).dict.set(PDFName.of('Resources'), res);
      else this.doc.getPage(pageIndex).node.set(PDFName.of('Resources'), res);
      info.resources = res;
    }
    let fonts = res.lookup(PDFName.of('Font'));
    if (!(fonts instanceof PDFDict)) {
      fonts = ctx.obj({});
      res.set(PDFName.of('Font'), fonts);
    }
    const dict = fonts as PDFDict;
    let n = 1;
    while (dict.has(PDFName.of(`TK${n}`))) n++;
    dict.set(PDFName.of(`TK${n}`), font.ref);
    this.keys.set(id, `TK${n}`);
    return `TK${n}`;
  }
}

/** Debug/comparison: skip S1 and use only this source (characters it can't draw fall back to S1). */
export type ForceStrategy = 'substitute' | 'outline' | 'compose' | 'fallback';

type Chosen = { layout: BoxLayout; strategy: StrategyReport['strategy']; substituteFont?: string; warnings: string[] };

/** S1 → S2 → S3 for one box (see ARCHITECTURE.md, font-strategy decision flow). */
async function chooseStrategy(a: PageAnalysis, box: BoxInternal, text: string, overflow: Parameters<typeof layoutBox>[2], fonts: FontEmbedder, force?: ForceStrategy, wrapWidth?: number, style?: LayoutStyle): Promise<Chosen> {
  const s1 = layoutBox(box, text, overflow, originalEncoding(box), wrapWidth, style);
  if (!force && !s1.missing.length && !s1.reason) return { layout: s1, strategy: 'original', warnings: [] };
  const r0 = box.runs[0]!;
  const font = r0.font;
  const info = a.interp.streams.get(r0.streamId)!;
  const why = force ? `strategy forced to ${force}` : s1.missing.length ? `characters not in the original font: ${s1.missing.join(' ')}` : `the original font can't be used: ${s1.reason}`;
  if (font.vertical) return { layout: s1, strategy: 'none', warnings: [`Vertical writing is not editable`] };
  const nfc = text.normalize('NFC');
  const req = fontRequest(font);

  if (!font.isType3 && (!force || force === 'substitute')) {
    const hit = findSubstitute(req);
    const face = hit ? loadFace(hit.face) : undefined;
    if (face && faceCovers(face, nfc.replace(/\n/g, ''))) {
      const pdfFont = await fonts.embed(face);
      const key = fonts.resourceKey(a.pageIndex, info, pdfFont);
      const enc: BoxEncoding = {
        fontKeys: [r0.state.fontKey, key],
        encode: (p) => ({
          items: [...p.normalize('NFC')].map((ch): EncodedItem => {
            const g = fonts.glyph(pdfFont, ch);
            return { kind: 'glyph', ch, code: -1, bytes: g.bytes, width: g.width, isWordSpace: false, font: 1, wordSpace: ch === ' ' && !font.isType0 };
          }),
          missing: [],
        }),
      };
      const layout = layoutBox(box, nfc, overflow, enc, wrapWidth, style);
      return { layout, strategy: 'substitute', substituteFont: face.postscriptName, warnings: [`S2: ${why}; substituted ${face.postscriptName} (${hit!.how} match)`] };
    }
  }

  if (force === 'substitute') return { layout: s1, strategy: 'none', warnings: ['No substitute font covers the text'] };
  const emu = new Emulator(font);
  const enc: BoxEncoding = {
    fontKeys: [r0.state.fontKey],
    encode: (p) => {
      if (!force) return encodeForFont(font, p.normalize('NFC'), (ch) => emu.emulate(ch));
      const parts = [...p.normalize('NFC')].map((ch) => (ch === ' ' ? null : emu.forced(ch, force)) ?? encodeForFont(font, ch, (c) => emu.emulate(c)));
      return { items: parts.flatMap((r) => ('items' in r ? r.items : [r])), missing: parts.flatMap((r) => ('missing' in r ? r.missing : [])) };
    },
  };
  const probe = layoutBox(box, nfc, overflow, enc, wrapWidth, style);
  if (probe.missing.length || probe.reason) {
    const w = probe.missing.length ? `NO_GLYPH_SOURCE: no glyph source for ${probe.missing.join(' ')}` : `NO_GLYPH_SOURCE: ${probe.reason}`;
    return { layout: probe, strategy: 'none', warnings: [`${w}; the box was left unchanged`] };
  }
  const layerChars = new Set<string>();
  for (const p of nfc.split('\n')) {
    for (const it of enc.encode(p).items) if (it.kind === 'emulated' && it.parts.every((q) => q.kind === 'path')) layerChars.add(it.ch);
  }
  const warnings = [`S3: ${why}`];
  if (layerChars.size) {
    const layerFace = findFallback(emu.request, [...layerChars].join(''));
    if (layerFace) {
      const pdfFont = await fonts.embed(layerFace);
      enc.fontKeys.push(fonts.resourceKey(a.pageIndex, info, pdfFont));
      enc.layer = { font: 1, glyph: (ch) => fonts.glyph(pdfFont, ch) };
    } else warnings.push('No Unicode font covers the emulated characters, so they have no invisible text layer');
  }
  const layout = layoutBox(box, nfc, overflow, enc, wrapWidth, style);
  const used = [...emu.fallbackFaces];
  return { layout, strategy: 'emulated', substituteFont: used.length ? used.join(', ') : undefined, warnings };
}


function pathBox(p: PathItem): Rect | null {
  const rs = [...p.rects, ...p.segments.map((s) => ({ x0: Math.min(s.x0, s.x1), y0: Math.min(s.y0, s.y1), x1: Math.max(s.x0, s.x1), y1: Math.max(s.y0, s.y1) }))];
  if (!rs.length) return null;
  const half = p.paint === 'fill' ? 0 : p.lineWidth / 2;
  const u = union(rs);
  return { x0: u.x0 - half, y0: u.y0 - half, x1: u.x1 + half, y1: u.y1 + half };
}

function familyRequest(family: string): FontRequest {
  const p = parseFontName(family);
  return { name: family, bold: p.bold, italic: p.italic, serif: /serif|times|roman|georgia|cambria/i.test(family) && !/sans/i.test(family), mono: /mono|courier|consol/i.test(family) };
}

/** Applies the full op list to the original bytes and saves the result as an incremental update. */
export async function applyEdits(original: Uint8Array, ops: EditOperation[], opts: { force?: ForceStrategy } = {}): Promise<ApplyResult> {
  const { doc, decrypted } = await loadPdf(original);
  const snapshot = decrypted ? null : snapshotObjects(doc.context);
  const analyses = analyzeDocument(doc, tableDefinitions(ops));
  const pages: PageModel[] = analyses.map((a) => structuredClone(a.model));
  const state = reduceEdits(pages, ops);
  const flowOp = ops.findLast((op) => op.type === 'setPageFlow');
  const pageFlow = flowOp?.newPages;
  const continuation = new Map(ops.flatMap((op) => (op.type === 'tableContinuation' ? [[op.tableId, op.repeatHeader] as const] : [])));
  const scanLayouts = new Map(ops.flatMap((op) => (op.type === 'scanLayout' ? [[op.pageIndex, op] as const] : [])));
  const reports: StrategyReport[] = [];
  const warnings: string[] = [];
  const patches = new Map<string, { info: StreamInfo; patch: StreamPatch; pageIndex: number }>();
  const fonts = new FontEmbedder(doc);
  /** Content appended at the end of a page, in the page's initial graphics state. */
  const tail = new Map<number, string[]>();
  const addTail = (pageIndex: number, content: string) => tail.set(pageIndex, [...(tail.get(pageIndex) ?? []), content]);

  const patchOf = (a: PageAnalysis, streamId: string) => {
    let p = patches.get(streamId);
    if (!p) {
      const info = a.interp.streams.get(streamId)!;
      if (info.uses > 1) warnings.push(`Form XObject ${streamId} is painted ${info.uses} times; the edit changes every copy`);
      p = { info, patch: emptyPatch(), pageIndex: a.pageIndex };
      patches.set(streamId, p);
    }
    return p.patch;
  };
  const remove = (a: PageAnalysis, runs: RunInternal[]) => {
    for (const r of runs) patchOf(a, r.streamId).replace.set(r.opIndex, removalOp(r));
  };

  // Cells are laid out once to measure row growth and again to place them; the strategy is chosen once.
  const chosenCache = new Map<string, Promise<Chosen>>();
  const choose = (a: PageAnalysis, box: BoxInternal, text: string, overflow: Parameters<typeof layoutBox>[2], wrapWidth?: number, style?: LayoutStyle) => {
    const key = JSON.stringify([a.pageIndex, box.id, text, overflow, wrapWidth, style]);
    let c = chosenCache.get(key);
    if (!c) chosenCache.set(key, (c = chooseStrategy(a, box, text, overflow, fonts, opts.force, wrapWidth, style)));
    return c;
  };

  /** Lays out `text` in the style of `box` and inserts it after the box's text object, translated by (dx, dy). */
  const place = async (a: PageAnalysis, box: BoxInternal, text: string, elementId: string, o: { overflow?: Parameters<typeof layoutBox>[2]; wrapWidth?: number; dx: number; dy: number; style?: LayoutStyle; background?: Color | null; onTop?: boolean }) => {
    const r0 = box.runs[0]!;
    const chosen = await choose(a, box, text, o.overflow, o.wrapWidth, o.style);
    const layout = chosen.layout;
    reports.push({
      elementId,
      pageIndex: a.pageIndex,
      strategy: chosen.strategy,
      fontName: r0.font.cleanName,
      ...(chosen.substituteFont ? { substituteFont: chosen.substituteFont } : {}),
      glyphs: layout.glyphs,
      warnings: [...chosen.warnings, ...layout.warnings],
    });
    if (chosen.strategy === 'none') return null;
    const moved = Math.abs(o.dx) > 1e-6 || Math.abs(o.dy) > 1e-6;
    const body = o.background ? `${backgroundFill(o.background, layout.bbox, r0.ctm)}\n${layout.content}` : layout.content;
    const content = moved ? `q ${translateIn(r0.ctm, o.dx, o.dy)}\n${body}\nQ` : body;
    // With a fill, the moved text must sit on top of whatever the page paints at the destination,
    // which may come later in the stream than the original text: draw it at the end of the page.
    if (((moved && o.background) || o.onTop) && r0.streamId === `page:${a.pageIndex}`) {
      addTail(a.pageIndex, `q ${r0.ctm.map(num).join(' ')} cm\n${content}\nQ`);
      return shiftRect(layout.bbox, o.dx, o.dy);
    }
    const p = patchOf(a, r0.streamId);
    const at = r0.etIndex >= 0 ? r0.etIndex : a.interp.streams.get(r0.streamId)!.content.ops.length - 1;
    p.insertAfter.set(at, [...(p.insertAfter.get(at) ?? []), content]);
    return shiftRect(layout.bbox, o.dx, o.dy);
  };

  /**
   * New text (addTextBox, text in tables with no text to copy the style from). A font the page
   * already uses (`fontFamily` = its name) is used as is when it has every glyph (S1); otherwise
   * the family is looked up like an S2 substitute and embedded.
   */
  const placeNew = async (ab: AddedBox, measure = false): Promise<TextBox | null> => {
    const a = analyses[ab.pageIndex]!;
    const pageStream = a.interp.streams.get(`page:${ab.pageIndex}`)!;
    const family = ab.fontFamily ?? 'Helvetica';
    const report: StrategyReport = { elementId: ab.id, pageIndex: ab.pageIndex, strategy: 'none', fontName: family, glyphs: { original: 0, composed: 0, fallback: 0, substitute: 0 }, warnings: [] };
    if (!measure) reports.push(report);
    const paragraphs = ab.text.split('\n');
    const chars = ab.text.replace(/\n/g, '');
    /** Glyph to show (`bytes`) or a space drawn as a displacement (`bytes` null); width in 1/1000 em. */
    type G = { ch: string; bytes: number[] | null; width: number };
    let glyphs: G[][];
    let key: string;
    let ascent: number;
    let descent: number;

    const own = a.interp.runs.find((r) => r.streamId === pageStream.id && r.font.cleanName === family && r.decodable && !r.font.isType3);
    const encoded = own ? paragraphs.map((p) => encodeForFont(own.font, p)) : [];
    if (own && encoded.every((e) => !e.missing.length && !e.reason)) {
      glyphs = encoded.map((e) => e.items.map((it): G => ({ ch: it.ch, bytes: it.kind === 'glyph' ? it.bytes : null, width: it.width })));
      key = own.state.fontKey;
      ascent = own.font.ascent / 1000;
      descent = own.font.descent / 1000;
      report.strategy = 'original';
      report.glyphs.original = [...chars].length;
    } else {
      const req = own ? fontRequest(own.font) : familyRequest(family);
      const hit = findSubstitute(req);
      let face: LoadedFace | undefined = hit ? loadFace(hit.face) : undefined;
      if (face && !faceCovers(face, chars)) face = undefined;
      face ??= findFallback(req, chars);
      if (!face) {
        report.warnings.push(`NO_GLYPH_SOURCE: no font covers the text of ${ab.id}; it was not added`);
        return null;
      }
      if (own) report.warnings.push(`${family} in this file lacks glyphs for: ${[...new Set(encoded.flatMap((e) => e.missing))].join(' ')}`);
      if (!hit || hit.face.file !== face.file) report.warnings.push(`${family} is not available; used ${face.postscriptName}`);
      report.strategy = 'substitute';
      report.substituteFont = face.postscriptName;
      report.glyphs.substitute = [...chars].length;
      const pdfFont = await fonts.embed(face);
      key = fonts.resourceKey(ab.pageIndex, pageStream, pdfFont);
      glyphs = paragraphs.map((p) => [...p].map((ch): G => ({ ch, ...fonts.glyph(pdfFont, ch) })));
      ascent = face.font.ascent / face.font.unitsPerEm;
      descent = face.font.descent / face.font.unitsPerEm;
    }

    const size = ab.fontSize;
    const maxW = ((ab.bbox.x1 - ab.bbox.x0) * 1000) / size;
    const widthOf = (gs: G[]) => gs.reduce((s, g) => s + g.width, 0);
    const lines: G[][] = [];
    const paraEnds = new Set<number>();
    for (const para of glyphs) {
      let cur: G[] = [];
      let word: G[] = [];
      const flush = () => {
        const trimmed = [...cur, ...word];
        while (trimmed.length && trimmed[trimmed.length - 1]!.ch === ' ') trimmed.pop();
        if (cur.length && widthOf(trimmed) > maxW) {
          while (cur.length && cur[cur.length - 1]!.ch === ' ') cur.pop();
          lines.push(cur);
          cur = word;
        } else cur = [...cur, ...word];
        word = [];
      };
      for (const g of para) {
        word.push(g);
        if (g.ch === ' ') flush();
      }
      flush();
      paraEnds.add(lines.length);
      lines.push(cur);
    }
    const lh = size * (ab.lineSpacing ?? 1.2);
    const hex = (bytes: number[]) => '<' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('') + '>';
    /** `extra`: added advance per space (1/1000 em), for justified lines. */
    const tj = (line: G[], extra = 0) =>
      '[' + line.map((g) => (g.ch !== ' ' || !extra ? (g.bytes ? hex(g.bytes) : num(-g.width)) : g.bytes ? `${hex(g.bytes)} ${num(-extra)}` : num(-g.width - extra))).join(' ') + '] TJ';
    const y0 = ab.bbox.y1 - ascent * size;
    const boxW = ab.bbox.x1 - ab.bbox.x0;
    const lineX = (l: G[]) => {
      const w = (widthOf(l) * size) / 1000;
      return ab.align === 'right' ? boxW - w : ab.align === 'center' ? (boxW - w) / 2 : 0;
    };
    // One Tm per line so each line can start at its own x; justified lines widen their spaces with TJ gaps.
    const body = lines
      .map((l, i) => {
        const spaces = l.filter((g) => g.ch === ' ').length;
        const extra = ab.align === 'justify' && !paraEnds.has(i) && spaces ? Math.max(0, (maxW - widthOf(l)) / spaces) : 0;
        return `1 0 0 1 ${num(ab.bbox.x0 + lineX(l))} ${num(y0 - i * lh)} Tm ${tj(l, extra)}`;
      })
      .join('\n');
    const bottom = y0 - (lines.length - 1) * lh + descent * size;
    const bbox = { ...ab.bbox, y0: Math.min(ab.bbox.y0, bottom) };
    if (measure) return { id: ab.id, runs: [], bbox, lineHeight: lh, align: ab.align ?? 'left', text: ab.text };
    const fill = ab.background ? `${backgroundFill(ab.background, bbox, [1, 0, 0, 1, 0, 0])}\n` : '';
    addTail(ab.pageIndex, `${fill}q BT /${key} ${num(size)} Tf ${colorOp(ab.color, false)}\n${body}\nET Q`);
    return { id: ab.id, runs: [], bbox, lineHeight: lh, align: ab.align ?? 'left', text: ab.text };
  };

  /** `q cm … Q` around ops first..last, translating what they paint by (dx, dy) in user space. */
  const shiftOps = (a: PageAnalysis, streamId: string, first: number, last: number, ctm: Matrix, dx: number, dy: number) => {
    const p = patchOf(a, streamId);
    p.insertBefore.set(first, [...(p.insertBefore.get(first) ?? []), `q ${translateIn(ctm, dx, dy)}`]);
    p.insertAfter.set(last, [...(p.insertAfter.get(last) ?? []), 'Q']);
  };

  const tables = tableDrawer({ doc, analyses, pages, warnings, patchOf, remove, addTail, choose, place, placeNew, shiftOps });
  await tables.growRows(state.tables.values());

  // Paths and images under a table whose bottom moved follow it, like the text boxes and tables there.
  const shiftedPaths = new Map<PathItem, { pageIndex: number; dy: number }>();
  const shiftedImages = new Map<ImageItem, { pageIndex: number; dy: number }>();
  const reflows = reflowBelow(pages, state);
  for (const rf of reflows) {
    const a = analyses[rf.pageIndex]!;
    const tablePaths = new Set(a.tables.flatMap((t) => t.paths));
    const cellImages = new Set(a.tables.flatMap((t) => [...t.cellImages.values()].flat()));
    const below = (r: Rect) => r.y1 <= rf.area.y0 + 1;
    for (const p of a.interp.paths) {
      const b = p.paint === 'none' || tablePaths.has(p) ? null : pathBox(p);
      if (b && below(b)) shiftedPaths.set(p, { pageIndex: rf.pageIndex, dy: (shiftedPaths.get(p)?.dy ?? 0) + rf.shift });
    }
    for (const im of a.interp.images) if (!cellImages.has(im) && below(im.bbox)) shiftedImages.set(im, { pageIndex: rf.pageIndex, dy: (shiftedImages.get(im)?.dy ?? 0) + rf.shift });
  }

  for (const edit of state.boxes.values()) {
    const a = analyses[edit.pageIndex]!;
    const box = a.boxes.find((b) => b.id === edit.boxId)!;
    const page = pages[edit.pageIndex]!;
    const modelIdx = page.textBoxes.findIndex((b) => b.id === edit.boxId);
    if (edit.deleted) {
      remove(a, box.runs);
      page.textBoxes.splice(modelIdx, 1);
      continue;
    }
    const text = edit.text ?? box.text;
    const st = edit.style;
    const style: LayoutStyle | undefined = st && { ...(st.color && { fill: [colorOp(st.color, false)] }), align: st.align, lineSpacing: st.lineSpacing };
    const bbox = await place(a, box, text, box.id, { overflow: edit.overflow, wrapWidth: edit.width, dx: edit.dx, dy: edit.dy, style, background: st?.background });
    if (!bbox) continue;
    remove(a, box.runs);
    const prev = page.textBoxes[modelIdx]!;
    const r0 = prev.runs[0]!;
    const lineHeight = st?.lineSpacing !== undefined ? st.lineSpacing * r0.fontSize * Math.hypot(r0.matrix[2], r0.matrix[3]) : prev.lineHeight;
    page.textBoxes[modelIdx] = { ...prev, text, bbox, align: st?.align ?? prev.align, lineHeight };
  }

  for (const ab of state.added.values()) {
    const tb = await placeNew(ab);
    if (tb) pages[ab.pageIndex]!.textBoxes.push(tb);
  }

  await tables.draw(state.tables.values());


  for (const [p, { pageIndex, dy }] of shiftedPaths) shiftOps(analyses[pageIndex]!, p.streamId, p.opStart, p.opEnd - 1, p.ctm, 0, dy);
  for (const [im, { pageIndex, dy }] of shiftedImages) shiftOps(analyses[pageIndex]!, im.streamId, im.opIndex, im.opIndex, im.ctm, 0, dy);

  for (const a of analyses) {
    const list = pages[a.pageIndex]!.tables.flatMap((t) => (t.setup ? [{ tableId: t.id, bbox: t.bbox, setup: t.setup, ...(t.pattern && { pattern: t.pattern }) }] : []));
    if (JSON.stringify(list) !== JSON.stringify(a.stored)) writeStoredTables(doc, doc.getPage(a.pageIndex), list);
  }

  for (const [pageIndex, contents] of tail) {
    const a = analyses[pageIndex]!;
    const p = patchOf(a, `page:${pageIndex}`);
    const last = a.interp.streams.get(`page:${pageIndex}`)!.content.ops.length - 1;
    if (last < 0) {
      p.insertAfter.set(-1, contents);
      continue;
    }
    // The original content may leave the CTM or clipping changed, so it is wrapped in q … Q.
    p.insertAfter.set(-1, ['q', ...(p.insertAfter.get(-1) ?? [])]);
    p.insertAfter.set(last, [...(p.insertAfter.get(last) ?? []), 'Q', ...contents]);
  }

  for (const [, { info, patch, pageIndex }] of patches) writeStream(doc, pageIndex, info, applyPatch(info.content, patch));

  const flowPages = analyses.map((a): FlowPage => {
    const page = pages[a.pageIndex]!;
    const span = (r: { y0: number; y1: number }) => ({ y0: r.y0, y1: r.y1 });
    const tall = (r: Rect) => r.y1 - r.y0 > 0.6 * (page.view.y1 - page.view.y0);
    // `orig`: where the unit was before the reflow under tables, so user moves and edits count as placed there.
    const reflowDy = (r: { y1: number }) => reflows.filter((rf) => rf.pageIndex === a.pageIndex && r.y1 <= rf.area.y0 + 1).reduce((x, rf) => x + rf.shift, 0);
    const unit = (r: { y0: number; y1: number }, dy: number, extra: Partial<FlowUnit> = {}): FlowUnit => ({ ...span(r), orig: { y0: r.y0 - dy, y1: r.y1 - dy }, ...(Math.abs(dy) > 0.01 && { pushed: true }), ...extra });
    const origBoxes = new Map(a.model.textBoxes.map((b) => [b.id, b.bbox]));
    const origTables = new Map(a.model.tables.map((t) => [t.id, t.bbox]));
    const pageNumber = (b: TextBox) => (PAGE_NUMBER.test(b.text.trim()) ? { pageNumber: { text: b.text.trim(), x0: b.bbox.x0, x1: b.bbox.x1 } } : {});
    const units: FlowUnit[] = page.textBoxes.map((b) => (origBoxes.has(b.id) ? unit(b.bbox, reflowDy(origBoxes.get(b.id)!), pageNumber(b)) : span(b.bbox)));
    const headers: Record<string, { y0: number; y1: number }> = {};
    for (const t of page.tables) {
      const ob = origTables.get(t.id);
      const rows = [...t.rows.map((r) => ({ ...span(r), row: r.index })), ...t.cells.filter((c) => (c.rowSpan ?? 1) > 1).map((c) => ({ ...span(c.bbox), row: c.row }))];
      for (const r of rows) units.push({ ...r, table: true, tableId: t.id, ...(ob && { orig: span(ob) }), ...((!ob || r.y0 < ob.y0 - 0.01 || reflowDy(ob)) && { pushed: true }) });
      const hr = headerRowsOf(t);
      if (hr > 0 && t.rows.length > hr) headers[t.id] = { y0: t.rows[hr - 1]!.y0, y1: t.rows[0]!.y1 };
    }
    const tablePaths = new Set(a.tables.flatMap((t) => t.paths));
    const cellImages = new Set(a.tables.flatMap((t) => [...t.cellImages.values()].flat()));
    for (const p of a.interp.paths) {
      const b = p.paint === 'none' || tablePaths.has(p) ? null : pathBox(p);
      if (!b || tall(b)) continue;
      const dy = shiftedPaths.get(p)?.dy ?? 0;
      units.push(unit({ y0: b.y0 + dy, y1: b.y1 + dy }, dy));
    }
    for (const im of a.interp.images) {
      if (cellImages.has(im) || tall(im.bbox)) continue;
      const dy = shiftedImages.get(im)?.dy ?? 0;
      units.push(unit({ y0: im.bbox.y0 + dy, y1: im.bbox.y1 + dy }, dy));
    }
    const layout = scanLayouts.get(a.pageIndex);
    for (const l of layout?.lines ?? []) {
      if (a.model.tables.some((t) => l.y0 < t.bbox.y1 - 1 && l.y1 > t.bbox.y0 + 1)) continue;
      const dy = reflowDy(l);
      units.push(unit({ y0: l.y0 + dy, y1: l.y1 + dy }, dy));
    }
    return { view: page.view, units, headers, ...(layout && { paper: layout.paper }) };
  });
  const flowOpts = { repeat: new Set([...continuation].flatMap(([id, yes]) => (yes ? [id] : []))), pageNumbers: flowOp?.pageNumbers };
  const plan = planFlow(flowPages, pageFlow, flowOpts);
  const involved = (k: number) => plan.pages[k] !== undefined || reflows.some((rf) => rf.pageIndex === k);
  const unmeasured = analyses.filter((a) => !a.model.editable && !scanLayouts.has(a.pageIndex));
  const firstUnmeasured = unmeasured.find((a) => involved(a.pageIndex));
  const overflows: PageOverflow[] = [];
  const continuations: EditResult['continuations'] = [];
  let outPages = pages;
  if (firstUnmeasured) {
    const needsLayout = unmeasured.filter((a) => a.pageIndex >= firstUnmeasured.pageIndex).map((a) => a.pageIndex);
    overflows.push({ pageIndex: firstUnmeasured.pageIndex, by: 0, needsLayout });
    warnings.push(`Scanned pages ${needsLayout.map((i) => i + 1).join(', ')} need a measured layout before content can flow across pages`);
  } else {
    if (plan.overflow) {
      overflows.push({ ...plan.overflow, needsPage: true });
      warnings.push(`Content on page ${plan.overflow.pageIndex + 1} extends ${plan.overflow.by.toFixed(1)} pt past the bottom of the body area`);
    }
    // Cut tables with header rows ask whether to repeat them; past the last page, a trial flow onto new pages finds them.
    const splits = plan.overflow ? planFlow(flowPages, 'empty', flowOpts).splits : plan.splits;
    for (const s of splits) if (!continuation.has(s.tableId) && flowPages.some((p) => p.headers?.[s.tableId])) continuations.push(s);
    if (plan.pages.some(Boolean)) {
      writeFlow(doc, plan);
      outPages = flowModels(pages, plan);
    }
  }
  await doc.flush();
  fonts.finalize();
  const bytes = snapshot ? writeIncremental(original, doc.context, snapshot) : await doc.save({ useObjectStreams: false });
  return { bytes, reports, warnings, pages: outPages, overflows, continuations };
}
