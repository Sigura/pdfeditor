#!/usr/bin/env bash
# Concatenate PDFs from the shell: scripts/pdf-concat.sh -o out.pdf a.pdf b.pdf:1-3@90 blank c.pdf
# Inputs and flags are those of `pdf-tool merge`; run without arguments for its help.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  echo "Usage: $0 -o <out.pdf> <input>... [--password <file>=<pw>]..." >&2
  echo "  input: <file>[:<ranges>][@90|@180|@270], 'blank' for an empty page," >&2
  echo "         or 'copy' / 'copy:<n>' for a copy of the page before / of output page n" >&2
  echo "  e.g.   $0 -o out.pdf a.pdf b.pdf:1-3 scan.pdf@90 blank c.pdf:2-" >&2
  exit 2
}
[[ $# -gt 0 ]] || usage

echo "== Checking prerequisites"
command -v node >/dev/null || { echo "node not found (Node 20+ is required)" >&2; exit 1; }
if command -v pnpm >/dev/null; then PNPM=(pnpm)
elif command -v corepack >/dev/null; then PNPM=(corepack pnpm)
else echo "neither pnpm nor corepack found" >&2; exit 1; fi
if [[ ! -d "$ROOT/node_modules" ]]; then
  echo "== Installing dependencies"
  "${PNPM[@]}" --dir "$ROOT" install
fi

# pnpm runs the script from the repo root, so paths are made absolute first.
abs() { [[ "$1" = /* ]] && echo "$1" || echo "$PWD/$1"; }
args=()
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output) [[ $# -ge 2 ]] || usage; out="$(abs "$2")"; args+=(-o "$out"); shift 2 ;;
    --password)
      [[ $# -ge 2 && "$2" == *=* ]] || usage
      args+=(--password "$(abs "${2%%=*}")=${2#*=}"); shift 2 ;;
    -h|--help) usage ;;
    blank|copy|copy:[0-9]*) args+=("$1"); shift ;;
    *)
      file="$1"
      [[ "$file" =~ ^(.+)@(90|180|270)$ ]] && file="${BASH_REMATCH[1]}"
      [[ "$file" =~ ^(.*):([0-9[:space:],-]+)$ && -n "${BASH_REMATCH[1]}" ]] && file="${BASH_REMATCH[1]}"
      [[ -f "$file" ]] || { echo "input not found: $file" >&2; exit 1; }
      args+=("$(abs "$file")${1#"$file"}"); shift ;;
  esac
done
[[ -n "$out" ]] || { echo "missing -o <out.pdf>" >&2; usage; }

echo "== Merging into $out"
"${PNPM[@]}" --silent --dir "$ROOT" pdf-tool merge "${args[@]}"
