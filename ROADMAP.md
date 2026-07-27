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

Any hull in the game can be flown from the dev page. The shop finds its mounts by
the role each plays rather than by index, a turret is fitted per mount, and whatever
the hull carries is found and swappable against the yard's own from then on. It is a
dev tool and nothing is balanced around it, but it is also the groundwork for
unlockable weapons and for an alternate player ship: see Aliens.

The player's ship is most of the way to being an ordinary hull that is simply
never spawned. Its outline, cell, drive, thrusters, shield, radar and guns are all
fitted equipment read through the same relationships as any rival's; what is left
on CONFIG is drag, which is a control aid rather than a property of the hull.

Around that sits a run of 40 sectors that is still getting harder at the end of it
(see Length and difficulty), and a run ends when the ore does rather than when the
ships do: the last ship lost offers another at the shop's price for one, as often
as what was mined will pay for it.

## Aliens

A third faction, hostile to the player and to the rivals alike, held back to the
last stretch of a run: the scout from sector 20, the seeker from 25 and the pincer
from 30, each rare on arrival and common by 40. All three hulls are in, one per
rival tier, so the spawn tables and the controllers carried over and being alien is
a faction, a colour and how it is drawn. They fight rivals as readily as the
player, since every gun asks one question of the faction table.

What is there: the shapes, green, the pincer's jaw guns held to the front by a mount
arc, the singularity it holds in them, drives that burn green with a rounded plume,
a permanent faint ripple in the space each one occupies, `ALIEN_PLATING`, so a cut
alien burns and smokes in their own colour, a sky that turns over to them as the run
does (about half the planets behind a sector 40 fight are theirs, sickly green and
pulsing), guns in their own yellow-green, beams that bend the space along their whole
length, and a round that tears the picture wherever it lands rather than only on the
player. The pincer holds its field up rather than spending it on the gun, and comes
round twice as fast as its mass says it should, because a hull that slow is beaten by
standing behind it. What is not:

- **The glitch over them.** They bend space around themselves, but the tearing that
  is meant to go with it only happens where their shots land. Over a hull it wants
  to be constant and low: organic, wrong, and a little outside the game the rest of
  the screen is playing.
- **A spawn budget of their own.** They share the rivals' one, so an alien arriving
  is a rival that did not. `PROGRESSION.rivals` wants generalising to a table per
  faction.
- **A reason to meet their weapons before sector 20.** Every module an alien hull
  carries is an EQUIPMENT option now, locked until a run has one, and flying the hull
  is what finds it. That is the machinery for unlocking a warp orb or a singularity
  gun in ordinary play; what it wants is the way in. Salvage off a cut hull is the
  obvious one, and nothing about it needs new code beyond deciding when it drops.

The singularity in the jaws is the fight the pincer was drawn for, and it is there:
flying into the well is bad news, so the approach is the fight, and a hull cut while
its own well is live leaves halves inside a field that no longer knows them.

The pincer's mouth is a real void: contact is decided part by part, so a rock sits
in the jaws touching nothing and stays cuttable through the opening. Its hull is
1455 against a frigate's 1012, being more material at the same mass, which may want
an `armour` pass once there is something to fight it with.

No visible boosters is available whenever it is wanted: a flame belongs to the
engine, and a hull with no `engine` hardpoint cannot move under its own power, so a
pincer that drifts on its field alone needs no rule of its own.

## Alien weapons

Alien guns work like the ones already in the game, projectiles and beams through the
same modules and controllers, and do their damage by warping the space around them
rather than by burning or striking it. All of it is one capability, a local
distortion of what is behind a thing, stated as data on a weapon or a hull and read
by one pass in the renderer: a source names a point or a line, how far it reaches and
how hard it bends.

The beam bends the space along its whole length, the orbs bend it as they travel and
fall toward what they were thrown at, and the hulls ripple the space they sit in. A
round tears the picture where it lands, whatever it landed on. The singularity is the
far end of the same idea: it winds up, drawing in particles and loose shot; it costs
as it winds rather than at the shot; it is let go of to fire; and two of them fall
toward each other, bounded so a pair cannot outrun the ship watching them. It does
not drag rocks around, and it never will: the sector heaving toward a point is mayhem
the contact solver would not survive.

What is left of it: entries in the `ROCK_TURRETS` pool so rocks can mount alien guns,
which is data and no code.

## The alien shield

Alien hulls carry a repel shield instead of a bubble. It absorbs lasers the way
any shield does, paying energy for the damage, and it shoves everything else
away: rocks, shots and other ships alike. What it costs to run follows what it is
holding off, so a hull backed into a rock field bleeds energy far faster than one
in open space, and burying it in debris is a way to strip it.

All three alien hulls carry one. A shield prices each damage channel separately and
pays per unit of momentum it turns away, so what it costs to run is what it is
holding off. What is not there is the last line of this section: the field is still
drawn as a ring rather than as the hull's own shape.

Generating a singularity defeats the repel. The well needs to draw shots in, and
it cannot do that through a field pushing them out, so the ship is bare for as
long as it is winding up. That is the same window the hull can be cut in, which
puts the fight on one clock: the moment it is most dangerous is the moment it can
be killed.

It wants to be drawn as a direct offset outline of the ship itself, with convex
regions smoothed out, so the shape of the shield is the shape of the ship. That is
its own project: everything that meets a shield meets a circle, and
`KNOWN_ISSUES.md` measures how far the drawn ring already diverges from it.

## Length and difficulty

A run is 40 sectors and the ramp is spread across all of them: hulls arrive a tier
at a time (scout 2, seeker 8, frigate 14, alien scout 20, alien seeker 25, alien
pincer 30), each fading in from a small share rather than appearing at full weight,
and the rock count, the share of rocks armed, the number of rivals alive and the
gap between arrivals are all still moving at sector 40. timeline.html is where the
curve is read; the tests hold its shape rather than its numbers.

What is left of it:

- **Prices.** The radar marks and the thrusters were priced to be reachable rather
  than to be right, and nothing has been repriced against a run twice as long as
  the one they were set for.
- **The specials pool.** They arrive one kind at a time now, but which kind is worth
  meeting when is a first guess: repel 5, refuel 8, ore magnet 11, booster 15, multi
  19, stealth 25.
- **What a sector pays.** Ore per rock and the kill and clear bonuses were set
  against a run that was effectively over by sector 15. Whether 40 sectors of them
  buys too much, or not enough, is a question for play rather than for a table.

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
- **A mount's arc, drawn.** A gun held to the front is invisible until it declines
  to fire. The nub could show what it covers, at least while it has a target it
  cannot answer.
- **Guns the player picks.** The nose is a mount like any other, so the beam could
  become a slot with alternatives in it rather than a ladder of one gun.
- **Aiming a hull's own guns.** A flown hull's turrets fire through their own
  controllers, which is fine to watch and impossible to direct: the player has one
  aimable mount and a frigate has four guns doing as they please.
- **A cell for every core.** Only `minerCore` has an upgrade ladder, so a hull flown
  from the dev page has whatever fixed cell its own core states and the shop's CORE
  row sells it levels it does not have. Four levels per core is data.
- **A continue that gets dearer.** Buying back into a run costs the shop's flat
  price for a ship every time. Charging more for each one in a row would make a
  hoard finite in a way a flat price does not, at the cost of a second number
  saying what a life is worth.

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
