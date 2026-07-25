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
# Steam creates the shortcut, not this script. A record Steam wrote itself is one it
# reliably recognises, and its appid is then certainly the one its artwork should be
# named after. Writing the record here instead is possible, and install-steam-art.py
# will do it with --add-if-missing, but on macOS that produced a library entry Steam
# would not treat as a shortcut and would not let go of, so it is not the default.
#
# The cost is that Steam keeps shortcuts.vdf in memory and writes it out in its own
# time, so the artwork step waits for the shortcut to appear rather than assuming it.
art_step() {
  python3 "$ART_INSTALLER" --launcher "$LAUNCHER" --art "$HERE/steam-art" "$@"
}

have_art_step=false
if [ -f "$ART_INSTALLER" ] && command -v python3 >/dev/null; then
  have_art_step=true
fi

echo
echo "Steam:"
if [ "$have_art_step" = false ]; then
  say "python3 or install-steam-art.py is missing, so artwork cannot be attached"
fi

if [ "$have_art_step" = true ] && art_step --list 2>/dev/null | grep -q "matches this game"; then
  # already in the library: just refresh the artwork against Steam's own appid
  art_step
elif command -v steamos-add-to-steam >/dev/null && [ -f "$DESKTOP_FILE" ]; then
  say "asking Steam to add the shortcut"
  steamos-add-to-steam "$DESKTOP_FILE" || die "steamos-add-to-steam refused the entry."
  if [ "$have_art_step" = true ]; then
    if ! art_step --wait 30; then
      echo
      echo "Added. Steam has not written the shortcut out yet, so the artwork is"
      echo "still to do: close Steam, then run"
      echo "  $ART_INSTALLER --launcher $LAUNCHER --art $HERE/steam-art"
    fi
  fi
else
  # No helper to ask, which is every platform but SteamOS. Steam's own dialog is
  # the reliable way in, and the artwork attaches to it afterwards.
  cat <<MANUAL

Add it to Steam once, then the artwork goes on:

  1. Steam -> Games -> Add a Non-Steam Game... -> Browse
     pick $LAUNCHER
  2. quit Steam, so it writes the shortcut to disk
  3. run this again, or just:
     $ART_INSTALLER --launcher $LAUNCHER --art $HERE/steam-art

On a Mac, Add a Non-Steam Game only lists .app bundles by default; set the file
filter to All Files, or drag $LAUNCHER onto the dialog.
MANUAL
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
    second copy. Close Steam first, because it rewrites its shortcut file on exit
    and would otherwise discard anything written underneath it.
  * install-steam-art.py --list shows what Steam has, and --remove takes an entry
    and its artwork back out again. Both keep a backup and refuse to touch a file
    they cannot reproduce exactly.
  * To run the hosted build instead of these files, set GEOMETRY_URL in the
    Steam shortcut's launch options:
      GEOMETRY_URL=https://gadgetoid.github.io/geometry/ %command%
NOTES
