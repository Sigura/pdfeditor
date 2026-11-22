# PDF Toolkit

Merge PDFs and edit them visually, in TypeScript end to end. See [ARCHITECTURE.md](ARCHITECTURE.md) for module boundaries, the edit-operation schema and the font strategy.

## Setup

Requires Node 20+ and pnpm 9 (`corepack enable` provides it).

```sh
pnpm install
pnpm dev:server      # API on http://localhost:3001
pnpm dev:web         # UI on http://localhost:5173 (proxies /api to the server)
pnpm test            # unit + API tests (vitest)
pnpm test:e2e        # Playwright end-to-end flows (starts both servers unless they already run)
pnpm typecheck
pnpm fixtures        # regenerate fixtures/*.pdf
pnpm compare-strategies <dir>   # visual check of S2/S3: renders PNGs, fails if the glyphs drift
```

### Running inside a devbox container

The container has no global `pnpm`, and the root scripts call `pnpm` again, so start the servers directly. Vite has to listen on all interfaces so the forwarded port works:

```sh
corepack pnpm install
(cd apps/server && npx tsx src/main.ts)        # API on :3001, all interfaces
(cd apps/web && npx vite --host 0.0.0.0)       # UI on :5173
npx vitest run                                 # tests
npx playwright test                            # e2e (reuses servers already on :3001/:5173)
npx tsc -p packages/pdf-core                   # typecheck one package
npx tsx scripts/compare-strategies.mts <dir>   # S2/S3 visual check (needs Playwright's Chromium)
```

On the host, forward the ports once (`PORTS=( 3001 5173 )` in `.devbox.conf`, then `devbox restart`) and open http://localhost:5173. To keep the app running without an attached session, run it as a service: `devbox serve pdf-toolkit --port 3001 --port 5173 -- sh -c 'cd apps/server && npx tsx src/main.ts & cd apps/web && exec npx vite --host 0.0.0.0'` (not verified yet). The project needs no conda env. Playwright's Chromium needs the system libraries listed in `APT_PACKAGES`.

Server environment variables: `PORT` (3001), `DATA_DIR` (`apps/server/data`), `MAX_FILE_MB` (50), `MAX_FILES` (20), `DOC_TTL_MIN` (60).

## Merge

- **UI**: in the *Merge* tab, drop PDFs, drag page thumbnails to reorder them (also across files), remove pages with ×, then *Merge & download*. Password-protected files ask for the password.
- **CLI**: `pnpm pdf-tool merge a.pdf b.pdf:1-3 -o out.pdf` (ranges like `1-3,5,8-`, `-2`, `5-3`). For encrypted inputs: `--password a.pdf=secret`.
- **API**: `POST /api/merge`, multipart:
  - `files`: one or more PDFs, in order
  - `ranges` (optional): JSON array aligned with `files`, e.g. `["", "1-3"]`
  - `passwords` (optional): JSON array aligned with `files`
  - `segments` (optional): JSON `[{"file":1,"pages":"2"},{"file":0}]` for any page order across files. It overrides `ranges`.

  Returns `application/pdf`. Errors are JSON `{ error: { code, message } }`. Codes: `INVALID_RANGE`, `INVALID_PDF`, `ENCRYPTED` (password needed), `BAD_PASSWORD`, `UNSUPPORTED_ENCRYPTION`, `NOT_PDF`, `TOO_LARGE`.

What merge keeps:
- Page size, rotation and inherited page attributes.
- Annotations. Internal links are re-pointed to the merged pages. Links to pages that weren't included are removed.
- Bookmarks: each source file becomes a top-level bookmark, and the file's own outline is nested under it.
- AcroForm fields. Colliding names are renamed (`name`, `name_2`). `/DR` resources are merged.
- Encrypted inputs: the standard security handler is supported (RC4 40/128, AES-128, AES-256 R5/R6), with either the user or the owner password. Files that only have an owner password open without asking. Public-key security handlers return `UNSUPPORTED_ENCRYPTION`.

Known merge limitations: the tagged-PDF structure tree, named destinations from the sources (they are resolved into explicit destinations on links and bookmarks), and document-level JavaScript aren't carried over.

## Editor

### Page model (read-only, phase 2)

- `POST /api/documents` (multipart `file`, optional `password`) returns `{ docId, fileName, pageCount, pages: PageModel[] }`.
- `GET /api/documents/:id` returns the same data plus `revision`, `ops` and `reports`.
- `GET /api/documents/:id/pages/:n/model` returns one page model (0-based `n`).
- `GET /api/documents/:id/pdf` returns the current revision inline. `GET /api/documents/:id/download` returns it as an attachment.

Text is extracted by our own content-stream interpreter, not by pdf.js, so that every `TextRun` maps to its exact show operator (`contentStreamRef`). Runs are grouped into lines (same baseline, small gaps) and boxes (similar size, regular line spacing, horizontal overlap). Alignment is inferred from line edges. The *Edit* tab shows these boxes over the pdf.js rendering.

Encrypted uploads are decrypted once with the given password and stored decrypted in the TTL-limited data directory. Rendering and editing then don't need the password again.

Detected and reported, not faked:
- Scanned pages: `editable: false` with a warning, because OCR is out of scope.
- Runs that can't be decoded to Unicode (no ToUnicode, unknown encoding): `decodable: false` plus a page warning.
- Form XObjects painted several times: a warning that editing changes every copy.

### Text editing (phase 3)

In the *Edit* tab, click a box to select it. Click it again, or double-click, to edit the text in place. Clicking outside the box (or Ctrl+Enter) applies the edit, and Esc cancels. The badge on an edited box shows the font strategy. *S1 original* means the text was re-encoded with the file's own embedded font. *not applied* means the font lacks a glyph. Hover over the badge to see which characters are missing.

- `POST /api/documents/:id/edits` with `{ "ops": [...], "mode": "append" | "replace" }` (see the op table in ARCHITECTURE.md). The server re-applies the full op list to the original, stores the result as the current revision and returns `{ revision, ops, reports, warnings, pages }`. Page models always describe the original plus the edits, so element IDs stay stable across revisions. Undo is a `replace` with a shorter list.
- `replaceText` takes `overflow: shrink | wrap | overflow`. The default is `wrap` for multi-line boxes and `overflow` for single lines. All ops in the table in ARCHITECTURE.md are implemented (phase 5 below).
- S1 check: every character must map to a code through the inverse ToUnicode map or the encoding's glyph names. That code must have a glyph in the embedded program (TrueType/OpenType, bare CFF or Type1), the standard-14 encoding, or Type3 CharProcs, and it must have a width.
- S2 (substitute): when S1 fails, the font name is matched against `fonts/` and the system font directories, by PostScript name, then by family and style, then by a metric-compatible alias (Arial/Helvetica ↔ Liberation Sans/Arimo, Times ↔ Liberation Serif/Tinos, Courier ↔ Liberation Mono/Cousine, Calibri ↔ Carlito, Cambria ↔ Caladea). If that font covers the whole text, a subset is embedded as Type0/Identity-H with ToUnicode, under a new `/TKn` resource name. Only `.ttf`/`.otf` files are indexed (no `.ttc`/`.pfb`).
- S3 (emulated): each missing character is drawn as a vector path. Sources, in order: an outline from the embedded program; an NFD composition from the font's own glyphs (é = e + ´, ş = s + ¸, İ = I + ˙, using dotless ı/ȷ as bases when present); the closest fallback font (serif/sans, mono, weight, italic), scaled to the original x-height/cap height and average width, and emboldened with a stroke when needed. An invisible (3 Tr) copy in an embedded Unicode font keeps the text searchable and copyable. With no source at all, the report says `NO_GLYPH_SOURCE` and the box stays unchanged.
- Fonts: put extra fonts (e.g. the Liberation, Carlito or original families) in `fonts/`. Server variables: `FONTS_DIR` (default `fonts/`), `SYSTEM_FONTS=0` to ignore system fonts.
- Layout keeps the first run's font resource, size, Tc/Tw/Tz/Ts/Tr and fill color, plus each line's baseline and start position and the alignment. Glyphs that match the original line keep their original positions, including kerning and TJ gaps, so unchanged lines re-render pixel-identical. Mixed styles inside one box collapse to the first run's style (reported).
- Removal: each removed `Tj`/`TJ` becomes `[-N] TJ` with the same advance (`'` → `T* [-N] TJ`, `"` → `aw Tw ac Tc T* [-N] TJ`). New text goes right after the `ET` of the first run's text object, inside `q … Q`.
- Saving is an incremental update. Only objects whose re-serialization changed (the page's new content stream and `/Contents`) are appended, with an xref section and `/Prev`. The original bytes stay an exact prefix, and `/Info`, XMP, fonts and other pages are untouched. Because of this, the previous revision, old glyphs included, is still in the file. A full rewrite that drops old revisions isn't implemented.

### Moving, adding text and tables (phase 5)

UI (*Edit* tab):
- *Select* tool: click a box to select it, then drag it to move it. The corner handle changes the wrap width. Delete or Backspace removes the box, and ↶/↷ undo and redo.
- *Add text*: pick a font and size, then click on the page. The picker lists the fonts the PDF uses, each with a sample cropped from the rendered page, plus Helvetica, Times and Courier.
- Tables: detected tables show a dashed cell grid. Click a cell for the row/column toolbar (insert above/below/left/right, delete row/column, delete table). Double-click a cell to edit its text, and drag the violet grip to move the table.
- *Table* tool: click a detected table, or drag a rectangle over a table that isn't detected (a borderless or scanned one). Step 1 asks for rows, columns, border width and header rows, proposed from the rulings, the text or, on a scanned page, the border lines found in the pixels. Step 2 shows the mesh: every vertex snaps to a junction (green) or not (yellow), and edges show whether a line is under them. Drag a vertex or move it with the arrow keys (its whole row and column line moves, so cells stay rectangles), click a cell (Shift+click extends the selection) to *Merge* or *Split* cells, *+Row*/*+Col* split a row or column in two, then *Confirm* (one `defineTable` change).

Behaviour:
- `moveElement` re-emits the box's text with the same glyphs and positions under a `cm` translation, so a moved box is the original shifted by exactly `dx`/`dy`. `width` re-wraps the text to the new width.
- `addTextBox`: when `fontFamily` names a font that the page already uses and that font has every glyph, the text is written with that font resource (S1). Otherwise the family is looked up like an S2 substitute and embedded. Text starts at the box's top-left (baseline = top − ascent), wraps at the box width, and uses a line height of 1.2 × size.
- Table detection: connected horizontal and vertical ruling lines (stroked, or thin filled rectangles) that form at least two cells. Cell fills come from filled rectangles inside the grid. Text in cells is excluded from the free text boxes. Merged cells are not detected.
- Table edits regenerate only the changed table. The old ruling lines and fills stop being painted (their paint operator becomes `n`), a new grid is drawn with the same line width and color, and inserted rows and columns take the size of the row or column they were inserted next to. Cells whose text and position didn't change keep their original operators. Moved cells are re-emitted under a translation, and edited cells are laid out with the cell's own font (S1/S2/S3 as for boxes). New text in an empty cell copies the style and in-cell offset of the nearest cell with text in the same column. When the table's bottom edge moves, text and tables right below it shift with it. A new column that would run off the page asks first; *Shrink other columns* narrows them proportionally so the table keeps its width, except that a column holding an image or scanned ink stays at least as wide as that content.
- `defineTable` redefines a detected table (same `tableId`) or defines a new one, from the Table tool's mesh. Its coordinates refer to the original page, it is stored in the page's `/PieceInfo` so it survives save and reopen, and it is applied before the other ops. Regenerated tables keep the detected pattern (outer, header and body line roles, header and zebra fills).
- Scanned tables (`origin: 'raster'`): only changed parts are redrawn, from the scan itself and never resampled: cells as crops at their original size, borders tiled from clean pieces of the original edges, the scan below the table shifted when the table grows. A cell set with new text gets its background colour and vector text in the measured ink colour, sized from the ink of its column. A cell can't get smaller than its ink (border drags stop there; Inspector values below it are reverted).
- Cell editor: double-click a cell. The bar above it sets the font, size, text colour and cell fill (only what you change is sent). Esc cancels and Ctrl+Enter or a click outside saves, also while the focus is in the bar; Tab saves and opens the next cell.

### Editing UI (phase 6)

- Keyboard: arrow keys nudge the selected box by 1 pt (10 pt with Shift). Consecutive presses go to the server as one `moveElement`, sent when the presses stop. Ctrl+Z undoes, and Ctrl+Shift+Z or Ctrl+Y redoes. Enter edits the selected box or cell, Esc clears the selection, and Delete removes the selected box. With a table cell selected, the arrow keys and Tab/Shift+Tab move between cells. While a cell is being edited, Tab saves it and opens the next cell's editor.
- Snapping: a dragged box or table snaps its edges and centre to the page's edges and centre and to those of other boxes and tables (within 5 px). Guide lines show where it snapped. Hold Alt to drag freely. A readout shows the top-left corner in PDF points (or the size while resizing).
- Inspector (right panel): for a box, the font, size, font strategy and its warnings; X/Y/W fields that move or re-wrap the box; text colour, alignment and line spacing (`setTextStyle`). For a table cell: the cell's width and height (`resizeTable`) and the table position.
- Changes: every op is listed with its page. Click an entry to go to the element. ✕ undoes only that change (the list is re-sent without it). If a later change depends on it, for example a move of a box that the removed change added, the server rejects the request and the document stays as it was. *Show on page* outlines changed elements and marks deleted ones in red. Thumbnails show the number of changes per page.
- Table borders: in the *Select* tool, drag a row or column border to resize that row or column. Rows and columns after it shift, and the top-left corner stays fixed.
- `setTextStyle` (`elementId`, `color?`, `align?`, `lineSpacing?` as a multiple of the font size) works on original and added boxes. Original boxes keep their own font and glyph positions within each line. An explicit alignment repositions every line inside the box's width, and line spacing moves the baselines down from the first line.

## Fixtures

`fixtures/generate.ts` builds the sample files deterministically:

| file | content |
|------|---------|
| `latin-standard14.pdf` | Helvetica/Times (standard-14, not embedded), 2 pages |
| `cyrillic-subset.pdf` | Liberation Sans subset (Type0/Identity-H), Cyrillic |
| `turkish-subset.pdf` | Liberation Sans subset, Turkish (ş ı İ ğ ç) |
| `simple-truetype.pdf` | simple TrueType + WinAnsi + /Widths, `Tj`/`'`/`TJ`/`Tc` |
| `scanned.pdf` | image-only page, no text |
| `table.pdf` | bordered table with a header fill and text below it |
| `type1-cff.pdf` | embedded synthetic Type1 (subrs, seac composite) and bare CFF fonts |
| `zebra-table.pdf` | 4 × 5 table: header band with a thicker separator, zebra rows, a merged "Total" row |
| `image-table.pdf` | 3 × 4 table with a picture in a body cell, text, a rule and a logo under it |
| `scanned-table.pdf` | image-only page: a scanned 4-column, 5-row table (grey header row) with text bars above and below |
| `scanned-table-rotated.pdf` | the same page with the scan stored a quarter turn round and placed rotated back |
| `paged-table.pdf` | 2 pages with a running header (text + rule) and a "Page N" footer; page 1 ends with a 4 × 4 table (2 pt outer top/bottom border) and a line under it, page 2 has body text (table paging) |
| `paged-scan.pdf` | one scanned page at 2 px/pt (Flate, grey): header and footer bars, text bars, a bordered 4 × 4 table near the bottom and a bar below it |
| `paged-scan-jpeg.pdf` | the same scan stored as a JPEG (DCTDecode, RGB), like most scanner output |

## License note

All dependencies are MIT/Apache/BSD. mupdf (AGPL) is **not** used.
