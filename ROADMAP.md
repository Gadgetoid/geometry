# Roadmap

Where GEOMETRY II might go next, roughly in build order. Nothing here is
committed, and the further down the page an item sits the less thought it has
had.

Only what is planned. What is already built is described where it is built, and
`KNOWN_ISSUES.md` holds what is known and unfixed.

## Aliens

A third faction, hostile to the player and to the rivals alike, held back to the last
stretch of a run. All three hulls are in, one per rival tier. What is left:

- **The glitch over them.** They bend space around themselves, but the tearing that
  is meant to go with it only happens where their shots land. Over a hull it wants
  to be constant and low: organic, wrong, and a little outside the game the rest of
  the screen is playing.
- **A spawn budget of their own.** They share the rivals' one, so an alien arriving
  is a rival that did not. `PROGRESSION.rivals` wants generalising to a table per
  faction.
- **A reason to meet their weapons before sector 20.** Every module an alien hull
  carries is an EQUIPMENT option, locked until a run has one, and flying the hull is
  what finds it. That is the machinery for unlocking a warp orb or a singularity gun
  in ordinary play; what it wants is the way in. Salvage off a cut hull is the
  obvious one, and nothing about it needs new code beyond deciding when it drops.
- **An `armour` pass on the pincer.** Its hull is 1455 against a rival frigate's
  1012, being more material at the same mass. Worth revisiting once there is
  something to fight it with.

## Alien weapons

Entries in the `ROCK_TURRETS` pool, so a rock can mount an alien gun. Data, and no
code.

## The alien shield

The field is drawn as a ring. It wants to be a direct offset outline of the ship
itself, with convex regions smoothed out, so the shape of the shield is the shape of
the ship.

That is its own project: everything that meets a shield meets a circle, and
`KNOWN_ISSUES.md` measures how far the drawn ring already diverges from it.

## Length and difficulty

A run is 40 sectors and every part of the ramp is still climbing at the end of it.
`timeline.html` is where the curve is read. What is left:

- **Prices.** The radar marks and the thrusters were priced to be reachable rather
  than to be right, and nothing has been repriced against a run twice as long as
  the one they were set for.
- **The specials pool.** They arrive one kind at a time, but which kind is worth
  meeting when is a first guess: repel 5, refuel 8, ore magnet 11, booster 15, multi
  19, stealth 25.
- **What a sector pays.** Ore per rock and the kill and clear bonuses were set
  against a run that was effectively over by sector 15. Whether 40 sectors of them
  buys too much, or not enough, is a question for play rather than for a table.

## A boss

An in-world boss with no special-cased mechanics behind it: an alien ship that
survives being cut in half and grows the missing half back.

## The shape of the source

`src/config.js` is around 3,900 lines, and about a quarter of it is not description
of the game at all: it is menu wiring. `PAUSE_MENU`, `DEV_MENU`, `DEV_SPAWN_MENU`,
`OVER_MENU`, `SHOP` and `SHOP_LAYOUT`, plus the row helpers and the dev page's
labels, describe pages rather than ships.

Hoisting them into a `src/menus.js` is the next tidy, and it is cheaper than it
looks: the dependency already points one way. The menu tail reads `CONFIG`,
`EQUIPMENT`, `SHIP_TYPES`, `SPECIAL_TYPES`, `CORE_TYPES` and the `DEV_*` helpers,
and nothing above it reads anything back, so the move is mechanical and the suite
either stays green or it does not. The input tables, `BINDABLE_CONTROLS`,
`BINDING_DEVICES`, `PAD_LAYOUT` and `GAMEPAD`, would go the same way into a
`src/controls.js`.

`EQUIPMENT` is the awkward one and should stay put. It is the largest UI-looking
block in the file, but it is not only UI: `fitEquipment` and `unlockHullFitting`
read it to decide what is actually bolted to a hull, and `freshEquipment` and
`yardOptions` sit on top of it. Only the rows that present it belong on a menu page.

Beyond that, and as a maybe: the registries themselves want breaking into
manageable units, which past a certain number of files starts wanting a build
step. That is a trade rather than an improvement. The game runs today by opening
`index.html` with no tooling between the source and the thing running, which is
worth a great deal: it is why a dev page can be a page and why nothing has to be
installed to try a change. A build step buys smaller files and costs that. Worth
doing only when the file count makes the current arrangement the harder one to
work in, and not before.

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
- **Stackable specials?** Whether a slot can hold more than one of a kind, so a
  duplicate found in the field is worth going for rather than passed over. Open,
  because it cuts against what a slot currently is: an addressable thing with its
  own cooldown, which is what makes the pop-over and the HUD boxes work. Either a
  count on the slot, or a level, which the slot object was already shaped to take.

## Specials

The set wants tuning, and there is space for two more:

- **stop time**
- **warp**, launching the ship along its facing at high speed as a dash strike,
  in the manner of the Holdo maneuver. The railgun's `wake` is the candidate
  mechanism and most of the work: a slab of bent space closing behind something
  travelling fast, laid down a point at a time and held after the thing has gone.
  A dash wants exactly that behind the ship, so what is left is who lays it and
  what the dash does to whatever it crosses.

## Long term

Speculative, none of it costed.

- Equipment that takes something away as well as giving: a shield that turns
  incoming fire into energy and does without passive regen. The slots exist now,
  so this is a matter of writing one.
- Other modes: survival, dogfight. The dogfight is being prototyped behind the dev
  switch, where `DOGFIGHT_HULLS` and the arena's own AUTO spawner already set one
  going; what a mode wants past that is a way in that is not the dev page, and
  something to be scored on.
- Deformation of rocks and hulls where projectiles land.
- Ships that fly in and install turrets or mines on rocks.
