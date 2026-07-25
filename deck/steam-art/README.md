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

`install-on-deck.sh` points the desktop entry at `icon.png`, so the shortcut has
the right icon from the start. The rest have to be attached to the shortcut, in
one of three ways:

- **In Steam:** right-click the game, Manage, then set artwork per slot. Steam
  picks the slot from where you drop it.
- **Decky Loader + SteamGridDB plugin:** its "custom" tab uploads local files.
- **By hand:** copy them into
  `~/.steam/steam/userdata/<userid>/config/grid/` under the names in the table.
  The appid is the shortcut's, which Steam assigns when the entry is added, so
  the folder has to be read after that. Restart Steam afterwards.

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
