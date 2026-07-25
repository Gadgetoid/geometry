# Find something to run the game in. Sourced by geometry-ii.sh and by
# install-on-deck.sh, so there is one answer to what counts as a usable browser.
#
# It has to be Chromium-based: the game needs WebGL2, and the launcher passes
# Chromium's own flags, above all --allow-file-access-from-files, without which a
# module script will not load over file:// and the screen stays black.
#
# On a Steam Deck the answer is the Chromium flatpak. Elsewhere it is whatever is
# installed. GEOMETRY_BROWSER overrides everything.

# Sets BROWSER_ARGV to the command to run, or returns 1 with nothing found.
geometry_find_browser() {
  BROWSER_ARGV=()

  if [ -n "${GEOMETRY_BROWSER:-}" ]; then
    BROWSER_ARGV=("$GEOMETRY_BROWSER")
    return 0
  fi

  # Prefer the flatpak where it exists: it is the build this was tested against on
  # SteamOS, and it does not change under you when the system browser updates.
  if command -v flatpak >/dev/null 2>&1 &&
    flatpak info org.chromium.Chromium >/dev/null 2>&1; then
    BROWSER_ARGV=(
      /usr/bin/flatpak run
      --branch=stable
      "--arch=$(uname -m)"
      --command=/app/bin/chromium
      org.chromium.Chromium
    )
    return 0
  fi

  local candidate
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
    /usr/bin/chromium \
    /usr/bin/chromium-browser \
    /usr/bin/google-chrome-stable \
    /usr/bin/google-chrome \
    /usr/bin/brave-browser \
    /usr/bin/microsoft-edge; do
    if [ -x "$candidate" ]; then
      BROWSER_ARGV=("$candidate")
      return 0
    fi
  done

  return 1
}

# A one-line description of what was found, for the installer's output.
geometry_browser_name() {
  case "${BROWSER_ARGV[0]:-}" in
  */flatpak) echo "org.chromium.Chromium (flatpak)" ;;
  "") echo "nothing" ;;
  *) echo "${BROWSER_ARGV[0]}" ;;
  esac
}

geometry_no_browser_message() {
  echo "No Chromium-based browser found." >&2
  echo "The game needs WebGL2 and is launched with Chromium's own flags, so it wants" >&2
  echo "Chrome, Chromium, Brave or Edge. Install one, or point at it directly:" >&2
  echo "  GEOMETRY_BROWSER=/path/to/chrome $1" >&2
  echo "On SteamOS: flatpak install --user flathub org.chromium.Chromium" >&2
}
