# Playing on a Steam Deck

GEOMETRY II runs in the Chromium flatpak. From Desktop Mode, once:

```sh
./deck/install-on-deck.sh
```

That checks the flatpak is present, grants it access to this folder, writes a
desktop entry and hands it to Steam. The game then appears in your library and
launches into Game Mode like anything else.

`deck/geometry-ii.sh` is what the shortcut runs, and it works on its own too.
`deck/install-steam-art.py` attaches the library artwork, and the installer calls
it; run it again by hand after regenerating the art. Close Steam before either,
because it rewrites its shortcut file on exit.

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
