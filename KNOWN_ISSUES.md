# Known issues

What is known about this codebase and not fixed: defects left alone on purpose, what
is genuinely open, what has been settled and should not be re-raised, and what has
been measured well enough that measuring it again is a waste of a pass.

Read with `COMMON_ISSUES.md`, which is how this codebase goes wrong, and
`CODE_REVIEW.md`, which is how to verify a suspicion about it.

## Cosmetic defects, deliberately left alone

Each says what is wrong, how far wrong it goes, and what fixing it would cost.

### A hull crosses the drawn arena ring

`Entity.confine` insets the boundary by a margin the caller passes, and the
player passes `radius` (13). The hull reaches `boundRadius` (18.2), so sitting on
the confine limit puts the nose up to **5.2 world units** past the ring the view
draws. Worst case is the ship pointing straight out; measured maximum over 24,000
frames of play was 2.2.

This is the same substitution the collision code was cured of, still in place for
confinement. The fix is to confine by the hull's support distance in the outward
direction rather than by a single radius, which would also stop the ship from
turning on the spot at the boundary without being pushed in. Left because the
overrun is a fraction of the ring's own drawn width and the boundary reads as a
soft edge anyway.

### A rock's outline crosses the ring

`Asteroid.update` measures the overrun along the direction from the arena centre
to the rock's centre, using `supportDistance` on that one axis. The vertex
furthest from the arena centre need not be the furthest along it, so a rock
settled on the wall can have a vertex past the ring. Two contributions:

- the radial approximation: up to **12.2 units** for the worst shape and
  orientation, out of 400 seeded rocks swept through every angle
- the pair solver runs after confinement in the same frame, so a rock shoved by a
  neighbour ends the frame outside

Measured maximum over 24,000 frames of ordinary play was **3.7 units**. A REPEL
at full strength produced 2.5. Only a contrived pile-up (six boulders driven into
one spot at 300 u/s) reached 47.

Fixing the first part means finding the furthest vertex by radius rather than
along one axis; fixing the second means confining after the solver instead of
before, or iterating the two together. Left because the visible error is a couple
of units on a 90-unit rock.

### A shield bubble is round to the simulation and hexagonal on screen

Everything that meets a raised shield meets a circle of `shieldRadius`: beams,
shots, and now hulls. `Shield.draw` paints a regular polygon of the type's
`sides` at that radius, so the flats of a drawn hexagon sit at 86.6% of the radius
being collided against. Parked against a flat rather than a vertex, a hull stops
with clear space in front of it:

| bubble        | radius | sides | worst gap |
| ------------- | ------ | ----- | --------- |
| player        | 23.9   | 6     | 3.2       |
| scout         | 22.6   | 6     | 3.0       |
| frigate       | 95.9   | 8     | **7.3**   |
| alien frigate | 171.1  | 12    | 5.8       |

The frigate is the worst of them, being the largest bubble a body is actually
stopped by: on six sides it stood 12.8 units off. Its shield is an octagon, which
halves that at no cost, since `sides` is only ever a drawing.

The alien field is larger still and does not belong in the comparison for the
reason that matters: it is not solid, so nothing is ever parked against it. What it
is drawn at only has to agree with where a beam is stopped, which is a point on a
circle rather than a surface a hull rests on.

The hexagon also turns, at `time * 0.3`, so the gap breathes rather than sitting
still. That rotation is why the circle is the honest steady-state shape and why
colliding against the drawn hexagon would be worse: a spinning contact surface
would drag resting bodies around it.

Closing it means drawing the bubble as a circle, which is an art decision (the
faceted shield is of a piece with the rest of the vector look), so it is left
alone. `sides` in `SHIELD_TYPES` is the setting: raising it toward 20 makes the
drawn shape converge on the one the simulation already uses.

### A beam's halo is wider than the beam

A beam collides as a capsule as wide as the bright core the view draws
(`width`, 2.4 for the player's laser). The renderer also lays a halo around it
out to `core + glow / 2 + 1.2`, which is **10.4 units** either side, and bloom
spreads that further. So a shot whose halo laps a hull, but whose core does not
touch it, correctly registers nothing while arguably looking like a hit: over
5,784 scout poses, 1,774 fall in that band.

Matching the simulation to the halo would make the player's laser 21 units thick,
close to the width of a scout. Raising `width` in `WEAPON_TYPES` widens the core
and the hit region together, which is the setting to reach for if the current
tolerance feels tight.

### A beam flash outlives the shot that made it

`laserShots` draws a beam for 0.4s at the position it was fired from. A scout at
its top speed of 190 u/s covers 76 units in that time, three times its own width,
so a clean miss can drift into a beam that is still on screen. The flash is a
flash, not a hitbox; nothing is wrong with the resolution.

## Settled, and not worth re-raising without new evidence

beams,
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
price for a spare ship is read from the shop row wherever else it is charged;
a menu row shows an arrow when, and only when, pressing it opens a page, which a
test holds for every row of every page; the shop addresses a hardpoint by the role
it plays rather than by its index, so fitting a hull that is not the player's own
no longer strips its cell; the player is the player whatever hull they are flying,
so their own guns know which side they are on; a bubble is checked against the cell
every tick rather than only when it is shot at, so a hull that spent its cell on a
gun cannot keep a shield it is not paying for; exhaust comes out of every nozzle a
hull has; a gun that does not charge fires the way every other hull fires it, so
nothing on the nose can put NaN through the cell; a well is bounded, and a wind-up
does not tow the one already out there; a marker on the page is what the radar
found rather than what the sensor floor reached; and a special that is already
adrift is not rolled again. Shop purchase sounds against a silent options menu is
a decision, not a defect, and stands.

`KNOWN_ISSUES.md` in the repo holds five measured cosmetic defects that are
deliberately unfixed. Read it before reporting a hull or a rock crossing the
arena ring, a shield bubble that is round to the simulation and hexagonal on
screen, a beam halo wider than the beam that collides, or a beam flash outliving
its shot.

## Actually open

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
not been looked at end to end · only `minerCore` has an upgrade ladder, so a hull
flown out of the dev page has whatever fixed cell its own core states and the shop's
CORE row sells it levels it does not have (90 on a frigate, 800 on a pincer, 300 on
a scout) · a pincer's four turrets eat most of its regen while they have something
to shoot at, which is why it manages one well every 25 seconds rather than the nine
the cell alone would allow: the appetite of the turrets is the dial, not the cost of
the well · a hull's own guns are drawn on a flown hull and fire through their own
controllers, but the player has no way to aim them, so a frigate's four autocannons
are four things happening rather than four things being done · the wells the player
can hold at once is bounded only by the cell, and two is the interesting number
rather than a rule.

## Measured, and not worth re-deriving

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

Later still, and equally not worth re-deriving: a pincer left to fight with a target
in front of it threw two wells a minute and spent 55 of those 60 seconds with no
field up, which is what `reserve` on a gun is for; wells left unbounded wound each
other up to 4,424 units a second against the 80 they are thrown at, and are capped
at 160; a busy sector's worth of specials is one adrift every 32 to 43 seconds
across sectors 5, 12 and 25, with at most one of each kind; and a MK I radar marks
rock only, a MK II adds ore, a MK III adds hulls, measured against one of each
parked off the top of the screen.
