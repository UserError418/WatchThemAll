#!/usr/bin/env bash
#
# Render the Android launcher icons and the splash from the two committed SVGs.
#
#     scripts/generate-android-icons.sh
#
# Why a script and not `@capacitor/assets`: that tool wants `sharp`, whose
# native ABI is the reason `node` is pinned on this machine, and it regenerates
# from a PNG — so the source of truth would be a bitmap nobody can edit. Here
# the source is `mobile/assets/*.svg`, and `rsvg-convert` is already installed.
#
# Re-run after editing either SVG. The output is committed, because a build
# should not need librsvg on every machine that clones this.
#
set -euo pipefail

cd "$(dirname "$0")/.."
RES=mobile/android/app/src/main/res
FG=mobile/assets/icon-foreground.svg
FULL=mobile/assets/icon-full.svg

command -v rsvg-convert >/dev/null || { echo "needs librsvg (rsvg-convert)"; exit 1; }
command -v magick >/dev/null || { echo "needs ImageMagick (magick)"; exit 1; }

# Launcher icon sizes per density, and the adaptive foreground's own canvas,
# which is 108dp against the icon's 48dp — hence 2.25x each.
render() {
  local density=$1 icon=$2
  local fg=$(( icon * 225 / 100 ))
  local dir="$RES/mipmap-$density"
  mkdir -p "$dir"

  rsvg-convert -w "$fg"   -h "$fg"   "$FG"   -o "$dir/ic_launcher_foreground.png"
  rsvg-convert -w "$icon" -h "$icon" "$FULL" -o "$dir/ic_launcher.png"

  # The round variant is the same art masked to a circle. Launchers that ask
  # for it are pre-adaptive-icon, so nothing else will round it for us.
  #
  # `exclude-chunk=date,time` because ImageMagick otherwise stamps the file with
  # the moment it ran, so re-running the script produced five pixel-identical
  # PNGs that git reported as changed — noise that trains a reader to skip an
  # icon diff, which is where a real change would then hide. Both names are
  # needed: `time` drops the tIME chunk, `date` the tEXt ones beside it, and
  # excluding only one leaves the file just as unreproducible.
  magick "$dir/ic_launcher.png" \
    \( -size "${icon}x${icon}" xc:none -fill white \
       -draw "circle $((icon/2)),$((icon/2)) $((icon/2)),0" \) \
    -alpha set -compose DstIn -composite \
    -define png:exclude-chunk=date,time "$dir/ic_launcher_round.png"
}

render mdpi 48
render hdpi 72
render xhdpi 96
render xxhdpi 144
render xxxhdpi 192

# The Android 12+ splash screen draws this centred on a solid colour and masks
# it to a circle, keeping only the middle 2/3 — so it takes the *foreground*
# art, which is already drawn for exactly that crop, not the composed square.
rsvg-convert -w 960 -h 960 "$FG" -o "$RES/drawable/splash_icon.png"

# Capacitor's template also ships `splash.png` in ten density-and-orientation
# folders, for the old "stretch one bitmap across the window" approach. Those
# were deleted rather than regenerated: styles.xml uses the splash-screen API
# now, so nothing reads them, and ten stale copies of a logo are exactly the
# thing someone re-wires by accident.

echo "icons written to $RES"
