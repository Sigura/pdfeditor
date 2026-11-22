#!/usr/bin/env bash
# Downloads free fonts that are not on npm into fonts/ (searched first by the server):
#   Liberation 2.1.5 (Arial/Times New Roman/Courier New metrics, OFL), DejaVu 2.37 (Bitstream Vera licence),
#   and with --cjk Noto Sans/Serif CJK (OFL, ~250 MB download, .ttc collections).
# Usage: scripts/fetch-fonts.sh [--cjk]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/fonts"
CJK=0
for a in "$@"; do
  case "$a" in
    --cjk) CJK=1 ;;
    *) echo "Usage: $0 [--cjk]" >&2; exit 2 ;;
  esac
done

echo "== Checking prerequisites"
for t in curl tar; do command -v "$t" >/dev/null || { echo "$t not found" >&2; exit 1; }; done
[[ $CJK == 0 ]] || command -v unzip >/dev/null || { echo "unzip not found (needed for --cjk)" >&2; exit 1; }
if command -v sha256sum >/dev/null; then SHA=(sha256sum); elif command -v shasum >/dev/null; then SHA=(shasum -a 256); else echo "sha256sum/shasum not found" >&2; exit 1; fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# fetch <name> <url> <sha256> <archive file>: downloads, checks the hash, extracts font and licence files into fonts/<name>/.
fetch() {
  local name="$1" url="$2" sum="$3" file="$TMP/$4"
  if [[ -d "$DEST/$name" ]]; then echo "== $name: already in fonts/$name, skipping"; return; fi
  echo "== $name: downloading $url"
  curl -fsSL --retry 3 -o "$file" "$url"
  echo "$sum  $file" | "${SHA[@]}" -c --quiet - || { echo "$name: checksum mismatch" >&2; exit 1; }
  mkdir -p "$TMP/x-$name"
  case "$file" in
    *.zip) unzip -q "$file" -d "$TMP/x-$name" ;;
    *) tar -xf "$file" -C "$TMP/x-$name" ;;
  esac
  mkdir -p "$DEST/$name"
  find "$TMP/x-$name" -type f \( -iname '*.ttf' -o -iname '*.otf' -o -iname '*.ttc' -o -iname '*.otc' -o -iname 'LICENSE*' -o -iname 'OFL*' -o -iname 'COPYING*' \) \
    -exec cp {} "$DEST/$name/" \;
  echo "   $(find "$DEST/$name" -type f | wc -l | tr -d ' ') files in fonts/$name"
}

fetch liberation https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz \
  7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0 liberation.tar.gz
fetch dejavu https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.tar.bz2 \
  fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7 dejavu.tar.bz2
if [[ $CJK == 1 ]]; then
  fetch noto-sans-cjk https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/03_NotoSansCJK-OTC.zip \
    528f4e1b25ff3badb0321b38d015d954c4c0de926c7830ef50e4a1948f6a3eed noto-sans-cjk.zip
  fetch noto-serif-cjk https://github.com/notofonts/noto-cjk/releases/download/Serif2.003/04_NotoSerifCJKOTC.zip \
    c76ed8fd491ce98182ec6430238b90a1eabea8857c7db64e9037efa38e198a31 noto-serif-cjk.zip
fi
echo "== Done. Restart the server to pick the fonts up."
