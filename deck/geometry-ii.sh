#!/usr/bin/env bash
# Launch GEOMETRY II full screen. This is what the Steam shortcut runs, and it
# works the same from a desktop launcher or a terminal, on SteamOS or on a Mac.
#
# The browser is whatever browser.sh finds: the Chromium flatpak on a Deck, an
# installed Chromium-based browser anywhere else.
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

# shellcheck source=deck/browser.sh
. "$HERE/browser.sh"

# Paths are derived from where this script sits, so say so plainly if it has been
# copied out of the game's deck/ folder rather than failing later on a mkdir.
if [ -z "${GEOMETRY_URL:-}" ] && [ ! -f "$GAME_DIR/index.html" ]; then
  echo "No index.html in $GAME_DIR." >&2
  echo "Keep this script in the game's deck/ folder, or set GEOMETRY_URL." >&2
  exit 1
fi

URL="${GEOMETRY_URL:-file://$GAME_DIR/index.html}"

# What the game is asked for: ?fullscreen strips the page frame and the help line so
# the canvas owns the screen, and ?sound starts with audio on, which the autoplay
# flag below is what actually permits. A URL already carrying one is left alone.
for option in fullscreen sound; do
  case "$URL" in
  *"$option"*) ;;
  *\?*) URL="$URL&$option" ;;
  *) URL="$URL?$option" ;;
  esac
done

# A profile beside the game keeps the high score across launches. Chromium wants
# a real directory it can write to; a throwaway one loses the score every time,
# and /dev/null is not a directory at all.
PROFILE="${GEOMETRY_PROFILE:-$GAME_DIR/.chromium-profile}"
mkdir -p "$PROFILE"

CHROME_FLAGS=(
  --user-data-dir="$PROFILE"
  --allow-file-access-from-files
  --start-fullscreen
  --ignore-gpu-blocklist
  --autoplay-policy=no-user-gesture-required
  --no-first-run
  --no-default-browser-check
  --noerrdialogs
  --disable-session-crashed-bubble
  --disable-features=HardwareMediaKeyHandling
)

if ! geometry_find_browser; then
  geometry_no_browser_message "$0"
  exit 1
fi

# Closing the game window does not necessarily end the browser: on macOS an app with
# no windows keeps running, so this script would never return and Steam would go on
# showing the game as running for the rest of the session.
#
# So the browser is supervised rather than exec'd. --remote-debugging-port=0 makes it
# pick a free port and write it into DevToolsActivePort in its own profile, which is
# then asked how many pages are open. No pages means the game has been closed, from
# its own Exit or by the window being shut, and this exits with it.
#
# Without curl there is nothing to ask, so fall back to handing the process over and
# accept that quitting may not be noticed.
PORT_FILE="$PROFILE/DevToolsActivePort"
rm -f "$PORT_FILE"

if ! command -v curl >/dev/null; then
  exec "${BROWSER_ARGV[@]}" --app="$URL" "${CHROME_FLAGS[@]}" "$@"
fi

"${BROWSER_ARGV[@]}" --app="$URL" --remote-debugging-port=0 "${CHROME_FLAGS[@]}" "$@" &
BROWSER_PID=$!

# tidy up if this script is killed rather than the game being quit
# `|| true` matters: a failing last command in an EXIT trap becomes the script's own
# status in bash, and a non-zero exit is what Steam reports as a crash.
trap 'kill "$BROWSER_PID" 2>/dev/null || true' EXIT INT TERM

# wait for the port to be written, then watch the page count
PORT=""
for _ in $(seq 1 60); do
  if [ -s "$PORT_FILE" ]; then
    PORT="$(head -n 1 "$PORT_FILE")"
    break
  fi
  kill -0 "$BROWSER_PID" 2>/dev/null || exit 0
  sleep 0.25
done

if [ -z "$PORT" ]; then
  # never came up; nothing to supervise, so just wait on the browser
  wait "$BROWSER_PID"
  exit $?
fi

while kill -0 "$BROWSER_PID" 2>/dev/null; do
  sleep 1
  pages="$(curl -s --max-time 2 "http://127.0.0.1:$PORT/json/list" |
    grep -c '"type": *"page"' || true)"
  # An empty answer means the browser is going away on its own; only a definite
  # zero pages counts as the game having been closed.
  if [ "${pages:-1}" = "0" ]; then
    kill "$BROWSER_PID" 2>/dev/null
    break
  fi
done
wait "$BROWSER_PID" 2>/dev/null
exit 0

