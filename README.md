# PDF Toolkit

Merge PDFs and edit them visually, in TypeScript end to end: a web UI, an HTTP API and a command-line merge tool.

## Quick start

Requires Node 20+ and pnpm 9 (`corepack enable` provides it).

```sh
pnpm install         # also installs the bundled fonts (15 free families, ~56 MB)
pnpm fonts           # optional: Liberation + DejaVu into fonts/ (`pnpm fonts --cjk` adds Noto CJK, ~250 MB)
pnpm dev:server      # API on http://localhost:3001
pnpm dev:web         # UI on http://localhost:5173 (proxies /api to the server)
```

Open http://localhost:5173.

### Inside a devbox container

The container has no global `pnpm`, and the root `dev:*` scripts call `pnpm` again, so start the servers directly. Vite has to listen on all interfaces for the forwarded port:

```sh
corepack pnpm install
bash scripts/fetch-fonts.sh                    # optional, as `pnpm fonts` (needs github.com reachable)
(cd apps/server && npx tsx src/main.ts)        # API on :3001
(cd apps/web && npx vite --host 0.0.0.0)       # UI on :5173
```

On the host, forward the ports once (`PORTS=( 3001 5173 )` in `.devbox.conf`, then `devbox restart`) and open http://localhost:5173. Use `corepack pnpm` wherever the examples below say `pnpm`.

## Usage examples

### Web UI

- **Merge files**: in *Merge & Pages*, drop several PDFs, drag pages into order, use a page's hover buttons to rotate it, add a blank page after it, duplicate it or delete it, then *Merge & download*. *Edit result* opens the merged file in the editor.
- **Fix a typo**: in *Edit*, open a PDF, click a text box, click again to edit in place, press Ctrl+Enter, then *Download* (Ctrl+S). The text keeps its font, size and position.
- **Pick a font for new text**: with *Add text*, open the font menu. Besides the PDF's own fonts it lists every installed font (font folder, bundled, system), searchable, with a sample and a licence badge. MIT is green, other free licences are grey, ⚠ marks an unknown or non-free licence, and faces whose licence forbids embedding are crossed out.
- **Add a row to a table**: click a cell, use *+↓* in the toolbar above the table, double-click the new cell and type.
- **Straighten a scan**: open a tilted scan and click *Straighten all* in the banner.

Press `?` in the editor for all keyboard shortcuts.

### Command line

```sh
# All of a.pdf, then pages 1-3 of b.pdf
pnpm pdf-tool merge a.pdf b.pdf:1-3 -o out.pdf

# Page ranges, rotation (@90/@180/@270) and blank pages, in any order
pnpm pdf-tool merge cover.pdf blank scan.pdf:2-4@90 appendix.pdf:5- -o book.pdf

# Encrypted input
pnpm pdf-tool merge secret.pdf --password secret.pdf=hunter2 -o out.pdf

# The same from any directory, with prerequisite checks
scripts/pdf-concat.sh -o out.pdf a.pdf b.pdf:1-3@180 blank c.pdf
```

Ranges look like `1-3,5,8-`, `-2` or `5-3` (reversed).

### HTTP API

```sh
# Merge: the second file's page 2 rotated, a blank page, then all of the first file
curl -F files=@a.pdf -F files=@b.pdf \
  -F 'segments=[{"file":1,"pages":"2","rotate":90},{"blank":true},{"file":0}]' \
  http://localhost:3001/api/merge -o merged.pdf

# Edit: upload, replace the first text box's text, download
curl -s -F file=@a.pdf http://localhost:3001/api/documents -o doc.json
ID=$(jq -r .docId doc.json)
BOX=$(jq -r '.pages[0].textBoxes[0].id' doc.json)
curl -s -H 'content-type: application/json' \
  -d "{\"ops\":[{\"type\":\"replaceText\",\"elementId\":\"$BOX\",\"text\":\"New title\"}]}" \
  http://localhost:3001/api/documents/$ID/edits > /dev/null
curl -s http://localhost:3001/api/documents/$ID/download -o a-edited.pdf
```

## Documentation

- [docs/merge.md](docs/merge.md): merge UI, CLI and API reference, and what a merge keeps
- [docs/editor.md](docs/editor.md): page model, text editing and font strategies, tables, paging, Straighten, editing UI
- [docs/development.md](docs/development.md): tests, typecheck, fixtures, server environment variables, devbox details
- [ARCHITECTURE.md](ARCHITECTURE.md): module boundaries, the edit-operation schema and the font strategy

## License note

All code dependencies are MIT/Apache/BSD. mupdf (AGPL) is **not** used. The bundled fonts (`@expo-google-fonts/*`: Tinos, Arimo, Cousine, Carlito, Caladea, Gelasio, Noto Sans/Serif, Inter, Source Sans 3/Serif 4, IBM Plex Sans/Mono, JetBrains Mono, Roboto) are under the SIL Open Font License 1.1, and `pnpm fonts` adds Liberation (OFL) and DejaVu (Bitstream Vera licence). Both licences allow embedding in PDFs.
