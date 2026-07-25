# Steam library artwork

Generated from the game by `tools/capture-steam-art.mjs`, so the bloom, the neon
weights and the CRT curvature are the ones it actually ships. Regenerate any time:

```sh
npm install --no-save puppeteer-core
node tools/capture-steam-art.mjs
```

| File           | Size     | Steam slot                                          |
| -------------- | -------- | --------------------------------------------------- |
| `header.png`   | 920x430  | `<appid>.png` wide capsule                          |
| `capsule.png`  | 460x215  | `<appid>.png` at the smaller size                   |
| `hero.png`     | 1920x620 | `<appid>_hero.png` library banner                   |
| `portrait.png` | 600x900  | `<appid>p.png` library grid tile                    |
| `logo.png`     | 1280x720 | `<appid>_logo.png`, transparent, sits over the hero |
| `icon.png`     | 256x256  | `<appid>_icon.png`, and the desktop entry's icon    |

## Attaching it

`install-on-deck.sh` does this for you, by running `install-steam-art.py`. Run
that on its own after regenerating the art:

```sh
./deck/install-steam-art.py --launcher ./deck/geometry-ii.sh --art ./deck/steam-art
```

Add `--add-if-missing` and it will create the shortcut too, which is what makes a
first install one pass instead of two. Handing the entry to Steam and then trying to
attach artwork cannot work in one go: Steam keeps `shortcuts.vdf` in memory and only
writes it out when it exits, so the shortcut is nowhere on disk for the artwork to
attach to yet.

It has to go looking, because none of this comes from the desktop entry. Steam
reads the entry's `Icon=` once, when the shortcut is created, and never again; and
it does not read the banner, the grid tile or the logo from there at all. Those
live in `userdata/<user>/config/grid/`, named after the appid Steam assigned the
shortcut. So the script finds the shortcut by its launcher path in `shortcuts.vdf`,
reads the appid out of it, and copies the art in beside it under the names above.
It also sets the shortcut's own `icon` field, which is what the library list shows.

Two consequences worth knowing:

- **Close Steam first.** It holds `shortcuts.vdf` in memory and rewrites it on
  exit, so edits made while it is running are lost. The script refuses to touch the
  icon while Steam is up, and says so.
- **A shortcut Steam has just accepted is not on disk yet**, for the same reason.
  This is why the script would rather create the shortcut itself than ask Steam to,
  and why it refuses to write anything while Steam is up.

`shortcuts.vdf` belongs to Steam, so the script will only rewrite one it can parse
and re-serialise byte for byte first, and it keeps a `.geometry-backup` beside it.
`--dry-run` shows what it would do and touches nothing.

## How the scenes are built

Each plate drives the real simulation rather than posing a mock-up: rocks are
`makeAsteroidPolygon` output, the frigate really is cut by `applyBeam`, and the
burning debris is the material system doing its job. Subjects are drawn larger
than life, because a 13-unit hull is a speck on a 1920-wide banner and the
outlines are scale-free.

Two things the capture has to do that are worth knowing if you edit it:

- **Stop the game's own animation loop first.** It would otherwise keep advancing
  and repainting between a scene being posed and the shot being taken, ageing
  every particle, fading the beam, and finishing the warp the icon is meant to be
  caught halfway through.
- **The icon composes two states.** `PlayerShip.draw` shows either the arrival
  portal with a half-formed hull, or the true outline with its hexagonal shield,
  never both; and the screen ripple is armed separately, from the same value,
  after the world is painted. The capture draws the ship as solid and restores the
  arriving value straight after, taking the shape and shield from one and the
  ripple from the other.
