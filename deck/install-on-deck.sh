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

# ---- add to Steam ---------------------------------------------------------
# Everything above is safe to repeat: the override, the profile and the desktop
# entry are all written in place. Adding to Steam is not. Steam does not treat a
# non-Steam shortcut as unique, so asking twice leaves two copies of the game in
# the library. Look for the launcher in the shortcut files first and leave a
# library that already has it alone.
#
# Steam keeps shortcuts.vdf in memory and rewrites it when it exits, so with
# Steam running this can miss a shortcut, and a shortcut added now can be
# overwritten. Run this with Steam closed.
already_in_steam() {
  local found=1 vdf
  for vdf in "$HOME"/.steam/steam/userdata/*/config/shortcuts.vdf \
    "$HOME"/.local/share/Steam/userdata/*/config/shortcuts.vdf \
    "$HOME"/.var/app/com.valvesoftware.Steam/data/Steam/userdata/*/config/shortcuts.vdf; do
    [ -f "$vdf" ] || continue
    # shortcuts.vdf is binary, and the launcher path is stored in it verbatim
    if grep -qaF "$LAUNCHER" "$vdf"; then
      found=0
    fi
  done
  return $found
}

if already_in_steam; then
  echo
  echo "Already in your Steam library, so it was left alone."
  say "the desktop entry, the flatpak permission and the icon were refreshed"
  say "artwork already attached to the shortcut is untouched"
elif command -v steamos-add-to-steam >/dev/null; then
  say "adding to Steam"
  steamos-add-to-steam "$DESKTOP_FILE" || die "steamos-add-to-steam refused the entry."
  echo
  echo "Done. GEOMETRY II is in your Steam library."
else
  echo
  echo "Done, except for the Steam entry: steamos-add-to-steam is not on this system."
  echo "Add it by hand, either way round:"
  echo "  * in Dolphin, right-click $DESKTOP_FILE and pick \"Add to Steam\""
  echo "  * or in Steam: Games -> Add a Non-Steam Game -> Browse -> $LAUNCHER"
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
  * Library artwork (banner, grid tile, logo) is in deck/steam-art/. The icon is
    already attached; see that folder's README for the other slots.
  * Re-running this is safe. It refreshes the permission, the entry and the icon,
    and will not add a second copy to your library. Close Steam first, because it
    rewrites its shortcut file on exit.
  * To run the hosted build instead of these files, set GEOMETRY_URL in the
    Steam shortcut's launch options:
      GEOMETRY_URL=https://gadgetoid.github.io/geometry/ %command%
NOTES
