# Roadmap

Where GEOMETRY II might go next, roughly in build order. Nothing here is
committed, and the further down the page an item sits the less thought it has
had.

## Where things stand

A ship is an outline, two numbers and what is bolted to it. Everything else is
worked out: a drive on a hardpoint decides acceleration and top speed, a set of
maneuvering thrusters in the core decides the turn and never the other way about,
and all of it divides by what the hull weighs with its loadout aboard, so fitting
more costs handling. One method does that arithmetic for every ship, whether it is
a type read at boot or a ship refitted in the shop, so the two cannot come to
different answers about the same hull.

What that bought:

- A frigate with siege engines sweeps through an arc no drive it fits will
  shorten, and carries the heaviest thrusters in the game while still being the
  slowest hull round.
- A fully fitted player ship is a quarter heavier than a bare one and gives up
  20% of its acceleration, top speed and turn. The quicker thrusters win back
  most of the turn, which is what they are for.
- A rival works out how it flies from what it turned up carrying, so a scout that
  rolled a shield and a gun is a third heavier and handles like it.
- The shop is slots the whole way down: buy once, swap freely, fly without what is
  optional. A rival could be given anything the player bought.

The player's ship is most of the way to being an ordinary hull that is simply
never spawned. Its outline, cell, drive, thrusters, shield, radar and guns are all
fitted equipment read through the same relationships as any rival's; what is left
on CONFIG is drag, which is a control aid rather than a property of the hull.

## Aliens

A third faction, arriving in the later sectors and hostile to the player and to
the rivals alike. Built from ordinary polygon geometry like every other hull,
then set apart by a localised distortion or glitch pass over the space they
occupy, in the spirit of the warp ripple the view already runs on arrival. The
effect is the point: they should read as organic, wrong, and a little outside
the game the rest of the screen is playing.

Three of them, one per rival tier, so `seeker`, `scout` and `frigate` each have
an alien counterpart and the existing spawn tables and controllers carry over.

The alien frigate is a pincer: a directional C, its mouth facing forward, holding
a singularity in the jaws. Ringed with turrets, no visible boosters, and green,
burning green where it is cut. Flying into the well is bad news, so the approach
is the fight. Cut the hull while the well is live and the halves are wreckage
inside a field that no longer knows them, which is the ship killing itself if you
time the shot: emergent, not edge cased.

An alien drive can burn its own way by saying so, since a flame is the engine's
and not the hull's. No boosters means no `engine` hardpoints at all, and a hull
with none cannot move under its own power, so a pincer that drifts on its field
alone needs no rule of its own either.

## Alien weapons

New guns for the alien hulls, and new entries in the `ROCK_TURRETS` pool so
rocks can mount them too. Room here for a shot that does more than damage: a
mini black hole that drags in whatever passes near it, drawn as a shader.

A singularity draws in particles while it charges, and loose shots. It does not
drag rocks around; the sector heaving toward a point is mayhem, and the contact
solver would not survive it.

## The alien shield

Alien hulls carry a repel shield instead of a bubble. It absorbs lasers the way
any shield does, paying energy for the damage, and it shoves everything else
away: rocks, shots and other ships alike. What it costs to run follows what it is
holding off, so a hull backed into a rock field bleeds energy far faster than one
in open space, and burying it in debris is a way to strip it.

A shield prices each damage channel separately now, so a field that is hard to
shoot through and expensive under a beam is something the registry can already
say. What it cannot say yet is a cost that follows what the field is pushing.

Generating a singularity defeats the repel. The well needs to draw shots in, and
it cannot do that through a field pushing them out, so the ship is bare for as
long as it is winding up. That is the same window the hull can be cut in, which
puts the fight on one clock: the moment it is most dangerous is the moment it can
be killed.

It is drawn as a direct offset outline of the ship itself, with convex regions
smoothed out, so the shape of the shield is the shape of the ship.

## Length and difficulty

Stretch the content to fill around 30 sectors and tune the ramp across them. The
curve is spread over `SPAWN`, `HAZARD_TRAITS` and each ship's own `spawn` block,
so it is worth asking whether difficulty can be visualised before it is tuned.

Prices want a pass with it. The radar marks and the thrusters were priced to be
reachable rather than to be right.

## A boss

An in-world boss with no special-cased mechanics behind it: an alien ship that
survives being cut in half and grows the missing half back.

## Maybe

Small things, none of them load-bearing.

- **Thruster puffs.** A set of maneuvering thrusters is drawn nowhere. It could
  puff where the turn comes from, the way an engine's flame sits at its nozzle,
  which would also show what a hull is doing when it is only turning.
- **Mass that is lost.** A module weighs something, but nothing stops weighing
  when it is destroyed. A rock's turret can be shot off; when a hull's can be,
  what it was carrying should come off the hull's mass with it.
- **Guns the player picks.** The nose is a mount like any other, so the beam could
  become a slot with alternatives in it rather than a ladder of one gun.

## Specials

The current set wants tuning, and there is space for two more:

- **stop time**
- **warp**, launching the ship along its facing at high speed as a dash strike,
  in the manner of the Holdo maneuver

## Long term

Speculative, none of it costed.

- Equipment that takes something away as well as giving: a shield that turns
  incoming fire into energy and does without passive regen. The slots exist now,
  so this is a matter of writing one.
- Other modes: survival, dogfight.
- Deformation of rocks and hulls where projectiles land.
- Ships that fly in and install turrets or mines on rocks.
