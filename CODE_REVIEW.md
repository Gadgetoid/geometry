# Code Review Instructions

Review this game codebase (GEOMETRY II — a vector asteroid-slicing game, ~14.8k
lines of vanilla ES modules, no build step) for:

1. **Performance** — per-frame allocation, redundant work, GPU batching
2. **Best practice** — modern idiomatic JS, dead code, error handling
3. **Separation of concerns** — sim / view / renderer boundaries
4. **Bugs & issues** — especially geometry, physics and state-machine edge cases
5. **Configurability** — is tuning reachable without reading gameplay code?
6. **Extensibility** — cost of adding a ship, weapon, special, upgrade, material
7. **Renderer robustness** — batching, context loss, letterboxing, no dead paths
8. **Verification** — is a claim backed by a number, or by reading the code?
9. **Accessibility** — a _superficial_ pass only, see below

Three files, so a pass spends its time on the code rather than on the history:

- **`COMMON_ISSUES.md`** — how this codebase goes wrong. The failure classes it has
  produced more than once, with the instances that taught each one. Worth reading
  first: most of what a review finds here turns out to be one of them again.
- **`KNOWN_ISSUES.md`** — what is already known. Defects left alone on purpose, what
  is genuinely open, what has been settled and should not be re-raised, and what has
  been measured well enough that measuring it again is a waste of a pass.
- **this file** — the layout, how to verify a suspicion, and what to do with what you
  find.

## Layout

`config.js` registries (ships, weapons, shields, specials, hazards, shop, the
special-slot pop-over, options menu, the dev tool pages, the screen a run ends on,
control bindings, asteroid shape) plus `PROGRESSION` and each type's own `spawn`
block, which between them are the whole 40-sector difficulty curve, plus
`SHOP_LAYOUT` and `UI_SCALES` for the shop's row order and the HUD's sizes, plus
`SHIP_SCALARS`, which derives a
ship's accel, speed, turn, drag, hull, bubble, outline weight and rock
susceptibility from its outline and three stated numbers (mass, power, armour) ·
`palette.js` colours · `math.js` pure geometry · `entities.js` sim entities +
weapon controllers · `game.js` state, phases, beams, menus, bindings ·
`background.js` backdrop · `view.js` painting ·
`renderer.js` backend contract · `glrenderer.js` WebGL2, the only backend ·
`shaders.js` the GLSL every pass compiles ·
`gamepad.js` pad sampling · `persistence.js` IndexedDB, one key per thing
remembered · `audio.js` · `main.js` wiring

## How to verify

Run `npm run check` (eslint + prettier + 468 tests) before and after any change.

The simulation is headless: `new Game()` works under plain node, so
`game.startNewGame()` and `game.advance(1/60)` in a loop will reproduce and
**quantify** most gameplay bugs. Do that rather than reasoning from the source.
`test/game.test.js` has the helpers. Traps that have each cost a wasted probe:

- A ship mid-warp is intangible. Use `beSolid`, or the probe measures nothing and
  passes for the wrong reason.
- Leave a rock in the field. An empty sector counts as cleared and runs on to the
  shop within two frames, which takes the phase out of `canFly()`.
- `toggleOptions` _toggles_, and `paused` survives `startNewGame`. A probe posing
  several menu states must set `paused = false` between them or it closes the menu
  the last pose opened.
- Rock silhouettes are random, so any tolerance over rock geometry depends on how
  much `Math.random` ran before it. Seed with `mulberry32` — otherwise the test
  passes alone and fails in the suite.
- A scout's shield comes from its rolled `arms`, not from `type.loadout`, and
  `new Asteroid({vertices})` skips hazard mounting entirely. Build either the way
  the spawner does or it silently has no shield.
- `Sound.power()` is two `beep` calls. Count the tone, not the beeps.
- Some effects are gated on things that look unrelated: `invincible` now also
  hides the player from everything that hunts it, through `Game.visiblePlayer`, so
  `invincible = 1e9` in a probe stops turrets firing, stops a cannon winding up and
  stops a hunting rival chasing. It has cost a wasted probe three times, and it
  broke a geometry test the fourth: the target stopped hunting, so it drifted
  differently inside the frame and the contact depth moved.
- Pinning a hull's position and velocity does not stop it moving. It
  re-accelerates along its facing inside the same frame, so a fixed obstacle needs
  `accel = 0` too.
- **Resting contact is the solver working, not failing.** It deliberately leaves
  `CONTACT_SLOP` of overlap, so "is `bodyContact` still non-null?" reports every
  settled pair as wedged: 40 of 40 ships spawned inside a boulder read as stuck
  until the question became "is the centre still inside the outline?", which
  answers 0 of 40, escaping on frame 0.
- **The player starts at the centre of the view and is solid.** A probe firing
  across the field hits it without meaning to; a beam "control" with nothing in
  the way was really a beam stopped by the player, and agreed with every case it
  was meant to contrast with. Park it at (-9000, -9000).
- **The player has no shield until one is bought.** `liveGame()` is a bare hull;
  use `withShield(game, level)` to pose a shielded one. On a rival, a shield at
  full energy comes back up inside the same frame it is dropped, so
  `shield.up = false` alone does not pose an unshielded hull. Set `downTimer`
  too, or the pose is gone before the shot lands.
- **`?dev` is not dev mode.** It sets `DEV_VISIBLE`, which only offers the button;
  `game.devMode` is what the button sets, and it is what stocks the shop's
  specials. A flow probe read as "the pop-over never opens" until that was found.
- **`assert.equal` is `Object.is`, so `-0 !== 0`.** A probe measuring a velocity
  that was never touched fails against `0`. Compare with a tolerance.
- **Place a rock by its surface _and_ the ship's.** Parking one at
  `boundRadius + gap` from the ship's centre still puts it inside a hull ~18 units
  deep, so a wash or wake measurement at a small gap is really measuring contact
  resolution. Add `player.boundRadius`.
- **An alien hull's shield is in its core, not on a hardpoint.** Filtering a loadout
  for entries carrying `shield` leaves it fitted, so a probe meaning to cut an
  unshielded hull measures a shield stopping the beam. `withoutShield` in the test
  file strips both; use it rather than a filter written on the spot.
- **A cap can make a measurement meaningless.** Timing `advance` with a filled
  particle list measures nothing, because the list is truncated to `MAX_PARTICLES`
  on the first frame and every later frame is the same size. Measure the per-item
  work directly, or raise the cap for the duration.
- **A dead sector stops the world.** An empty rock field is a cleared sector and
  `canFly()` goes false with it, which stops weapons updating: a probe measuring
  whether a hull's guns fire read zero for the fix and zero against it. The same trap
  as leaving a rock in the field, and it has now cost three probes.
- **A hull off screen holds fire.** Parking the player at (-9000, -9000) to keep it
  out of a measurement takes the camera with it, so the rivals being measured are off
  screen and shoot at nothing. Keep it on screen and make it untouchable instead:
  invisible to targeting, and the camera stays where the fight is.
- **One sector is one sky.** `regenSector` is seeded from the sector number, so
  sampling the planet distribution at a sector gives the same answer every time. A
  band of sectors around the mark is the only way to see a spread, and the arc
  clamps past `SKY.arcSectors`, which is what makes a wide band valid at the end
  of a run but not in the middle of one.

Gamepad input needs no device: `readPad` is pure and `GamepadInput.apply` takes a
sample directly, so `test/gamepad.test.js` drives the whole mapping under node.
Edge-detected presses need the previous sample released **before** the press, not
after, or the press that follows has no edge. In the browser, override
`navigator.getGamepads` to return a mutable fake pad.

**The keyboard and the pad are separate paths. Proving one proves nothing about
the other.** They diverge on purpose in places: START opens the options menu in a
sector and confirms everywhere else, and a pad binding is taken when the button
comes back up while a keyboard one is taken on the press.

For rendering, drive the real page with `puppeteer-core` against the system
Chrome (`--use-angle=swiftshader --enable-unsafe-swiftshader`). `window.__geometry`
exposes `{ game, view, renderer, gamepad }`. Screenshot and actually look at it;
half the layout problems in here were found that way and none by reading. The
drawing buffer is not preserved, so paint again immediately before capturing.
Frame timing under swiftshader is software rasterisation and says nothing about
real performance. `WEBGL_lose_context` exercises the context-loss path.

`main.js` clamps frame `dt` to 0.05s, so under swiftshader (which cannot hold
60Hz) **game time runs at roughly half wall clock**. Anything measured in game
seconds — a hold-to-jettison threshold, a cooldown — looks like it is not
accumulating. Instrument the game's own clock, never the wall.

## Accessibility, superficially

A light pass for obvious wins, not an audit and not a WCAG exercise: this is a
fast vector shooter and some of it is inherent. Say what is cheap, say what would
change the game, and leave the second kind to me.

Already in place, so do not report these as missing: every ship control is
rebindable on both keyboard and pad buttons (not pad axes, which is already in
the open list above), from a page that names what is bound; the HUD draws at 1x,
1.5x or 2x; the CRT filter is a setting; help text is a setting;
sound and volume are settings; every special carries a letter as well as a colour,
in the pickup, the slot and the pop-over.

Worth a look, roughly in order of how cheap the fix would be:

- **Colour as the only channel.** Powerups have letters. Do rival types, hazard
  traits, the shield state, the energy bar's low warning and the two beam colours
  (a normal shot against an overdriven one) survive being desaturated? A
  screenshot converted to greyscale answers this in one look.
- **Contrast.** The faintest entries in `PALETTE.text` are #5a6f92 and #5f79a6 on
  a near-black field, and several HUD labels draw at 8 to 11px before scaling.
  Check the small dim ones against the background they actually sit on.
- **Flashing.** There is a lot of it. Measured off the source, the fastest are an
  expiring ore chunk or special at **6.8Hz**, which accelerates as it goes; the
  invincibility blink at **6Hz**, a hard on/off rather than a fade; and an arming
  jettisoned special at **3.5Hz**. Below those: the low-energy bar 1.6Hz, OUT OF BOUNDS 1.4Hz, a primed
  overdrive 1.75Hz, an active special slot 0.95Hz. The CRT filter lays scanlines
  over all of it. 3Hz is the photosensitivity line usually cited, so three effects
  are over it, one of them a hard-edged full-hull strobe. A "reduce flashing"
  setting beside the CRT one is probably the cheap answer.
- **Motion.** Screen shake, camera sway and the warp ripple have no toggle, and
  `prefers-reduced-motion` is not read anywhere.
- **Timing.** Everything is real-time with no slow-down or pause-safe input;
  hold-to-jettison is 0.55s and hold-to-cancel-a-binding 0.6s, both fixed.
- **The canvas itself.** `index.html` does set `lang="en"` and a `<title>`, and the
  three overlay buttons carry `title` and `aria-pressed`. The `<canvas>` has no
  `aria-label` and no text alternative, and nothing in the game is announced.
  Worth stating plainly what is and is not reachable rather than pretending
  otherwise — an all-visual arcade game has a floor, and naming it is more useful
  than a list of things that cannot be fixed.

## Output

Order findings by impact, not by file. For each: the concrete failure (inputs →
wrong result), and a measurement where one is cheap to take. Separate real
defects from taste. Say plainly when something is already fine — do not pad.
Flag anything that is a balance or feel decision rather than a bug, and leave
those to me.
