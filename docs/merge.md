# Merge

- **UI**: in the *Merge & Pages* tab, drop PDFs, zips or folders (or use *Add PDFs* / *Add folder*; folders are read recursively and other files skipped; the PDFs inside a zip are added too, all in natural order of their paths: file1, file02, file10), drag page thumbnails to reorder them (also across files), and use a page's hover buttons to rotate it (↻, 90° clockwise), insert a blank page after it (+, sized like the page shown before it), duplicate it (⧉) or remove it (×). *Undo* (Ctrl+Z) takes back the last change, one at a time (up to 50). Then *Merge & download* (saved as `<first file>-merged.pdf`, named after the file of the first page), or *Edit result* to open the result in the editor. The editor's *Open in Merge & Pages* sends a copy of the current edited PDF here, to combine it with other files; its edits are kept but can no longer be undone one by one (page order, rotation and blank pages can also be changed in the editor's page list, with undo). Password-protected files ask for the password.
- **CLI**: `pnpm pdf-tool merge a.pdf b.pdf:1-3 -o out.pdf` (ranges like `1-3,5,8-`, `-2`, `5-3`). Append `@90`, `@180` or `@270` to rotate an input's pages (`scan.pdf:2-4@90`), use the word `blank` for an empty page the size of the page before it, and `copy` or `copy:<n>` for a copy of the page before it or of output page n (`form.pdf:1 copy copy:1` gives three pages). A copy shares content, fonts and images with its source, like the editor's ⧉, so a copied scan doesn't store the image twice. For encrypted inputs: `--password a.pdf=secret`. `scripts/pdf-concat.sh` wraps the same command for use from any directory (it checks Node/pnpm, installs dependencies when missing and resolves relative paths).
- **API**: `POST /api/merge`, multipart:
  - `files`: one or more PDFs, in order
  - `ranges` (optional): JSON array aligned with `files`, e.g. `["", "1-3"]`
  - `passwords` (optional): JSON array aligned with `files`
  - `segments` (optional): JSON `[{"file":1,"pages":"2","rotate":90},{"blank":true},{"file":0}]` for any page order across files. `rotate` (0/90/180/270) is added to each page's rotation, `{"blank":true}` inserts an empty page the size of the page shown before it, and `{"copy":n}` repeats output page n (0-based; negative counts back, -1 = the page before), sharing its content, fonts and images. It overrides `ranges`.

  Returns `application/pdf`. Errors are JSON `{ error: { code, message } }`. Codes: `INVALID_RANGE`, `INVALID_PDF`, `ENCRYPTED` (password needed), `BAD_PASSWORD`, `UNSUPPORTED_ENCRYPTION`, `NOT_PDF`, `TOO_LARGE`.

What merge keeps:
- Page size, rotation and inherited page attributes.
- Annotations. Internal links are re-pointed to the merged pages. Links to pages that weren't included are removed.
- Bookmarks: each source file becomes a top-level bookmark, and the file's own outline is nested under it.
- AcroForm fields. Colliding names are renamed (`name`, `name_2`). `/DR` resources are merged.
- Encrypted inputs: the standard security handler is supported (RC4 40/128, AES-128, AES-256 R5/R6), with either the user or the owner password. Files that only have an owner password open without asking. Public-key security handlers return `UNSUPPORTED_ENCRYPTION`.

Known merge limitations: the tagged-PDF structure tree, named destinations from the sources (they are resolved into explicit destinations on links and bookmarks), and document-level JavaScript aren't carried over.
