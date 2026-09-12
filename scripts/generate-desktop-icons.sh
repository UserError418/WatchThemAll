#!/usr/bin/env bash
#
# Render every desktop icon from the one committed SVG.
#
#     scripts/generate-desktop-icons.sh
#
# Source of truth is `icons/icon.svg`. Everything beside it is generated and
# committed, so a clone can be packaged without librsvg on the machine doing it.
#
# Sizes are not arbitrary. electron-builder reads `icons/icon512.png` for Linux
# and macOS and `icons/icon.ico` for Windows; `src/main/menu.ts` reads
# `icons/icon48.png` for the tray. 16 and 256 exist because Windows shells pick
# whichever ICO frame matches the display density, and a missing frame is
# resampled from a neighbour — which is how a crisp icon ends up looking soft in
# the taskbar and nowhere else.
#
# Re-run after editing the SVG. Nothing checks that these are in sync, because
# the check would have to render the SVG and would therefore need the same
# tools this script needs.
set -euo pipefail

cd "$(dirname "$0")/.."

SRC=icons/icon.svg
# 120 is not a desktop size. It is what Google's OAuth consent screen wants for
# the app logo, and it is rendered here so that logo is the same mark as
# everything else rather than a one-off somebody exported by hand.
SIZES=(16 48 120 128 256 512)

command -v rsvg-convert >/dev/null || { echo "needs librsvg (rsvg-convert)" >&2; exit 1; }
command -v magick >/dev/null || { echo "needs ImageMagick (magick)" >&2; exit 1; }

for size in "${SIZES[@]}"; do
  rsvg-convert -w "$size" -h "$size" "$SRC" -o "icons/icon${size}.png"
  echo "  icons/icon${size}.png"
done

# The ICO carries several frames in one file. Rendered from the SVG at each size
# rather than downscaled from one PNG: at 16px a downscale turns the rings into
# grey fringing, while a fresh render lets the rasteriser drop them cleanly.
ICO_TMP=$(mktemp -d)
trap 'rm -rf "$ICO_TMP"' EXIT
for size in 16 32 48 64 128 256; do
  rsvg-convert -w "$size" -h "$size" "$SRC" -o "$ICO_TMP/$size.png"
done
magick "$ICO_TMP"/{16,32,48,64,128,256}.png icons/icon.ico
echo "  icons/icon.ico"
