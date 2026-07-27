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
`gamepad.js` pad sampling · `persistence.js` IndexedDB, one key per thing
remembered · `audio.js` · `main.js` wiring

## How to verify

Run `npm run check` (eslint + prettier + 358 tests) before and after any change.

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

## What has repeatedly gone wrong here

- **A shape the simulation tests disagreeing with the shape the view draws.**
  The most productive question to ask this codebase; it has paid out five times.
  Circles standing in for polygons caused an invisible wall, fragments popping
  apart, 39% of beams missing a frigate, and a player hull with twice its own area
  in phantom hitbox and an intangible nose. Then the same thing inverted: the
  shield bubble's radius existed _only_ in the draw path, worked out three
  different ways at three call sites, so shots that visibly grazed a shield did
  nothing — 5 of 14 sampled offsets on a scout, 9 of 13 on a frigate. Then the
  bubble became the sim's shape for beams and stayed the draw path's for bullets,
  so a shot fired at a visible shield passed through it: 35 of 46 offsets on a
  frigate, 14 of 25 on the player, which is the only thing bullets are ever aimed
  at. And a beam collided along a zero-width centreline while being drawn 2.4
  units across, so a shot laid over an unarmed rival registered nothing in 220 of
  5,784 sampled poses. Whenever a size is computed where something is drawn, ask
  what the sim uses instead, and the other way round.
- **The same question answered inconsistently for two body types.** Rocks needed a
  beam to cross twice before cutting while ships needed only a touch; two contact
  sites divided by mass where its inverse belonged, invisible for the player whose
  mass is exactly 1 and wrong for everything else; and rocks were the only body
  type `detonate` never called `takeDamage` on, so a shielded rock beside an
  explosion lost nothing. Since then: `resolveHullRockContact` was shared by every
  hull while only the player was _charged_ for it, so a scout could drive into a
  boulder for ten seconds and lose nothing while the player lost a life in 6.7;
  a beam cut every rock it crossed but only the nearest ship; and a shielded rock
  had its energy drained inline while every other body lost it through
  `takeDamage`. When two kinds of body answer the same question, find both answers
  and diff them.
- **Predicates that consider only one party.** A bounce tested the ship's own
  velocity, so a rock driving into a stationary ship never registered.
- **An expression that assumes a range nothing enforces.** The shortest-turn wrap
  `((goal - heading + 3 PI) % TAU) - PI` is only correct while
  `goal - heading > -3 PI`, and a ship's heading accumulates and is never
  normalised. Its fingerprint was headings pinned at _exactly_ 3 PI, because the
  broken branch turned the ship back the moment it would pass: the ceiling was the
  bug, not a limit. 41.7% of rival frames sat where it could turn the wrong way.
  When a formula assumes an input range, find the line that guarantees it.
- **Range measured to a centre, for a body that has extent.** This has now paid
  out twice with the same symptom: the thing you most want the effect to reach is
  the thing it reaches least, because a big body's centre is far away by virtue of
  being big. A blast measured centre to centre, so a boulder with its face against
  it took nothing but a shove. Then the exhaust wash, still measuring to the
  centre after the blast was fixed: a mass-8.2 boulder gained **0.7 u/s** from a
  second of point-blank thrust and **nothing at all** beyond point-blank, where
  the same wash gave a pebble 147. Reported as "thrusters stopped pushing rocks,
  probably a mass tuning problem", which is what it looks like from the cockpit.
  Grep every falloff for one measured against `center` without subtracting
  `boundRadius`.
- **A cost quoted as an amount, against a resource an upgrade scales.** The
  specials charged flat energy while the core's cell runs 320 to 1260 and its
  regen 32 to 116/sec, so stealth's 26/sec drain was _below_ the regen at the top
  level: the special was free on a fully upgraded ship. Reported as "they make
  basically no impact". Fixed by quoting every cost as a fraction of the cell,
  which holds the feel at every level (stealth is 9.5s of run time at all five).
  **`CONFIG.THRUST_COST` is still a flat 21/sec and has the same problem.**
- **A field every registry entry declares is not a selector.** `endEffectsWith`
  looks up effects by a named field, and toggling stealth off passed `"mode"` —
  which every special declares — so it also cancelled a running booster. If a
  lookup-by-field helper exists, the field passed to it has to be one only the
  intended entries carry.
- **A timer that runs while its subject cannot act.** Respawn invincibility ticked
  through the 1.2s pause and 0.85s warp-in, so all 2.0s of it were gone before the
  ship could be flown. Ask what a duration is a duration _of_.
- **An effect that only decays in the loop that started it.** Screen shake decayed
  in `update`, which `advance` calls only while `inSector()`. Losing the last life
  throws the shake and sets phase `over` in the same breath, so the ship-lost
  screen shook for good. Anything that settles should settle wherever it was
  started.
- **A rule applied to one instance of a case and not the other.** `applyBeam`
  passed straight through a rival outside the arena, with a comment explaining
  that a body which cannot be damaged must not stop a beam either, and did not
  apply that to the player mid-warp, which is the same case. A warping ship
  stopped an enemy beam dead and sheltered what was behind it, and both bodies
  swallowed bullets for no damage. When a comment states a principle, grep for
  every body it should cover.
- **A guard that only guards one of the ways in.** `invincible` was consulted at
  rock contact, at the turret controller's decision to hold fire, and at the
  cosmetic blink, but never in `takeDamage`. Bullets, beams and blasts went
  straight through it, and since the player's hull has no health of its own
  (`onHull` costs a life outright) any one of them was a one-shot kill on a ship
  that was visibly flashing "invulnerable". Reported as "one shotted while
  spawning in and ostensibly invincible". Worth asking of any flag: what enforces
  it, and does that cover every way in?
- **A guard that quietly became the answer.** `AST_MASS_RANGE` was written as a
  clamp against extremes, but its ceiling of 4 sat below everything a sector
  spawns (4.3 to 8.2), so all 86 sampled rocks landed on it and every rock in the
  field weighed exactly the same. A clamp that binds on the common case is not a
  guard. Check what fraction of real values a limit actually catches. Same again
  with `MAX_PARTICLES`, sized at 1,200 for a smaller game: six burning wrecks alone
  wanted 1,697 and the cap drops the _oldest_, so a busy sector was quietly eating
  the effects of everything that happened before the fire. A cap nothing was
  measured against is a number, not a limit.
- **Unbounded growth in a weighted roll, which deletes rather than crowds.** The
  armed-rock hazard was the only one with a `weightPerSector`, so its share of
  the roll ran away with it: explosive rocks went from a fifth of the pool at
  sector 6 to a thirtieth by sector 30, roughly one every four sectors. It reads
  in play as a hazard being removed from the game, and it was diagnosed as
  something destroying them. Anything that grows per sector wants a cap, and any
  "I never see X any more" is worth checking against the roll before the
  simulation.
- **Aggregating a per-pair result without deciding what the aggregate means.**
  Decide contact per part, but measure the push over each body as a whole.
- **Name-based special-casing** instead of a field on the type registry. BOOSTER's
  collision immunity lived in `PlayerShip.update` and was declared nowhere; a
  rival's decision to hunt was inferred from a loadout entry naming the "hunter"
  controller, so any other aggressive controller would silently not chase.
- **A tool that writes the model, left behind by the model.** `ship-editor.html`
  emits `SHIP_DESIGNS` entries, so any field added to a design that the editor does
  not write is silently dropped the next time a hull is pasted back through it.
  This has now happened five times: derived fields written out and frozen,
  `faction` and `confineRadius` lost, arm chances lost, an invented
  `maxConcurrent: 1`, and `debrisMaterial: SHIP_PLATING` hard-coded for every hull,
  which would have re-plated an alien as a rival and had it burning orange. The
  round-trip test in `test/editor.test.js` is the guard: when a field is added to a
  ship type, it belongs in that test the same day. Ask of any generator: what does
  it not know about yet?
- **Two places holding one fact, one of which nothing reads.** Dead code is
  harmless until the fact changes: `GAMEPAD.buttons` still named the ship controls
  after `BINDABLE_CONTROLS` took them over, and swapping a default in one would
  have left them disagreeing in silence.
- **State written for another layer to read, that it never reads.** `summaryData`
  carried a `resumed` flag the shop never checked, so a resumed run printed
  "accuracy NaN%" and four "undefined"s — on screen, the whole time, with no test
  looking at that screen.
- **Entities acting after they die.** Everything is updated and _then_ filtered, so
  anything killed part-way through a frame gets one more turn: a rival fired a
  parting shot and collected the ore it had just dropped.
- **Tests that measure the wrong thing.** Repeatedly the biggest time sink. Past
  cases: a metric counting muzzle flashes as fire, a probe in the wrong phase, a
  sliced ship registering as undamaged, momentum measured in area when the solver
  clamps mass, "are these two hulls apart?" asked as centre distance, a control
  scheme proved on the keyboard and broken on the pad, and an assertion derived
  from the very number it was checking. Two more since: the corner test took the
  peak penetration over every frame including the transient while the ship is
  extracting itself, so heavier rocks "broke" it at 1.60 units when the settled
  value was 0.00 either way; and a beam test asserted `landed === crossesHull`
  against the zero-width centreline, which giving the beam its drawn width
  invalidated: the oracle was wrong, not the code. Before believing a number, state what
  quantity the code actually conserves or tests, and measure that. **If a change
  breaks a test, decide whether the code or the oracle was wrong before touching
  either.** A third kind since: a test proving "a new gun kind joining the pool does
  not arm more rocks" sampled five sectors apart, which only isolated that while the
  trait's own weight had already capped. Respacing the progression made the same
  test measure the growth instead and fail on correct code. A measurement that
  straddles two moving quantities proves nothing about either.
- **A test that asserts something weaker than the property at risk.** The HUD
  scale test first asserted "nothing runs off the page", which passed with an
  anchor deliberately broken, because a mis-anchored element is still on the page.
  Rewritten to assert the real property — every coordinate is a scaled distance
  from the left/top, the right/bottom or the middle — it found an unscaled inset
  on the first run. **Break the code on purpose and confirm the test fails**; two
  tests in this codebase have been written that could not fail.
- **A flaky test believed on one green run.** Rock outlines are generated, so an
  unseeded comparison near a threshold flips between runs. One here passed, failed,
  and passed again across three runs of the same code. Run a new numeric test
  several times before trusting it.

## Known-open, worth a verdict

Settled since the last pass, so do not re-raise them without new evidence: beams,
shots and hulls now all agree on the shield bubble, and it is solid, so a ship
cannot be flown inside one; a beam cuts every hull it passes
through; a body that is not in the sector neither blocks nor absorbs fire; rivals
are charged for the rocks they plough into; a hull sliver pays ore by area; the
rock mass clamp no longer pins every rock to one value; B can be bound (tap to
bind, hold to cancel); a sideways press on the options root no longer walks the
cursor onto RESET PROGRESS; a rival enters from where a departing one is dropped
rather than inside the view, and its life starts when it reaches the arena; a
rock's turrets are fanned around it rather than each picking its own vertex; a
controller carries its beam past the target's far side, so one aimed at a rock
can actually cut it; a rock rolls each turret from a pool of gun kinds, and the
turret controller fires whichever kind it is handed rather than assuming a
projectile; a turret's barrel count follows its rate of fire and every turret in
the game is drawn by one function; every levelled upgrade offers four levels and
a test asserts each of them is one every table it indexes can answer; the
player's shield is a purchase like the defense turret rather than something the
hull is issued with; the laser's top level guarantees a shatter at full charge
and says so by turning red, in place of the coin toss it replaced; the shop's row
order is stated once in `SHOP_LAYOUT` and read through `Game.shopItem`, so
nothing else counts rows; a special is equipment rather than ammunition, kept in
an addressable slot with its own cooldown, and every energy cost it charges is a
fraction of the cell rather than an amount; a jettisoned special cannot be lost
(it bounces off the arena wall and drags to a stop within 142 units, measured
over 300 throws at each of three worst cases); one thing hides the player from
everything that hunts them, through `Game.visiblePlayer`, so a new hunter cannot
forget to check; the exhaust wash and the blast both measure range to a rock's
surface; the spawn point is cleared over the arrival rather than in one frame, and
invincibility counts only while the ship can be flown; the screen shake settles
wherever it was started; nothing can see the ship while nothing can reach it, so
a respawn is neither shot at nor chased and a committed cannon cannot land a shot
on a ship that has only just materialised; the grace period turns away every
channel rather than rock contact alone; one helper answers "what is nearest", so a driver cannot
forget the filters four inlined loops used to spell four ways, and one answers
"where does a turret point", so the drawn bearing and the controller cannot
disagree about whether the player can be seen; a rival turns the short way at any
heading; what a cut hull burns and smokes in is stated by its material rather than
by the four places that used to draw it, so an alien burns green; the particle
buffer is sized against a measured worst case rather than a guess; the shop's
price for a spare ship is read from the shop row wherever else it is charged; and
a menu row shows an arrow when, and only when, pressing it opens a page, which a
test holds for every row of every page. Shop purchase sounds against a silent
options menu is a decision, not a defect, and stands.

`KNOWN_ISSUES.md` in the repo holds five measured cosmetic defects that are
deliberately unfixed. Read it before reporting a hull or a rock crossing the
arena ring, a shield bubble that is round to the simulation and hexagonal on
screen, a beam halo wider than the beam that collides, or a beam flash outliving
its shot.

Actually open:

Pad analog axes cannot be rebound, only buttons · a
ship's `size` is still stated rather than derived, because no single density
fits both hulls (a scout packs 2.1x the mass into its area that a frigate does)
· `energyMax`, `regen`, `killScore`, `blastScore` and `oreDrop` are still loose
per-ship numbers that `SHIP_SCALARS` does not reach · the shield bubble grows by
the beam's half-width for a beam and not for a bullet, so the two disagree by
1.2 units at the very edge · a shielded rock soaks a beam but does not stop it, so
what is behind it is cut anyway, while a shielded hull both soaks and shelters
· `stats.mined` counts shattered pieces rather than
rocks, so one small rock cut in two reports 2 · a partly drained armed rock hands
its whole energy to each fragment (`refreshEnergy` takes `min(inherited, max)`,
which only conserves it when the parent was full), so a two-gun rock on 40 of 100
splits into two pieces on 40 each · `CONFIG.THRUST_COST` is a flat 21/sec against
a cell that quadruples, which is the flat-cost problem the specials were just
cured of, so thrust is nearly free on an upgraded ship · the radar is not scaled
by the HUD size setting, deliberately, since its size changes what positions can
be read off it — worth a verdict · menus are not scaled either, which is fine
until someone plays on a small screen · four boulders made to overlap each other
on the spawn point are separated by the pair solver at ~4,000 u/s, which no real
sector produces but is a sharper spike than the pile-up figure in
`KNOWN_ISSUES.md` · specials have nowhere to hold a level yet, though the slot
object was shaped to take one (`{ id, cooldown, active }`), so levelling is a
registry-and-UI job rather than a refactor · the aliens spawn out of the rivals'
budget, so an alien arriving is a rival that did not · the dev spawn page is 12
rows in a 640-tall view and fits with about one row to spare, so two more hulls
would push its last row off the bottom, and nothing measures that · a run is now
40 sectors long while the ore per rock, the kill scores and the clear bonuses were
all set against one that was effectively over by 15, so what a full run pays has
not been looked at end to end.

Verified sound, with numbers, so do not spend a pass re-deriving them: the
contact solver separates 283 random overlapping concave pairs in one application
with no false negatives and none made worse; the simulation costs 0.24% of a
60Hz budget at the sector cap and 5.6% at 160 rocks, which is seven times
anything reachable (peak in real play is 22); context loss and restore are clean;
letterboxing is exact at every aspect ratio under `?fullscreen`; batching
collapses 943 particle quads and 170 stars into one draw call each, at 56 to 73
draw calls a frame, so the file header's claim is accurate and the earlier
suspicion that it oversold itself was wrong. Extensibility was tested by doing
it: a ship, a weapon, a shield, a special, an upgrade, a hazard trait and a
debris material were each added from `config.js` alone and each worked, so the
registries hold. The only additions needing code are a new firing behaviour (one
entry in `WEAPON_CONTROLLERS`) and a special effect field nothing reads yet.

Since measured, so equally not worth re-deriving: what a busy sector asks of the
particle buffer, which is 2,786 alive with six wrecks burning and six rocks
detonating, and 4,834 in a scene busier than the spawner can build (twelve hulls
cut at once), against a 6,000 ceiling that costs 1.7MB of vertex data a frame at
full and 0.124ms of JS to build the draw calls. The batching figures above predate
that ceiling, so treat 943 particle quads as the sample it was rather than a peak.
And the progression: every part of the 40-sector curve is still climbing at 40,
which is asserted rather than eyeballed, so a flat late run is a regression and not
a tuning opinion.

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
