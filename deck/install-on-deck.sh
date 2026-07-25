#!/usr/bin/env bash
# One-time setup to put GEOMETRY II in the Steam library.
#
# Written for a Steam Deck, run once from Desktop Mode, after which the game
# appears in Steam and launches into Game Mode like anything else. It also works on
# a Mac or an ordinary Linux desktop, because the only Linux-specific parts are the
# flatpak and the desktop entry, and both are skipped where they mean nothing.
#
#   * find a browser to run the game in (see browser.sh)
#   * on Linux, grant the Chromium flatpak access to this folder
#   * on Linux, write a desktop entry pointing at geometry-ii.sh
#   * create the Steam shortcut and attach its artwork, in one pass
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GAME_DIR="$(cd -- "$HERE/.." && pwd)"
PLATFORM="$(uname -s)"

# shellcheck source=deck/browser.sh
. "$HERE/browser.sh"
LAUNCHER="$HERE/geometry-ii.sh"
FLATPAK_ID="org.chromium.Chromium"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_FILE="$DESKTOP_DIR/geometry-ii.desktop"
ICON="$HERE/steam-art/icon.png"
ART_INSTALLER="$HERE/install-steam-art.py"

say() { printf '  %s\n' "$*"; }
die() {
  printf '\nStopped: %s\n' "$*" >&2
  exit 1
}

echo "GEOMETRY II -> Steam"
say "game files: $GAME_DIR"

[ -f "$GAME_DIR/index.html" ] || die "no index.html beside this script; run it from the game's deck/ folder."
[ -x "$LAUNCHER" ] || chmod +x "$LAUNCHER"

# ---- a browser ------------------------------------------------------------
# On Linux, offer to install the flatpak, since that is the build this was tested
# against and it is the one thing a fresh Deck is likely to be missing.
if ! geometry_find_browser && [ "$PLATFORM" = Linux ] && command -v flatpak >/dev/null; then
  say "installing org.chromium.Chromium from flathub (this needs the network)"
  flatpak install --user -y flathub org.chromium.Chromium || true
  geometry_find_browser || true
fi
if [ ${#BROWSER_ARGV[@]} -eq 0 ]; then
  geometry_no_browser_message "$0"
  exit 1
fi
say "browser: $(geometry_browser_name)"

# The flatpak is sandboxed and cannot see arbitrary paths. This grants it read and
# write access to the game folder only, which covers both the page it loads and the
# browser profile the high score lives in. Nothing else needs it.
if [ "${BROWSER_ARGV[0]}" = /usr/bin/flatpak ]; then
  flatpak override --user --filesystem="$GAME_DIR" org.chromium.Chromium
  say "granted the flatpak access to $GAME_DIR"
fi

mkdir -p "$GAME_DIR/.chromium-profile"

# ---- desktop entry --------------------------------------------------------
# Linux only: it is what steamos-add-to-steam consumes, and what gives the game an
# icon in the applications menu. A Mac has no use for one.
if [ "$PLATFORM" = Linux ]; then
  mkdir -p "$DESKTOP_DIR"
  {
    echo "[Desktop Entry]"
    echo "Type=Application"
    echo "Name=GEOMETRY II"
    echo "Comment=Slice asteroids, mine ore, mind your shields"
    echo "Exec=$LAUNCHER"
    echo "Path=$GAME_DIR"
    echo "Terminal=false"
    echo "Categories=Game;ArcadeGame;"
    echo "StartupWMClass=chromium"
    # captured from the game by tools/capture-steam-art.mjs; Steam picks this up
    # as the shortcut's icon when the entry is added
    [ -f "$ICON" ] && echo "Icon=$ICON"
  } > "$DESKTOP_FILE"
  chmod +x "$DESKTOP_FILE"
  say "desktop entry: $DESKTOP_FILE"
  command -v update-desktop-database >/dev/null &&
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
fi

# ---- add to Steam, with its artwork -----------------------------------------
# Everything above is safe to repeat: the override, the profile and the desktop
# entry are all written in place.
#
# The Steam side is one job, not two, because the artwork can only be attached once
# the shortcut exists on disk. install-steam-art.py therefore does both: it creates
# the shortcut if there is not one, reads the appid back out, and copies the art in
# beside it. Handing the entry to Steam instead means Steam holds it in memory until
# it exits, and the artwork has nowhere to go until then, which is what made a first
# install take two passes.
#
# It needs Steam closed, since Steam rewrites that file on the way out.
steam_step_done=false
if [ -f "$ART_INSTALLER" ] && command -v python3 >/dev/null; then
  echo
  echo "Steam:"
  if python3 "$ART_INSTALLER" \
    --launcher "$LAUNCHER" --art "$HERE/steam-art" --add-if-missing; then
    steam_step_done=true
  fi
fi

if [ "$steam_step_done" = true ]; then
  echo
  if pgrep -x steam >/dev/null 2>&1; then
    echo "Done. Restart Steam to see it."
  else
    echo "Done. Start Steam and GEOMETRY II will be in your library, artwork and all."
  fi
elif pgrep -x steam >/dev/null 2>&1; then
  # Steam is up, so its files cannot be written underneath it. Adding through Steam
  # itself still works, and the artwork can be attached once it closes.
  if command -v steamos-add-to-steam >/dev/null && [ -f "$DESKTOP_FILE" ]; then
    say "Steam is running, so adding the shortcut through Steam instead."
    steamos-add-to-steam "$DESKTOP_FILE" || die "steamos-add-to-steam refused the entry."
    echo
    echo "Added, without artwork. Close Steam and run this again to attach it."
  else
    echo
    echo "Close Steam and run this again; it cannot write Steam's files underneath it."
  fi
else
  echo
  echo "Could not finish the Steam step. Add it by hand:"
  [ -f "$DESKTOP_FILE" ] &&
    echo "  * in Dolphin, right-click $DESKTOP_FILE and pick \"Add to Steam\""
  echo "  * or in Steam: Games -> Add a Non-Steam Game -> Browse -> $LAUNCHER"
  [ -f "$ART_INSTALLER" ] || say "install-steam-art.py is missing, so artwork was skipped."
  command -v python3 >/dev/null || say "python3 is missing, so artwork was skipped."
fi

if [ "$PLATFORM" = Linux ]; then
  cat <<'DECK'

On a Deck:
  * Set the controller layout to a Gamepad template, not Desktop, or the sticks
    arrive as a mouse and nothing steers.
  * Sound starts off. Click SND once with the right trackpad; the game only opens
    its audio device on a real click, which a gamepad press is not.
DECK
fi

cat <<'NOTES'

Worth knowing:
  * The high score lives in .chromium-profile beside the game files. Delete that
    folder to reset it.
  * Library artwork comes from deck/steam-art/ and is attached above. Steam reads
    it from its own folder, so it only changes when install-steam-art.py runs;
    re-run that after regenerating the art.
  * Re-running this is safe: it refreshes everything in place and will not add a
    second copy. Close Steam first, because it rewrites its shortcut file on exit,
    and because the shortcut and its artwork go in together in one pass.
  * To run the hosted build instead of these files, set GEOMETRY_URL in the
    Steam shortcut's launch options:
      GEOMETRY_URL=https://gadgetoid.github.io/geometry/ %command%
NOTES
