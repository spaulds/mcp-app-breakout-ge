#!/usr/bin/env bash
# Re-fetches and re-compresses the DOOM WebAssembly binary committed at src/game/doom.wasm.gz.
#
# Provenance: https://github.com/diekmann/wasm-fizzbuzz (doom/ subproject) - the original
# linuxdoom-1.10 sources compiled to wasm32 with clang, no emscripten, with the shareware
# doom1.wad linked into the module. The prebuilt binary is published on the project's
# GitHub Pages site. The engine is GPL-2.0; the shareware IWAD is freely redistributable
# but is NOT open source (see README "Licensing").
set -euo pipefail

URL="https://diekmann.github.io/wasm-fizzbuzz/doom/doom.wasm"
EXPECTED_SHA256="568bb18489f9071957f133d7d12ed6d753dfd27a62733442fd80261a217df3f1"
OUT="$(cd "$(dirname "$0")/.." && pwd)/src/game/doom.wasm.gz"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $URL ..."
curl -fsSL -o "$tmp/doom.wasm" "$URL"

actual="$(sha256sum "$tmp/doom.wasm" | cut -d' ' -f1)"
if [[ "$actual" != "$EXPECTED_SHA256" ]]; then
  echo "SHA-256 mismatch!" >&2
  echo "  expected: $EXPECTED_SHA256" >&2
  echo "  actual:   $actual" >&2
  echo "Upstream changed; inspect before updating EXPECTED_SHA256." >&2
  exit 1
fi

gzip -9 -n -c "$tmp/doom.wasm" > "$OUT"
echo "Wrote $OUT ($(stat -c%s "$OUT") bytes)"
