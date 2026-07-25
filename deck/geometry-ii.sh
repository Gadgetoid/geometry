#!/usr/bin/env bash
# Launch GEOMETRY II full screen in the Chromium flatpak. This is what the Steam
# shortcut runs, and it works the same from a desktop launcher or a terminal.
#
# The game is vanilla ES modules, and a module script is subject to CORS even
# over file://, so --allow-file-access-from-files is not optional: without it
# Chromium refuses to load src/main.js and the screen stays black.
#
# GEOMETRY_URL overrides the page, so the same shortcut can point at the hosted
# build instead of these files:
#   GEOMETRY_URL=https://gadgetoid.github.io/geometry/ ./geometry-ii.sh
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GAME_DIR="$(cd -- "$HERE/.." && pwd)"

# Paths are derived from where this script sits, so say so plainly if it has been
# copied out of the game's deck/ folder rather than failing later on a mkdir.
if [ -z "${GEOMETRY_URL:-}" ] && [ ! -f "$GAME_DIR/index.html" ]; then
  echo "No index.html in $GAME_DIR." >&2
  echo "Keep this script in the game's deck/ folder, or set GEOMETRY_URL." >&2
  exit 1
fi

URL="${GEOMETRY_URL:-file://$GAME_DIR/index.html}"

# ?fullscreen strips the page frame and the help line, so the canvas owns the
# screen. Respect a URL that already asks for it, or already has a query string.
case "$URL" in
*fullscreen*) ;;
*\?*) URL="$URL&fullscreen" ;;
*) URL="$URL?fullscreen" ;;
esac

# A profile beside the game keeps the high score across launches. Chromium wants
# a real directory it can write to; a throwaway one loses the score every time,
# and /dev/null is not a directory at all.
PROFILE="${GEOMETRY_PROFILE:-$GAME_DIR/.chromium-profile}"
mkdir -p "$PROFILE"

exec /usr/bin/flatpak run \
  --branch=stable \
  --arch=x86_64 \
  --command=/app/bin/chromium \
  org.chromium.Chromium \
  --app="$URL" \
  --user-data-dir="$PROFILE" \
  --allow-file-access-from-files \
  --start-fullscreen \
  --ignore-gpu-blocklist \
  --autoplay-policy=no-user-gesture-required \
  --no-first-run \
  --no-default-browser-check \
  --noerrdialogs \
  --disable-session-crashed-bubble \
  --disable-features=HardwareMediaKeyHandling \
  "$@"
