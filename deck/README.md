# Playing from Steam

Written for a Steam Deck, where GEOMETRY II runs in the Chromium flatpak. From
Desktop Mode, once:

```sh
./deck/install-on-deck.sh
```

That checks the flatpak is present, grants it access to this folder, writes a
desktop entry and hands it to Steam. The game then appears in your library and
launches into Game Mode like anything else.

`deck/geometry-ii.sh` is what the shortcut runs, and it works on its own too.
`deck/install-steam-art.py` attaches the library artwork to the Steam shortcut; the
installer calls it. Run it again by hand after regenerating the art. **Close Steam
before either**: it rewrites its shortcut file on exit, so anything written
underneath it is lost.

Steam creates the shortcut, not these scripts. A record Steam wrote itself is one it
reliably recognises, and its appid is certainly the one the artwork should be named
after. On SteamOS the installer asks Steam to add it and then waits for Steam to
write it out, so it all happens in one run. Everywhere else, add it once through
Steam's own dialog and run the installer again.

## If a shortcut goes wrong

```sh
./deck/install-steam-art.py --launcher ./deck/geometry-ii.sh --art ./deck/steam-art --list
./deck/install-steam-art.py --launcher ./deck/geometry-ii.sh --art ./deck/steam-art --remove
```

`--list` shows every shortcut Steam has, with the appid its artwork is named after,
and changes nothing. `--remove` takes matching entries and their artwork back out.
Both keep a `.geometry-backup` and refuse to touch a file they cannot reproduce
byte for byte. Close Steam first.

`--add-if-missing` writes the shortcut record directly instead of asking Steam. On
SteamOS there is `steamos-add-to-steam` to ask, so it is not used there. On macOS
there is nothing to ask, so it is how the shortcut gets made, with the bundle as its
`Exe`. An earlier attempt at this put a bare `.sh` in `Exe` and produced an entry
Steam would not treat as a shortcut, which is the reason for the bundle.

## Why these flags

The launcher is deliberately not a copy of the usual NW.js incantation. Three of
its flags are load-bearing, and most of the rest of that recipe is not.

- **`--allow-file-access-from-files` is required, not optional.** The game is
  vanilla ES modules, and a module script is subject to CORS even over `file://`.
  Without this flag Chromium refuses to load `src/main.js` with _"has been
  blocked by CORS policy"_ and you get a black screen with no other clue.
- **`--user-data-dir` must be a real, writable directory.** It defaults to
  `.chromium-profile` beside the game, which is where the high score lives.
  Pointing it at `/dev/null` costs you the score, and Chromium may refuse to
  start at all.
- **`--app=` rather than `--headless`.** Headless renders nothing to the screen.
  App mode plus `--start-fullscreen` is what gives a chromeless full-screen
  window.

The launcher also appends `?fullscreen` to the page, which the game reads: it
drops the CRT bezel, the drop shadow, the help line and the DEV button, and lets
the canvas take the whole panel. On the Deck that is 1280x800 filled exactly, with
no letterboxing, because the game's virtual 1024x640 is the same 16:10. The CRT
and SND buttons stay, because sound needs a real click to start and there is no
other way to ask for it.

`--ignore-gpu-blocklist` matters more than it looks: WebGL2 is the only backend,
so a blocked GPU means the _"WEBGL2 REQUIRED"_ panel instead of a game.

Dropped from the NW.js recipe as irrelevant here: `--enable-node-worker`,
`--disable-internal-flash`, `--disable-plugins`, `--disable-popup-blocking`,
`--disable-windows10-custom-titlebar`, and the `--file-forwarding` / `@@u @@`
tokens, which only exist to pass a file argument the launcher already knows.
`--in-process-gpu` is left out because the sandboxed GPU process works; add it
back if you ever get a black screen with the HUD still drawing.

## On something other than a Deck

The same scripts work on an ordinary Linux desktop and on a Mac. Only two parts are
Linux-specific and both are skipped where they mean nothing: the flatpak permission,
and the desktop entry. Steam keeps its shortcut file in the same format everywhere,
so the shortcut and its artwork are created the same way.

On macOS the installer also builds a `GEOMETRY II.app` wrapper, because Steam will
not take a bare script: its Add a Non-Steam Game dialog lists only `.app` bundles,
with no filter to widen, and a bundle is the shape it expects to find in a shortcut's
`Exe`. The bundle holds no copy of the game, only a few lines that find it beside
itself, so the folder can still be moved. It carries the captured icon, so it looks
right in Finder and in Steam. `make-macos-app.sh` builds it on its own if wanted.

The browser is whatever `browser.sh` finds. It wants a Chromium-based one, because
the game needs WebGL2 and the launcher passes Chromium's own flags: Chrome,
Chromium, Brave or Edge. Point it at a specific binary with `GEOMETRY_BROWSER`.

Two things are deliberately **not** downloaded into the app directory:

- **flatpak**, because it cannot be. It is built on Linux namespaces and
  bubblewrap, and there is no macOS build to fetch. On a Mac the flatpak path is
  simply not used.
- **a browser**, because you have one. Fetching a second couple of hundred
  megabytes would mean shipping a browser nobody patches, and on macOS clearing
  Gatekeeper's quarantine on it. Finding the installed one is better in every way.
  If the game ever needs a browser nobody has, `npm install --no-save puppeteer`
  fetches a known-good Chrome for Testing build, which is how the art capture tool
  would get one.

## Controls

The Deck's sticks and buttons come through as a standard gamepad. In Game Mode,
set the controller layout to a **Gamepad** template: on a Desktop layout the
sticks arrive as a mouse and nothing steers.

| Control          | Action                          |
| ---------------- | ------------------------------- |
| Left stick       | Steer                           |
| L2 / L1          | Thrust / reverse                |
| R2               | Hold to charge, release to fire |
| Right stick / R1 | Aim / fire the turret           |
| A B X Y          | Powerup slots                   |
| A or Start       | Confirm, and start a run        |
| Back             | Pause                           |

## Sound

Sound starts off and needs one click on **SND** with the right trackpad. The game
only opens its audio device on a real click, and a gamepad press does not count
as one to the browser.

## Running the hosted build instead

No files, no CORS flag needed. Set this in the shortcut's launch options:

```
GEOMETRY_URL=https://gadgetoid.github.io/geometry/ %command%
```
