#!/usr/bin/env bash
# Wrap the launcher in a macOS .app bundle.
#
# Steam on macOS will not take a bare shell script: "Add a Non-Steam Game" lists
# only .app bundles, with no way to widen the filter. A bundle is also the shape
# Steam expects to store, which is very likely why a shortcut written by hand with
# a .sh in its Exe was not recognised as one.
#
# The bundle is a wrapper, not a copy. Its executable finds the game relative to
# itself, so the whole folder can be moved and it still works.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GAME_DIR="$(cd -- "$HERE/.." && pwd)"
APP="${1:-$GAME_DIR/GEOMETRY II.app}"
NAME="$(basename "$APP" .app)"

[ "$(uname -s)" = Darwin ] || {
  echo "This only means anything on macOS." >&2
  exit 1
}

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>io.github.gadgetoid.geometry2</string>
  <key>CFBundleExecutable</key><string>geometry-ii</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2.0</string>
  <key>CFBundleVersion</key><string>2.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# The bundle sits in the game folder, so the launcher is found by walking back out
# of it rather than by a path baked in at build time.
cat > "$APP/Contents/MacOS/geometry-ii" <<'RUNNER'
#!/bin/sh
BUNDLE_MACOS="$(cd -- "$(dirname -- "$0")" && pwd)"
GAME_DIR="$(cd -- "$BUNDLE_MACOS/../../.." && pwd)"
exec "$GAME_DIR/deck/geometry-ii.sh" "$@"
RUNNER
chmod +x "$APP/Contents/MacOS/geometry-ii"

# An .icns from the captured artwork. iconutil wants a folder of named sizes, and
# sips can cut them all from the 512 the capture tool produces for this.
SOURCE="$HERE/steam-art/icon-512.png"
[ -f "$SOURCE" ] || SOURCE="$HERE/steam-art/icon.png"
if [ -f "$SOURCE" ] && command -v iconutil >/dev/null; then
  ICONSET="$(mktemp -d)/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256; do
    sips -z "$size" "$size" "$SOURCE" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z "$((size * 2))" "$((size * 2))" "$SOURCE" \
      --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
  rm -rf "$(dirname "$ICONSET")"
fi

# Nothing here is signed, and macOS only quarantines what it downloads, but a copy
# of the folder that arrived as a zip would carry the flag; clear it so the bundle
# opens without a prompt.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "$APP"
