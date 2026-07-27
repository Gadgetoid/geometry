# Known issues

Cosmetic defects that are understood, measured and deliberately left alone. Each
says what is wrong, how far wrong it goes, and what fixing it would cost.

## A hull crosses the drawn arena ring

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

## A rock's outline crosses the ring

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

## A shield bubble is round to the simulation and hexagonal on screen

Everything that meets a raised shield meets a circle of `shieldRadius`: beams,
shots, and now hulls. `Shield.draw` paints a regular polygon of the type's
`sides` at that radius, so the flats of a drawn hexagon sit at 86.6% of the radius
being collided against. Parked against a flat rather than a vertex, a hull stops
with clear space in front of it:

| bubble  | radius | sides | worst gap |
| ------- | ------ | ----- | --------- |
| player  | 23.9   | 6     | 3.2       |
| scout   | 22.6   | 6     | 3.0       |
| frigate | 95.9   | 8     | **7.3**   |

The frigate is the worst of them by a long way, being the largest bubble in the
game: on six sides it stood 12.8 units off. Its shield is an octagon, which halves
that at no cost, since `sides` is only ever a drawing.

The hexagon also turns, at `time * 0.3`, so the gap breathes rather than sitting
still. That rotation is why the circle is the honest steady-state shape and why
colliding against the drawn hexagon would be worse: a spinning contact surface
would drag resting bodies around it.

Closing it means drawing the bubble as a circle, which is an art decision (the
faceted shield is of a piece with the rest of the vector look), so it is left
alone. `sides` in `SHIELD_TYPES` is the setting: raising it toward 20 makes the
drawn shape converge on the one the simulation already uses.

## A beam's halo is wider than the beam

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

## A beam flash outlives the shot that made it

`laserShots` draws a beam for 0.4s at the position it was fired from. A scout at
its top speed of 190 u/s covers 76 units in that time, three times its own width,
so a clean miss can drift into a beam that is still on screen. The flash is a
flash, not a hitbox; nothing is wrong with the resolution.
