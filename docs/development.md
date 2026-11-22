# Development

## Commands

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

## Inside a devbox container

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
| `scanned-table-skewed.pdf` | the same page scanned 1.5° counter-clockwise (for Straighten) |
| `paged-table.pdf` | 2 pages with a running header (text + rule) and a "Page N" footer; page 1 ends with a 4 × 4 table (2 pt outer top/bottom border) and a line under it, page 2 has body text (table paging) |
| `paged-scan.pdf` | one scanned page at 2 px/pt (Flate, grey): header and footer bars, text bars, a bordered 4 × 4 table near the bottom and a bar below it |
| `paged-scan-jpeg.pdf` | the same scan stored as a JPEG (DCTDecode, RGB), like most scanner output |
