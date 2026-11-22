import {
  PDFArray,
  PDFBool,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFObjectCopier,
  PDFPage,
  PDFRef,
  PDFString,
  degrees,
} from 'pdf-lib';
import { parsePageRanges } from './ranges.ts';
import { loadPdf } from './load.ts';
import { PdfError } from './errors.ts';
import { snapshotObjects, writeIncremental } from './save/incremental.ts';
import { copyPage } from './edit/deskew.ts';

export type MergeInput = {
  file: Uint8Array;
  /** 1-based page ranges, e.g. "1-3,5,8-". All pages when omitted. */
  pages?: string;
  password?: string;
  /** Title of the top-level bookmark for this file. */
  name?: string;
  /** Degrees (a multiple of 90) added to each copied page's rotation. */
  rotate?: number;
};
/** An empty page the size of the page before it as shown (the page after it when it comes first; A4 if there is none). */
export type BlankPage = { blank: true };
/** A copy of output page `copy` (0-based, an earlier page; negative counts back, -1 = the page before) that shares content, fonts and images with it, as the editor's duplicate does. */
export type CopyPage = { copy: number };
const A4: [number, number] = [595.28, 841.89];

const PLACEHOLDER = 'PdfToolkitSrcPage';
const N = (s: string) => PDFName.of(s);

type OutlineNode = { title: PDFObject; dest: PDFArray | null; color?: PDFObject; flags?: PDFObject; children: OutlineNode[] };

/**
 * Reorders, removes and rotates the pages of a file in place (`page`: 0-based index; `rotate` is added to
 * the page's rotation). The catalog, /Info, XMP and outlines stay (outline items and links to removed pages
 * are unlinked); an unencrypted file gets an incremental update. Pages left out stay in the file but not in
 * the page tree.
 */
export async function arrangePdf(bytes: Uint8Array, order: { page: number; rotate?: number }[]): Promise<Uint8Array> {
  const { doc, decrypted } = await loadPdf(bytes);
  const snapshot = decrypted ? null : snapshotObjects(doc.context);
  const pages = doc.getPages();
  const treeRef = doc.catalog.get(N('Pages'));
  if (!(treeRef instanceof PDFRef)) throw new PdfError('INVALID_PDF', 'The page tree is not an indirect object');
  const refs = order.map(({ page: k, rotate }) => {
    const page = pages[k];
    if (!page) throw new PdfError('INVALID_EDIT', `Page ${k + 1} does not exist (${pages.length} pages)`);
    // Inherited attributes move to the page, as it may leave the node it inherited them from.
    for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      const v = page.node.getInheritableAttribute(N(key));
      if (v && !page.node.get(N(key))) page.node.set(N(key), v);
    }
    if (rotate) page.setRotation(degrees((((page.getRotation().angle + rotate) % 360) + 360) % 360));
    page.node.setParent(treeRef);
    return page.ref;
  });
  const tree = doc.catalog.Pages();
  tree.set(N('Kids'), doc.context.obj(refs));
  tree.set(N('Count'), PDFNumber.of(refs.length));
  const kept = new Set(refs);
  const removed = new Set(pages.map((p) => p.ref).filter((r) => !kept.has(r)));
  pruneOutline(doc, removed);
  pruneLinks(doc, refs, removed);
  const label = readPageLabels(doc);
  if (label) writePageLabels(doc, order.map(({ page }) => label(page)));
  return snapshot ? writeIncremental(bytes, doc.context, snapshot) : doc.save({ useObjectStreams: false });
}

export async function mergePdfs(inputs: (MergeInput | BlankPage | CopyPage)[]): Promise<Uint8Array> {
  if (inputs.length === 0) throw new PdfError('INVALID_RANGE', 'No input files');
  const out = await PDFDocument.create({ updateMetadata: false });
  out.setProducer('pdf-toolkit');
  const fileOutlines: OutlineNode[] = [];
  const usedFieldNames = new Set<string>();
  const fieldRoots: PDFRef[] = [];
  let acroDr: PDFDict | undefined;
  let acroDa: PDFObject | undefined;
  let needAppearances = false;

  const shownSize = (page: PDFPage): [number, number] => {
    const { width, height } = page.getSize();
    return page.getRotation().angle % 180 ? [height, width] : [width, height];
  };
  let leadingBlanks = 0;
  // Page label of each output page from its file (null: a blank, a copy or a file without labels).
  const labels: (PageLabel | null)[] = [];
  for (const [fileIndex, input] of inputs.entries()) {
    if ('blank' in input) {
      const last = out.getPageCount() ? out.getPage(out.getPageCount() - 1) : null;
      if (last) {
        out.addPage(shownSize(last));
        labels.push(null);
      } else leadingBlanks++;
      continue;
    }
    if ('copy' in input) {
      const count = leadingBlanks + out.getPageCount();
      const target = input.copy < 0 ? count + input.copy : input.copy;
      if (!Number.isInteger(target) || target < 0 || target >= count)
        throw new PdfError('INVALID_RANGE', `Copy of ${input.copy < 0 ? `the page ${-input.copy} back` : `page ${input.copy + 1}`}: ${count} page${count === 1 ? ' comes' : 's come'} before it`);
      const k = target - leadingBlanks;
      // A leading blank only gets its size once the first real page exists.
      if (k >= 0) copyPage(out, k);
      else if (out.getPageCount()) out.addPage(shownSize(out.getPage(0)));
      else {
        leadingBlanks++;
        continue;
      }
      labels.push(null);
      continue;
    }
    let src: PDFDocument;
    try {
      ({ doc: src } = await loadPdf(input.file, { password: input.password }));
    } catch (e) {
      if (e instanceof PdfError) throw new PdfError(e.code, `File ${fileIndex + 1}: ${e.message}`, { fileIndex });
      throw e;
    }
    const indices = parsePageRanges(input.pages, src.getPageCount());
    const srcPages = src.getPages();
    const srcRefIndex = new Map<PDFRef, number>(srcPages.map((p, i) => [p.ref, i]));
    const resolveDest = makeDestResolver(src);

    for (const idx of new Set(indices)) {
      const annots = srcPages[idx]!.node.Annots();
      if (!annots) continue;
      for (let a = 0; a < annots.size(); a++) {
        const annot = annots.lookup(a);
        if (!(annot instanceof PDFDict)) continue;
        annot.delete(N('P'));
        rewriteAnnotDest(annot, resolveDest, srcRefIndex);
      }
    }

    const srcLabel = readPageLabels(src);
    labels.push(...indices.map((k) => srcLabel?.(k) ?? null));
    const copied = await out.copyPages(src, indices);
    const firstOutputRef = new Map<number, PDFRef>();
    copied.forEach((page, k) => {
      if (input.rotate) page.setRotation(degrees((((page.getRotation().angle + input.rotate) % 360) + 360) % 360));
      out.addPage(page);
      const srcIdx = indices[k]!;
      if (!firstOutputRef.has(srcIdx)) firstOutputRef.set(srcIdx, page.ref);
    });

    for (const page of copied) {
      const annots = page.node.Annots();
      if (!annots) continue;
      for (let a = annots.size() - 1; a >= 0; a--) {
        const annot = annots.lookup(a);
        if (!(annot instanceof PDFDict)) continue;
        if (!finalizeAnnotDest(annot, firstOutputRef)) {
          annots.remove(a);
          continue;
        }
        if (annot.lookup(N('Subtype')) === N('Widget')) {
          annot.set(N('P'), page.ref);
          const root = fieldRoot(out, annots.get(a));
          if (root && !fieldRoots.includes(root)) {
            renameField(out, root, usedFieldNames);
            fieldRoots.push(root);
          }
        }
      }
    }

    const srcAcro = src.catalog.lookupMaybe(N('AcroForm'), PDFDict);
    if (srcAcro) {
      const copier = PDFObjectCopier.for(src.context, out.context);
      const dr = srcAcro.lookupMaybe(N('DR'), PDFDict);
      if (dr) acroDr = mergeResourceDicts(out, acroDr, copier.copy(dr));
      acroDa ??= srcAcro.lookup(N('DA'));
      const na = srcAcro.lookup(N('NeedAppearances'));
      if (na instanceof PDFBool && na.asBoolean()) needAppearances = true;
    }

    const children = readOutline(src, resolveDest, srcRefIndex, firstOutputRef);
    const firstPage = copied[0]?.ref;
    const title = input.name ?? src.getTitle() ?? `Document ${fileIndex + 1}`;
    fileOutlines.push({
      title: PDFHexString.fromText(title),
      dest: firstPage ? out.context.obj([firstPage, N('Fit')]) : null,
      children,
    });
  }

  const size = out.getPageCount() ? shownSize(out.getPage(0)) : A4;
  for (let i = 0; i < leadingBlanks; i++) out.insertPage(0, size);
  labels.unshift(...Array.from({ length: leadingBlanks }, () => null));
  if (labels.some((l) => l)) writePageLabels(out, labels);

  if (fieldRoots.length > 0) {
    const acro = out.context.obj({ Fields: out.context.obj(fieldRoots) });
    if (acroDr) acro.set(N('DR'), acroDr);
    if (acroDa) acro.set(N('DA'), acroDa);
    if (needAppearances) acro.set(N('NeedAppearances'), PDFBool.True);
    out.catalog.set(N('AcroForm'), out.context.register(acro));
  }
  writeOutline(out, fileOutlines);
  return out.save({ useObjectStreams: true });
}

/** A page's label as a /PageLabels range gives it: style, prefix and its own number. */
type PageLabel = { style?: string; prefix?: string; n: number };

/** The label of each page index from the catalog's /PageLabels number tree, or null when there is none. */
function readPageLabels(doc: PDFDocument): ((page: number) => PageLabel) | null {
  const root = doc.catalog.lookupMaybe(N('PageLabels'), PDFDict);
  if (!root) return null;
  const ranges: { start: number; style?: string; prefix?: string; first: number }[] = [];
  const walk = (node: PDFDict, depth: number) => {
    if (depth > 32) return;
    const nums = node.lookupMaybe(N('Nums'), PDFArray);
    for (let i = 0; nums && i + 1 < nums.size(); i += 2) {
      const key = nums.lookup(i);
      const dict = nums.lookup(i + 1);
      if (!(key instanceof PDFNumber) || !(dict instanceof PDFDict)) continue;
      const s = dict.lookup(N('S'));
      const p = dict.lookup(N('P'));
      const st = dict.lookup(N('St'));
      ranges.push({
        start: key.asNumber(),
        style: s instanceof PDFName ? s.decodeText() : undefined,
        prefix: p instanceof PDFString || p instanceof PDFHexString ? p.decodeText() : undefined,
        first: st instanceof PDFNumber ? st.asNumber() : 1,
      });
    }
    const kids = node.lookupMaybe(N('Kids'), PDFArray);
    for (let i = 0; kids && i < kids.size(); i++) {
      const kid = kids.lookup(i);
      if (kid instanceof PDFDict) walk(kid, depth + 1);
    }
  };
  walk(root, 0);
  if (!ranges.length) return null;
  ranges.sort((a, b) => a.start - b.start);
  return (page) => {
    const r = ranges.findLast((x) => x.start <= page);
    // Pages before the first range have no label; they show as their position.
    if (!r) return { style: 'D', n: page + 1 };
    return { style: r.style, prefix: r.prefix, n: r.first + page - r.start };
  };
}

/** Writes /PageLabels with a new range wherever a page doesn't continue the previous one; null: decimal page position. */
function writePageLabels(doc: PDFDocument, labels: (PageLabel | null)[]): void {
  const ctx = doc.context;
  const nums: PDFObject[] = [];
  let prev: PageLabel | undefined;
  labels.forEach((l, i) => {
    const cur = l ?? { style: 'D', n: i + 1 };
    if (!prev || prev.style !== cur.style || prev.prefix !== cur.prefix || cur.n !== prev.n + 1) {
      const dict = ctx.obj({});
      if (cur.style) dict.set(N('S'), N(cur.style));
      if (cur.prefix !== undefined) dict.set(N('P'), PDFHexString.fromText(cur.prefix));
      if (cur.n !== 1) dict.set(N('St'), PDFNumber.of(cur.n));
      nums.push(PDFNumber.of(i), dict);
    }
    prev = cur;
  });
  doc.catalog.set(N('PageLabels'), ctx.obj({ Nums: ctx.obj(nums) }));
}

type DestResolver = (d: PDFObject | undefined) => PDFArray | null;

function makeDestResolver(doc: PDFDocument): DestResolver {
  const catalog = doc.catalog;
  const oldDests = catalog.lookupMaybe(N('Dests'), PDFDict);
  const names = catalog.lookupMaybe(N('Names'), PDFDict);
  const destTree = names?.lookupMaybe(N('Dests'), PDFDict);
  const fromValue = (v: PDFObject | undefined): PDFArray | null => {
    const r = v instanceof PDFRef ? doc.context.lookup(v) : v;
    if (r instanceof PDFArray) return r;
    if (r instanceof PDFDict) {
      const d = r.lookup(N('D'));
      return d instanceof PDFArray ? d : null;
    }
    return null;
  };
  return (d) => {
    const v = d instanceof PDFRef ? doc.context.lookup(d) : d;
    if (v instanceof PDFArray) return v;
    if (v instanceof PDFName) return fromValue(oldDests?.get(v));
    if ((v instanceof PDFString || v instanceof PDFHexString) && destTree) {
      return fromValue(lookupNameTree(doc, destTree, v.decodeText(), 0));
    }
    return null;
  };
}

function lookupNameTree(doc: PDFDocument, node: PDFDict, key: string, depth: number): PDFObject | undefined {
  if (depth > 32) return undefined;
  const names = node.lookupMaybe(N('Names'), PDFArray);
  if (names) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const k = names.lookup(i);
      if ((k instanceof PDFString || k instanceof PDFHexString) && k.decodeText() === key) return names.get(i + 1);
    }
  }
  const kids = node.lookupMaybe(N('Kids'), PDFArray);
  if (kids) {
    for (let i = 0; i < kids.size(); i++) {
      const kid = kids.lookup(i);
      if (!(kid instanceof PDFDict)) continue;
      const limits = kid.lookupMaybe(N('Limits'), PDFArray);
      if (limits) {
        const lo = limits.lookup(0);
        const hi = limits.lookup(1);
        const los = lo instanceof PDFString || lo instanceof PDFHexString ? lo.decodeText() : '';
        const his = hi instanceof PDFString || hi instanceof PDFHexString ? hi.decodeText() : '￿';
        if (key < los || key > his) continue;
      }
      const found = lookupNameTree(doc, kid, key, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** Replaces the page reference of an internal destination with a placeholder name so the copier
 * doesn't drag the target page (and its whole page tree) along as an orphan object. */
function placeholderDest(dest: PDFArray, srcRefIndex: Map<PDFRef, number>, ctx: PDFContext): PDFArray | null {
  const target = dest.get(0);
  if (!(target instanceof PDFRef)) return null;
  const idx = srcRefIndex.get(target);
  if (idx === undefined) return null;
  const items: PDFObject[] = [N(`${PLACEHOLDER}${idx}`)];
  for (let i = 1; i < dest.size(); i++) {
    const v = dest.lookup(i);
    items.push(v instanceof PDFNumber || v instanceof PDFName ? v : PDFNumber.of(0));
  }
  return ctx.obj(items);
}

function rewriteAnnotDest(annot: PDFDict, resolve: DestResolver, srcRefIndex: Map<PDFRef, number>): void {
  const ctx = annot.context;
  const dest = annot.get(N('Dest'));
  if (dest) {
    const arr = resolve(dest);
    const ph = arr ? placeholderDest(arr, srcRefIndex, ctx) : null;
    if (ph) annot.set(N('Dest'), ph);
    else annot.delete(N('Dest'));
  }
  const action = annot.lookup(N('A'));
  if (action instanceof PDFDict && action.lookup(N('S')) === N('GoTo')) {
    const arr = resolve(action.get(N('D')));
    const ph = arr ? placeholderDest(arr, srcRefIndex, ctx) : null;
    const copy = action.clone();
    if (ph) copy.set(N('D'), ph);
    else copy.delete(N('D'));
    annot.set(N('A'), copy);
  }
}

/** Resolves placeholders to output pages. Returns false for a link whose target page was dropped. */
function finalizeAnnotDest(annot: PDFDict, firstOutputRef: Map<number, PDFRef>): boolean {
  const fix = (arr: PDFObject | undefined): boolean | null => {
    if (!(arr instanceof PDFArray)) return null;
    const head = arr.get(0);
    if (!(head instanceof PDFName) || !head.decodeText().startsWith(PLACEHOLDER)) return null;
    const ref = firstOutputRef.get(Number(head.decodeText().slice(PLACEHOLDER.length)));
    if (!ref) return false;
    arr.set(0, ref);
    return true;
  };
  const isLink = annot.lookup(N('Subtype')) === N('Link');
  const destOk = fix(annot.lookup(N('Dest')));
  const action = annot.lookup(N('A'));
  const actOk = action instanceof PDFDict ? fix(action.lookup(N('D'))) : null;
  if (destOk === false) annot.delete(N('Dest'));
  if (actOk === false) annot.delete(N('A'));
  return !(isLink && (destOk === false || actOk === false));
}

function fieldRoot(doc: PDFDocument, widgetRef: PDFObject): PDFRef | null {
  let ref = widgetRef instanceof PDFRef ? widgetRef : null;
  for (let depth = 0; ref && depth < 64; depth++) {
    const dict = doc.context.lookup(ref);
    if (!(dict instanceof PDFDict)) return null;
    const parent = dict.get(N('Parent'));
    if (!(parent instanceof PDFRef)) return dict.has(N('T')) || dict.has(N('FT')) ? ref : null;
    ref = parent;
  }
  return null;
}

function renameField(doc: PDFDocument, root: PDFRef, used: Set<string>): void {
  const dict = doc.context.lookup(root);
  if (!(dict instanceof PDFDict)) return;
  const t = dict.lookup(N('T'));
  const base = t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : 'field';
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  used.add(name);
  if (name !== base || !t) dict.set(N('T'), PDFHexString.fromText(name));
}

function mergeResourceDicts(doc: PDFDocument, into: PDFDict | undefined, add: PDFObject): PDFDict | undefined {
  const addDict = add instanceof PDFRef ? doc.context.lookup(add) : add;
  if (!(addDict instanceof PDFDict)) return into;
  if (!into) return addDict;
  for (const [cat, sub] of addDict.entries()) {
    const subDict = sub instanceof PDFRef ? doc.context.lookup(sub) : sub;
    const existing = into.lookup(cat);
    if (subDict instanceof PDFDict && existing instanceof PDFDict) {
      for (const [k, v] of subDict.entries()) if (!existing.has(k)) existing.set(k, v);
    } else if (!existing) {
      into.set(cat, sub);
    }
  }
  return into;
}

function readOutline(
  src: PDFDocument,
  resolve: DestResolver,
  srcRefIndex: Map<PDFRef, number>,
  firstOutputRef: Map<number, PDFRef>,
): OutlineNode[] {
  const root = src.catalog.lookupMaybe(N('Outlines'), PDFDict);
  if (!root) return [];
  const seen = new Set<PDFDict>();
  const walk = (first: PDFObject | undefined, depth: number): OutlineNode[] => {
    const nodes: OutlineNode[] = [];
    let cur = first instanceof PDFRef ? src.context.lookup(first) : first;
    while (cur instanceof PDFDict && !seen.has(cur) && depth < 32) {
      seen.add(cur);
      let destArr = resolve(cur.get(N('Dest')));
      const action = cur.lookup(N('A'));
      if (!destArr && action instanceof PDFDict && action.lookup(N('S')) === N('GoTo')) destArr = resolve(action.get(N('D')));
      let dest: PDFArray | null = null;
      const target = destArr?.get(0);
      const srcIdx = target instanceof PDFRef ? srcRefIndex.get(target) : undefined;
      const outRef = srcIdx !== undefined ? firstOutputRef.get(srcIdx) : undefined;
      if (destArr && outRef) {
        const items: PDFObject[] = [outRef];
        for (let i = 1; i < destArr.size(); i++) {
          const v = destArr.lookup(i);
          items.push(v instanceof PDFNumber || v instanceof PDFName ? v : PDFNumber.of(0));
        }
        dest = src.context.obj(items);
      }
      const children = walk(cur.get(N('First')), depth + 1);
      const title = cur.lookup(N('Title'));
      if (dest || children.length > 0) {
        nodes.push({
          title: title instanceof PDFString || title instanceof PDFHexString ? title : PDFHexString.fromText(''),
          dest,
          color: cur.lookup(N('C')),
          flags: cur.lookup(N('F')),
          children,
        });
      }
      const next = cur.get(N('Next'));
      cur = next instanceof PDFRef ? src.context.lookup(next) : next;
    }
    return nodes;
  };
  return walk(root.get(N('First')), 0);
}

/** Removes, in place, link annotations on the `kept` pages whose destination is one of `removed`, as mergePdfs does. */
function pruneLinks(doc: PDFDocument, kept: PDFRef[], removed: Set<PDFRef>): void {
  if (removed.size === 0) return;
  const resolve = makeDestResolver(doc);
  const hitsRemoved = (d: PDFObject | undefined) => {
    const target = resolve(d)?.get(0);
    return target instanceof PDFRef && removed.has(target);
  };
  for (const ref of kept) {
    const annots = doc.context.lookupMaybe(ref, PDFDict)?.lookupMaybe(N('Annots'), PDFArray);
    if (!annots) continue;
    for (let a = annots.size() - 1; a >= 0; a--) {
      const annot = annots.lookup(a);
      if (!(annot instanceof PDFDict) || annot.lookup(N('Subtype')) !== N('Link')) continue;
      const action = annot.lookup(N('A'));
      const goTo = action instanceof PDFDict && action.lookup(N('S')) === N('GoTo');
      if (hitsRemoved(annot.get(N('Dest'))) || (goTo && hitsRemoved(action.get(N('D'))))) annots.remove(a);
    }
  }
}

/**
 * Unlinks, in place, outline items whose destination is one of `removed`. An item that still has children
 * keeps them and loses only its destination. Open/closed state is kept; the counts are recomputed.
 */
function pruneOutline(doc: PDFDocument, removed: Set<PDFRef>): void {
  const root = doc.catalog.lookupMaybe(N('Outlines'), PDFDict);
  if (!root || removed.size === 0) return;
  const resolve = makeDestResolver(doc);
  const ctx = doc.context;
  const children = (parent: PDFDict, seen: Set<PDFDict>): [PDFRef, PDFDict][] => {
    const out: [PDFRef, PDFDict][] = [];
    let ref = parent.get(N('First'));
    while (ref instanceof PDFRef && out.length < 100_000) {
      const item = ctx.lookup(ref);
      if (!(item instanceof PDFDict) || seen.has(item)) break;
      seen.add(item);
      out.push([ref, item]);
      ref = item.get(N('Next'));
    }
    return out;
  };
  const goTo = (item: PDFDict): boolean => {
    const a = item.lookup(N('A'));
    return a instanceof PDFDict && a.lookup(N('S')) === N('GoTo');
  };
  const dangles = (item: PDFDict): boolean => {
    const action = item.lookup(N('A'));
    const dest = resolve(item.get(N('Dest'))) ?? (goTo(item) ? resolve((action as PDFDict).get(N('D'))) : null);
    const target = dest?.get(0);
    return target instanceof PDFRef && removed.has(target);
  };
  const anyDangles = (parent: PDFDict, seen: Set<PDFDict>): boolean =>
    children(parent, seen).some(([, item]) => dangles(item) || anyDangles(item, seen));
  if (!anyDangles(root, new Set())) return;
  const seen = new Set<PDFDict>();
  // Returns the number of items shown below `parent` when it is open.
  const prune = (parent: PDFDict): number => {
    const keep: [PDFRef, PDFDict][] = [];
    let shown = 0;
    for (const [ref, item] of children(parent, seen)) {
      const below = prune(item);
      const hasKids = item.get(N('First')) instanceof PDFRef;
      if (dangles(item)) {
        if (!hasKids) continue;
        item.delete(N('Dest'));
        if (goTo(item)) item.delete(N('A'));
      }
      keep.push([ref, item]);
      if (hasKids) {
        const open = (item.lookupMaybe(N('Count'), PDFNumber)?.asNumber() ?? 0) > 0;
        item.set(N('Count'), PDFNumber.of(open ? below : -below));
        shown += open ? below : 0;
      }
      shown += 1;
    }
    keep.forEach(([, item], i) => {
      if (i > 0) item.set(N('Prev'), keep[i - 1]![0]);
      else item.delete(N('Prev'));
      if (i < keep.length - 1) item.set(N('Next'), keep[i + 1]![0]);
      else item.delete(N('Next'));
    });
    if (keep.length) {
      parent.set(N('First'), keep[0]![0]);
      parent.set(N('Last'), keep[keep.length - 1]![0]);
    } else {
      parent.delete(N('First'));
      parent.delete(N('Last'));
      parent.delete(N('Count'));
    }
    return shown;
  };
  root.set(N('Count'), PDFNumber.of(prune(root)));
}

function writeOutline(doc: PDFDocument, top: OutlineNode[]): void {
  if (top.length === 0) return;
  const ctx = doc.context;
  const rootRef = ctx.nextRef();
  const build = (nodes: OutlineNode[], parent: PDFRef, open: boolean): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = nodes.map(() => ctx.nextRef());
    let visible = 0;
    nodes.forEach((node, i) => {
      const dict = ctx.obj({}) as PDFDict;
      dict.set(N('Title'), node.title);
      dict.set(N('Parent'), parent);
      if (i > 0) dict.set(N('Prev'), refs[i - 1]!);
      if (i < nodes.length - 1) dict.set(N('Next'), refs[i + 1]!);
      if (node.dest) dict.set(N('Dest'), node.dest.clone(ctx));
      if (node.color instanceof PDFArray) dict.set(N('C'), node.color.clone(ctx));
      if (node.flags instanceof PDFNumber) dict.set(N('F'), node.flags);
      if (node.children.length > 0) {
        const sub = build(node.children, refs[i]!, false);
        dict.set(N('First'), sub.first);
        dict.set(N('Last'), sub.last);
        dict.set(N('Count'), PDFNumber.of(-sub.count));
      }
      ctx.assign(refs[i]!, dict);
      visible += 1;
    });
    return { first: refs[0]!, last: refs[refs.length - 1]!, count: open ? visible : nodes.length };
  };
  const res = build(top, rootRef, true);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: res.first, Last: res.last, Count: res.count }));
  doc.catalog.set(N('Outlines'), rootRef);
}
