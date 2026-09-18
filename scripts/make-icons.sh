#!/usr/bin/env bash
# Rasterise build/icon.svg into everything electron-builder needs.
#
#   ./scripts/make-icons.sh
#
# Requires rsvg-convert and ImageMagick; iconutil (macOS) for the .icns. On a machine without
# iconutil the .icns step is skipped and the committed one is left alone, so Linux and Windows
# contributors can still regenerate their own targets.
#
# Outputs (all committed, so CI never needs these tools):
#   build/icon.png     1024px master, also electron-builder's generic fallback
#   build/icon.icns    macOS
#   build/icon.ico     Windows
#   build/icons/*.png  Linux — electron-builder picks the size it needs from the directory

set -euo pipefail
cd "$(dirname "$0")/.."

SRC=build/icon.svg
[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }

command -v rsvg-convert >/dev/null || { echo "need rsvg-convert (brew install librsvg)" >&2; exit 1; }
command -v magick >/dev/null || { echo "need ImageMagick (brew install imagemagick)" >&2; exit 1; }

render() { rsvg-convert -w "$1" -h "$1" "$SRC" -o "$2"; }

echo "==> master"
render 1024 build/icon.png

echo "==> linux"
mkdir -p build/icons
for s in 16 24 32 48 64 128 256 512 1024; do
  render "$s" "build/icons/${s}x${s}.png"
done

echo "==> windows"
# One .ico holding every size Windows actually asks for: 16 in the title bar, 32 in the taskbar,
# 48 in Explorer, 256 for the installer and large tiles.
tmp=$(mktemp -d)
for s in 16 24 32 48 64 128 256; do render "$s" "$tmp/$s.png"; done
magick "$tmp"/16.png "$tmp"/24.png "$tmp"/32.png "$tmp"/48.png \
       "$tmp"/64.png "$tmp"/128.png "$tmp"/256.png build/icon.ico
rm -rf "$tmp"

if command -v iconutil >/dev/null; then
  echo "==> macos"
  set=$(mktemp -d)/icon.iconset
  mkdir -p "$set"
  # Apple's required set. The @2x files are genuinely re-rendered from vector rather than
  # upscaled, which is the whole point of keeping the SVG as the source.
  render 16   "$set/icon_16x16.png"
  render 32   "$set/icon_16x16@2x.png"
  render 32   "$set/icon_32x32.png"
  render 64   "$set/icon_32x32@2x.png"
  render 128  "$set/icon_128x128.png"
  render 256  "$set/icon_128x128@2x.png"
  render 256  "$set/icon_256x256.png"
  render 512  "$set/icon_256x256@2x.png"
  render 512  "$set/icon_512x512.png"
  render 1024 "$set/icon_512x512@2x.png"
  iconutil -c icns "$set" -o build/icon.icns
  rm -rf "$(dirname "$set")"
else
  echo "==> macos: iconutil not present, leaving build/icon.icns as-is"
fi

echo
ls -lh build/icon.png build/icon.ico build/icon.icns 2>/dev/null | awk '{print "  " $5, $9}'
echo "  $(ls build/icons | wc -l | tr -d ' ') linux sizes"
