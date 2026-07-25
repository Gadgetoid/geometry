#!/usr/bin/env bash
# One-time setup to put GEOMETRY II in the Steam library on a Steam Deck.
#
# Run this once from Desktop Mode, then the game appears in Steam and launches
# straight into Game Mode. It does four things:
#   * checks the Chromium flatpak is installed
#   * grants that flatpak access to this folder (for the page and the profile)
#   * writes a desktop entry pointing at geometry-ii.sh
#   * adds that entry to Steam as a non-Steam game
#
# Nothing here is Deck-specific beyond the Steam step, so it also works on any
# desktop running the same flatpak.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GAME_DIR="$(cd -- "$HERE/.." && pwd)"
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

# ---- the Chromium flatpak -------------------------------------------------
command -v flatpak >/dev/null || die "flatpak is not installed."
if ! flatpak info "$FLATPAK_ID" >/dev/null 2>&1; then
  say "$FLATPAK_ID is not installed. Installing from flathub (this needs the network)."
  flatpak install --user -y flathub "$FLATPAK_ID" ||
    die "could not install $FLATPAK_ID. Install it from Discover, then run this again."
fi
say "flatpak: $(flatpak info "$FLATPAK_ID" --show-ref 2>/dev/null || echo "$FLATPAK_ID")"

# The flatpak is sandboxed and cannot see arbitrary paths. This grants it read
# and write access to the game folder only, which covers both the page it loads
# and the browser profile the high score lives in.
flatpak override --user --filesystem="$GAME_DIR" "$FLATPAK_ID"
say "granted $FLATPAK_ID access to $GAME_DIR"

mkdir -p "$GAME_DIR/.chromium-profile"

# ---- desktop entry --------------------------------------------------------
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
  # captured from the game by tools/capture-steam-art.mjs; Steam picks this up as
  # the shortcut's icon when the entry is added
  [ -f "$ICON" ] && echo "Icon=$ICON"
} > "$DESKTOP_FILE"
chmod +x "$DESKTOP_FILE"
say "desktop entry: $DESKTOP_FILE"
command -v update-desktop-database >/dev/null && update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true

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
  if command -v steamos-add-to-steam >/dev/null; then
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
  echo "Could not finish the Steam step. Add it by hand, either way round:"
  echo "  * in Dolphin, right-click $DESKTOP_FILE and pick \"Add to Steam\""
  echo "  * or in Steam: Games -> Add a Non-Steam Game -> Browse -> $LAUNCHER"
  [ -f "$ART_INSTALLER" ] || say "install-steam-art.py is missing, so artwork was skipped."
  command -v python3 >/dev/null || say "python3 is missing, so artwork was skipped."
fi

cat <<'NOTES'

Worth knowing:
  * Controls: the Deck's own sticks and buttons work as a gamepad. In Game Mode
    set the controller layout to a Gamepad template, not Desktop, or the sticks
    come through as a mouse and nothing steers.
  * Sound starts off. Click SND once with the right trackpad; the game only
    opens its audio device on a real click, which a gamepad press is not.
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
