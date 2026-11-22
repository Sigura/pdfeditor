# Tables — grid setup and structured editing (user spec, Telegram 2026-11-21)

Pseudo code and models are examples, not binding.

## Background
PDFs have no table object: a "table" is loose vector lines/rectangles, text runs and sometimes images
(or one raster image for scanned documents). So the user maps a grid onto the table once in a setup.
After that, all edits go through a structured table model that reproduces the original look.

## Grid setup: Step 1 (parameters)
The user selects Table tool → drag a rectangle around the table (or clicks a detected-table suggestion).
A small dialog asks for:
- Columns (default from detection), Rows (default from detection)
- Border width in pt (default from detected line widths; for raster tables, in px measured from the image)
- Header rows (default 1)

Then the double-bordered mesh is drawn over the table:

```
  ●═══════════●═══════════●═══════════●      ● = vertex (draggable handle, sits on the cell corner)
  ║ ┌───────┐ ║ ┌───────┐ ║ ┌───────┐ ║      ═ ║ = border BAND: two parallel lines, distance =
  ║ │ cell  │ ║ │ cell  │ ║ │ cell  │ ║            border width; the band must cover the real border
  ║ └───────┘ ║ └───────┘ ║ └───────┘ ║      inner box = cell content area (what is editable)
  ●═══════════●═══════════●═══════════●
  ║ ┌───────┐ ║ ┌───────────────────┐ ║      ← merged cell (2 columns) after Step 2
  ║ │ cell  │ ║ │ cell              │ ║
  ║ └───────┘ ║ └───────────────────┘ ║
  ●═══════════●═══════════════════════●
```

The mesh starts evenly spaced inside the selected rectangle. If detection found junctions, it starts snapped to them.

## Grid setup: Step 2 (vertex alignment)
- Every vertex is independently draggable (not whole lines). This supports uneven rows and slightly skewed or scanned tables.
- Every vertex must sit on a real cell corner of the original table (the center of the border junction).
  - Snap targets: intersections of detected vector segments; for raster tables, junctions found by
    morphological line detection (horizontal/vertical opening + intersection) on the rendered image.
  - A vertex is green when snapped to a junction and yellow when placed manually off any detected junction. Confirm is allowed but shows a warning listing yellow vertices.
  - Hold Alt to disable snapping; arrow keys nudge by 0.25 pt (Shift = 2 pt).
- Band check: the app checks that the band between the two lines covers the real border pixels/segments along each edge. Edges that don't match are drawn red (fix: adjust border width or vertices).
- Merge / split: select cells → Merge removes the inner vertices and edges; Split adds them back. Rows may have different cell layouts, e.g. a "Total" row spanning 3 columns.
- Toolbar: + Row, − Row, + Col, − Col (re-runs Step 1 counts, keeping already placed vertices), Reset, Confirm.
- Content preview: text runs/images are tinted by the cell they will belong to. Anything crossing a band or lying outside all cells is outlined red.

## Data model created on Confirm
```ts
type Vertex = { id: string; x: number; y: number; snapped: boolean };
type TableModel = {
  id: string; pageIndex: number;
  vertices: Vertex[][];                 // (rows+1) × (cols+1); merged cells hide inner vertices
  borderWidth: number;
  cells: Cell[];                        // each cell = 4 corner vertex ids + span
  headerRows: number;
  origin: 'vector' | 'raster' | 'mixed';
  pattern: BorderPattern;
};
type Cell = {
  row: number; col: number; rowSpan: number; colSpan: number;
  corners: [tl: string, tr: string, br: string, bl: string];
  padding: { top: number; right: number; bottom: number; left: number };      // measured from original
  align: { h: 'left'|'center'|'right'|'justify'; v: 'top'|'middle'|'bottom'; baselineOffset: number };
  fill: RGB | RasterTile | null;
  content: CellContent[];
};
type CellContent =
  | { kind: 'text'; runIds: string[]; fontRef: string; fontSize: number; color: RGB; lineHeight: number }
  | { kind: 'image'; xobjectRef: string; width: number; height: number; offset: Point };  // original size, never rescaled
```

## Border pattern (why the borders are doubled and vertices must be aligned)
On Confirm, extract the original border look from inside the bands, so it can be reproduced:
- Cut the bands into pattern pieces at the vertices:
  - Junctions: cornerTL/TR/BL/BR, teeTop/Bottom/Left/Right, cross
  - Edges: horizontal and vertical segments, keyed by position: outerTop, headerSeparator, bodyRow, outerBottom, outerLeft, innerVertical, outerRight
  - Row fills: per body row, to detect zebra striping (period 1, 2, …)
- Vector origin: each piece = the cloned content-stream operators (paths, stroke width, color, dash, double lines), stored relative to the vertex/edge start. Edges are stored as stretchable: the path is re-generated to the new length with the same style.
- Raster origin: each piece = an image tile cropped from the page image at full resolution. Edges stretch by tiling (repeat) along their length, never by scaling across the thickness. Junction tiles are used as they are.
- Vertices aligned exactly to the junctions are what make clean junction tiles possible. If a vertex is off, the pattern piece is flagged and the nearest good piece of the same type is used instead.

## Editing after setup (same table logic for every operation)
General rules:
- Font size never changes automatically. No auto-shrink to fit. When text grows, wrap within the cell width and grow the row height. The column width stays fixed unless the user drags it.
- Keep each cell's original horizontal/vertical alignment, padding, baseline offset, color and font (font chain from 2.2).
- Image content keeps its original size (no resampling, no scaling). It is positioned by the cell's original alignment and offset. If a cell is resized smaller than its image, block the change and show the minimum size.
- Every cell is editable: click a cell to edit text; in an empty cell, the text style of the column (or row template) is used.
- Every operation is one undo step and regenerates the table from the model + pattern (the original table operators/pixels for the region are removed, see 2.2 "true removal").

Operations:
- Add row (above/below): the new row copies the template row: same cell layout and spans, padding, alignment, column text styles, the next zebra fill in sequence, and border pieces from the pattern (bodyRow edges, matching junction types). Its height = the template row's height. Cells are empty.
- Remove row: delete its content and its border pieces. Rejoin the neighbors with the correct junction types (e.g. if the last body row is removed, the row above gets the outerBottom edge and bottom corners).
- Add/remove column: same logic vertically; the table width changes. If the table no longer fits the page, warn and offer: shrink the other columns proportionally (text wraps, font size unchanged) or cancel.
- Row height growth (from text edits or adding rows): shift all page content below the table down by the delta. If it exceeds the page bottom: warn with "exceeds by N pt" and allow cancel or overflow (continuing on a new page comes in a later phase).
- Raster origin tables: cell text from a scan can't be re-typeset. Editing a raster cell replaces the cell's image area with a cleaned cell background (fill from pattern) plus new text in the detected/closest font (2.2 chain). Untouched raster cells move as image crops at the original size.

## Acceptance criteria
- 4×5 bordered vector table: Step 1 with detected defaults, all vertices snap green; add 2 rows and remove 1 → borders, header separator, zebra fills and outer corners look identical to the original style (visual diff within tolerance).
- Text edit with a long value: font size unchanged, row grows, content below shifts by the same delta.
- Cell with an image: after adding rows above it, the image is pixel-identical and keeps its original size and alignment.
- Scanned (raster) table: rows added using raster pattern tiles; edges tile without visible seams.
- Merged "Total" row survives row add/remove above it.
- Save → reopen → the stored TableModel still matches the page (vertices within ±1 pt).
