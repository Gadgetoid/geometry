# Roadmap

Where GEOMETRY II might go next, roughly in build order. Nothing here is
committed, and the further down the page an item sits the less thought it has
had.

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

Generating a singularity defeats the repel. The well needs to draw shots in, and
it cannot do that through a field pushing them out, so the ship is bare for as
long as it is winding up. That is the same window the hull can be cut in, which
puts the fight on one clock: the moment it is most dangerous is the moment it can
be killed.

It is drawn as a direct offset outline of the ship itself, with convex regions
smoothed out, so the shape of the shield is the shape of the ship.

## Equipment, and handling that comes out of it

A hull is an outline with things bolted to it, and how it flies should follow from
what is bolted where. Engines are modules now. The rest follows:

- Maneuvering thrusters are drawn nowhere. A set that brings a hull about ought to
  puff where the turn comes from, the way an engine's flame sits at its nozzle.
- A module's mass is not felt when it is lost. A rock's turret can be shot off;
  when a hull's can be, what it was carrying should stop weighing.

Done, and left here for the shape of it: how a ship flies is worked out from what
is bolted to it, by one method every ship runs. A drive decides acceleration and
top speed, a set of maneuvering thrusters decides the turn and never the other way
about, and everything divides by what the hull weighs with its loadout aboard, so
fitting more costs handling. A frigate with siege engines sweeps through an arc it
cannot shorten; a fully fitted player ship gives up 5.7% of its acceleration, top
speed and turn, and the quicker thrusters are sold as the answer to that.

The player's ship is most of the way to being an ordinary hull that is simply
never spawned: its outline, cell, drive, thrusters, shield, radar and guns are all
fitted equipment read through the same relationships as any rival's. What is left
on CONFIG is drag, which is a control aid rather than a property of the hull.

## Length and difficulty

Stretch the content to fill around 30 sectors and tune the ramp across them. The
curve is spread over `SPAWN`, `HAZARD_TRAITS` and each ship's own `spawn` block,
so it is worth asking whether difficulty can be visualised before it is tuned.

## A boss

An in-world boss with no special-cased mechanics behind it: an alien ship that
survives being cut in half and grows the missing half back.

## Upgrades and powerups

The current set wants tuning, and there is space for three more:

- **stop time**
- **warp**, launching the ship along its facing at high speed as a dash strike,
  in the manner of the Holdo maneuver
- **radar**, showing off-screen rocks, ore, rivals and powerups

## Long term

Speculative, none of it costed.

- Passive upgrade slots. The shop's levelled upgrades become fittings competing
  for a limited number of slots, which makes room for upgrades that take
  something away as well as give: a shield that turns incoming fire into energy
  and does without passive regen.
- Other modes: survival, dogfight.
- Deformation of rocks and hulls where projectiles land.
- Ships that fly in and install turrets or mines on rocks.
