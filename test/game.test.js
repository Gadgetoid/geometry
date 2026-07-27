// Simulation tests. The Game is headless - `new Game()` works under plain node
// and `advance(dt)` steps the world - so gameplay is testable directly.
//
// Two traps these tests exist to stay out of:
//   * A fresh sector warps the ship in, and a ship mid-warp is intangible, so a
//     probe that forgets `beSolid` measures nothing and passes for the wrong
//     reason. `beSolid` is used everywhere damage or contact is involved.
//   * Rock mass is clamped (AST_MASS_RANGE), so momentum is only conserved in
//     the solver's own mass units, not in area.

import test from "node:test"
import assert from "node:assert/strict"

import { Game, MAX_PARTICLES } from "../src/game.js"
import { GameView } from "../src/view.js"
import { PALETTE } from "../src/palette.js"
import {
  Asteroid,
  Ore,
  Special,
  Projectile,
  RivalShip,
  Shield,
  Weapon,
  oreFromFragment,
  shapeContact,
  resolveHullRockContact,
  rockMass,
  Singularity,
} from "../src/entities.js"
import {
  ARENA,
  BINDABLE_CONTROLS,
  BINDING_DEVICES,
  CONFIG,
  ENGINE_TYPES,
  HAZARD_TRAITS,
  weightAt,
  MAX_SLOTS,
  PLAYER_TYPE,
  SPECIAL_IDS,
  SPECIAL_TYPES,
  PROGRESSION,
  SHIELD_TYPES,
  SHIP_PLATING,
  SHIP_SCALARS,
  SHOP,
  UI_SCALES,
  VIEW_W,
  VIEW_H,
  WEAPON_TYPES,
  SHIP_TYPES,
  CORE_TYPES,
  EQUIPMENT,
  thrustOf,
  torqueOf,
  ladenMass,
  barrelCount,
  deriveShipStats,
} from "../src/config.js"
import {
  convexContact,
  convexPartition,
  countBeamCrossings,
  mulberry32,
  pointInPolygon,
  polygonArea,
  shortestTurn,
  bearingTo,
} from "../src/math.js"

// A rival as the spawner would bring it in, carrying its design's own loadout and
// none of the arms it might have rolled. Passing an empty loadout instead would be a
// hull with no engine, no core and no thrusters, which cannot fly at all.
function plainRival(x, y, typeName, loadout = SHIP_TYPES[typeName].loadout) {
  return new RivalShip(x, y, typeName, loadout)
}

// A live sector with a solid, vulnerable ship and nothing else in it.
function liveGame() {
  const game = new Game()
  game.startNewGame()
  game.phase = "play"
  game.asteroids = []
  game.rivals = []
  beSolid(game.player)
  return game
}

// Fire the player's laser at a charge held for it. The reload rolls on, so the
// cooldown is cleared and the cell refilled: a probe that skips either measures
// a shot that never went.
function fullChargeShot(game, chargeFraction = 1, overdrive = 0) {
  const player = game.player,
    weapon = player.mainWeapon
  weapon.cooldown = 0
  weapon.charge = weapon.type.chargeMax * chargeFraction
  weapon.overdrive = overdrive
  player.energy = player.energyMax
  game.laserShots = []
  player.fireLaser(game)
}

// Put a special in a slot, and read back what the slots hold. Slots carry an
// object each so they can hold a cooldown, so a test says what it means by id.
function equip(game, slot, id) {
  return game.player.equip(slot, id)
}
function carried(game) {
  return game.player.items.slice(0, game.specialSlots()).map((item) => (item ? item.id : null))
}

// A loadout with the shield taken off, wherever it is fitted: on a hardpoint of
// its own, or in the core alongside the radar.
function withoutShield(loadout) {
  return loadout
    .filter((entry) => !entry.shield)
    .map((entry) => {
      if (!entry.fitted || !entry.fitted.shield) {
        return entry
      }
      const fitted = { ...entry.fitted }
      delete fitted.shield
      return { ...entry, fitted }
    })
}

// Fit a laser mark, owning it first the way buying it would. Marks are a ladder, so
// everything below it comes too.
function withLaser(game, id) {
  return withEquipment(game, "laser", id)
}

// The first mark that has a field, and the one below it, for a test that wants to
// show a mark paying for something.
function laserMarkThat(field) {
  const options = EQUIPMENT.laser.options
  const at = options.findIndex((option) => WEAPON_TYPES[option.id][field])
  assert.ok(at > 0, `some laser mark should carry ${field}`)
  return { with: options[at].id, without: options[at - 1].id }
}

// Buy the next level of a levelled upgrade, through the pop-over its row opens.
function buyNextLevel(game, id) {
  const at = game.upgrades[id]
  game.openLevelMenu(id)
  game.slotMenu.selection = at + 1
  game.levelRows(id)[at + 1].action(game)
  game.slotMenu = null
}

// Slots come with the power core, so a test wanting room buys its way to it.
function withSlots(game, wanted) {
  const level = CORE_TYPES.minerCore.levels.findIndex((step) => step.special >= wanted)
  assert.ok(level >= 0, `no core level offers ${wanted} slots`)
  game.upgrades.core = level
  game.player.energyMax = game.maxEnergy()
  game.player.energy = game.player.energyMax
  return game
}

// A fresh hull leaves the yard with its one slot holding the ore magnet, and that
// counts as having met one, so a test about an empty slot with an empty shelf has
// to undo both.
function clearSlots(game) {
  game.player.items.fill(null)
  game.seenSpecials.clear()
  return game
}

// Fit an equipment option, owning it the way buying it would. A ladder brings
// everything below it too, since that is what climbing one leaves behind.
function withEquipment(game, slot, id) {
  const options = EQUIPMENT[slot].options
  const wanted = options.findIndex((option) => option.id === id)
  assert.ok(wanted >= 0, `no ${slot} option called ${id}`)
  const owned = EQUIPMENT[slot].ladder ? options.slice(0, wanted + 1) : [options[wanted]]
  game.upgrades.owned[slot] = owned.map((option) => option.id)
  game.upgrades.fitted[slot] = id
  game.player.fitEquipment(game)
  return game
}

// The mark of an option at `index` in a slot, for a test that wants the first or
// the last of a ladder without naming it.
function optionAt(slot, index) {
  const options = EQUIPMENT[slot].options
  return options[index < 0 ? options.length + index : index].id
}

// A shield is bought, not issued: a run starts without one.
function withShield(game, mark = optionAt("shield", 0)) {
  return withEquipment(game, "shield", mark)
}

// The ship arrives by warping in, and is intangible until it lands.
function beSolid(player) {
  player.warp = 1
  player.warpTarget = 1
  player.warpHold = 0
  player.invincible = 0
  return player
}

const square = (cx, cy, half) => [
  { x: cx - half, y: cy - half },
  { x: cx + half, y: cy - half },
  { x: cx + half, y: cy + half },
  { x: cx - half, y: cy + half },
]

const playerWeapon = { type: WEAPON_TYPES.playerLaserMk1 }

// Run `body` with Math.random replaced by a seeded sequence, for anything whose
// result depends on a random rock silhouette. Restores the real one afterwards.
function seeded(seed, body) {
  const rng = mulberry32(seed)
  const real = Math.random
  Math.random = rng
  try {
    return body()
  } finally {
    Math.random = real
  }
}

test("a game runs headless without a browser", () => {
  const game = new Game()
  game.startNewGame()
  for (let i = 0; i < 600; i++) {
    game.advance(1 / 60)
  }
  assert.ok(game.inSector())
  assert.ok(game.asteroids.length > 0)
})

// ---- rock against rock ----------------------------------------------------

test("a rock collision conserves momentum in the solver's mass units", () => {
  const game = liveGame()
  const big = new Asteroid({ vertices: square(0, 0, 100), vx: 100, vy: 0 })
  const small = new Asteroid({ vertices: square(107, 0, 15), vx: 0, vy: 0 })
  game.asteroids = [big, small]
  const before = big.mass * big.vx + small.mass * small.vx
  game.resolveAsteroidCollisions()
  const after = big.mass * big.vx + small.mass * small.vx
  assert.ok(Math.abs(after - before) < 1e-9, `momentum ${before} -> ${after}`)
})

test("a heavy rock is barely deflected by a light one", () => {
  const game = liveGame()
  const big = new Asteroid({ vertices: square(0, 0, 100), vx: 100, vy: 0 })
  const small = new Asteroid({ vertices: square(107, 0, 15), vx: 0, vy: 0 })
  game.asteroids = [big, small]
  assert.ok(big.mass > small.mass * 5, "the pair must actually differ in mass")
  game.resolveAsteroidCollisions()
  // an equal-mass swap would leave the boulder stationary
  assert.ok(big.vx > 70, `boulder kept ${big.vx.toFixed(1)} of 100`)
  assert.ok(small.vx > big.vx, "the chip is thrown clear")
})

test("the rocks a sector spawns differ in mass", () => {
  // The clamp is a guard against extremes, not the thing that sets the answer:
  // a ceiling of 4 sat below everything a sector spawns, so every rock in the
  // field weighed exactly the same and no boulder could shrug off any chip.
  const game = new Game()
  game.startNewGame()
  const masses = []
  for (let sector = 1; sector <= 12; sector++) {
    game.startLevel(sector)
    for (const rock of game.asteroids) {
      masses.push(rock.mass)
    }
  }
  assert.ok(masses.length > 20, "enough rocks to say anything")
  const atCap = masses.filter((m) => m === CONFIG.AST_MASS_RANGE[1]).length
  assert.equal(atCap, 0, `${atCap} of ${masses.length} spawned rocks are pinned to the clamp`)
  const spread = Math.max(...masses) / Math.min(...masses)
  assert.ok(spread > 1.5, `spawned rock mass spans a factor of ${spread.toFixed(2)}`)
})

test("a rock collision honours ROCK_RESTITUTION", () => {
  const game = liveGame()
  const a = new Asteroid({ vertices: square(0, 0, 60), vx: 80, vy: 0 })
  const b = new Asteroid({ vertices: square(115, 0, 60), vx: -80, vy: 0 })
  game.asteroids = [a, b]
  const approach = a.vx - b.vx
  game.resolveAsteroidCollisions()
  const separation = b.vx - a.vx
  assert.ok(
    Math.abs(separation / approach - CONFIG.ROCK_RESTITUTION) < 1e-6,
    `restitution ${(separation / approach).toFixed(3)}`,
  )
})

test("a rock wedged between two others settles instead of jittering", () => {
  const game = liveGame()
  const middle = new Asteroid({ vertices: square(0, 0, 30), vx: 0, vy: 0 })
  game.asteroids = [
    new Asteroid({ vertices: square(-120, 0, 90), vx: 20, vy: 0 }),
    middle,
    new Asteroid({ vertices: square(120, 0, 90), vx: -20, vy: 0 }),
  ]
  const speeds = []
  for (let i = 0; i < 240; i++) {
    game.advance(1 / 60)
    speeds.push(Math.hypot(middle.vx, middle.vy))
  }
  const settled = speeds.slice(-30)
  const spread = Math.max(...settled) - Math.min(...settled)
  assert.ok(spread < 5, `speed varied by ${spread.toFixed(1)} u/s once settled`)
})

// ---- the player is a hull, not a circle -----------------------------------

test("a rock reaches the nose, which sits beyond the old collision circle", () => {
  const game = liveGame()
  const player = game.player
  player.angle = 0 // nose along +x
  player.x = 400
  player.y = 320
  player.vx = 0
  player.vy = 0
  const nose = Math.max(...player.worldOutline().map((p) => p.x)) - player.x
  assert.ok(nose > player.radius, "the nose must reach past `radius` for this to mean anything")
  // a wall just beyond the old circle but inside the nose's reach
  const wallX = player.x + (player.radius + nose) / 2
  game.asteroids = [new Asteroid({ vertices: square(wallX + 80, 320, 80), vx: 0, vy: 0 })]
  game.advance(1 / 60)
  assert.ok(game.stats.damage > 0, "contact on the nose must register")
})

// A bare hull, so the outline is the surface a shot has to reach. With a shield
// raised the bubble is the surface instead, which the next test covers.
function bareHullGame() {
  const game = liveGame()
  const player = game.player
  player.angle = 0 // nose along +x, so the hull tapers to a point at the tail
  player.x = 400
  player.y = 320
  return game
}

test("a shot through the empty space beside a bare hull misses", () => {
  const game = bareHullGame()
  const player = game.player
  const tailX = Math.min(...player.worldOutline().map((p) => p.x))
  // Level with the tail but out at the full collision radius: this used to be
  // inside the circle, while the hull there is a single point.
  const bullet = new Projectile(tailX + 1, player.y + player.radius - 1, 0, 0, 100, null)
  game.projectiles = [bullet]
  game.advance(1 / 60)
  assert.equal(game.stats.damage, 0, "empty space beside the hull must not register")

  // ...and a shot on the hull itself still lands.
  const game2 = bareHullGame()
  game2.projectiles = [new Projectile(400, 320, 0, 0, 100, null)]
  game2.advance(1 / 60)
  assert.ok(game2.stats.damage > 0, "a shot on the hull must land")
})

test("a shot is stopped by the shield bubble, on the same surface a beam is", () => {
  const bubble = PLAYER_TYPE.bubbleRadius
  const shootFrom = (offset) => {
    const game = withShield(liveGame())
    const player = game.player
    player.angle = 0
    player.x = 400
    player.y = 320
    assert.ok(player.shieldUp(), "the bubble must actually be raised")
    const bullet = new Projectile(200, 320 + offset, 900, 0, 100, null)
    game.projectiles = [bullet]
    for (let i = 0; i < 400 && !bullet.dead; i++) {
      bullet.update(1 / 600, game)
    }
    return game.stats.damage > 0
  }
  // Well inside the drawn bubble but clear of the hull, which is 11 units deep:
  // a shot here used to sail straight through the shield.
  for (const offset of [0, 8, 14, 18, 21]) {
    assert.ok(
      shootFrom(offset),
      `a shot ${offset} from the centre must strike a bubble of ${bubble}`,
    )
  }
  // and outside it, nothing
  for (const offset of [26, 34, 60]) {
    assert.ok(!shootFrom(offset), `a shot ${offset} from the centre clears a bubble of ${bubble}`)
  }
})

test("a shot strikes a shielded rock on its bubble too", () => {
  const game = liveGame()
  const rock = new Asteroid({
    vertices: square(600, 320, 60),
    traits: { shield: { shield: "standard" } },
  })
  // vertices skip hazard mounting, so mount the shield the way the spawner does
  rock.hardpoints.push({ x: rock.center.x, y: rock.center.y, module: new Shield("standard") })
  rock.refreshEnergy()
  game.asteroids = [rock]
  assert.ok(rock.shieldUp())
  const bubble = rock.shieldRadius()
  assert.ok(bubble > rock.boundRadius, "the bubble must stand clear of the outline")
  // between the outline and the bubble: the gap a shot used to fly through
  const bullet = new Projectile(200, 320 + (rock.boundRadius + bubble) / 2, 900, 0, 100, null)
  game.projectiles = [bullet]
  const before = rock.energy
  for (let i = 0; i < 600 && !bullet.dead; i++) {
    bullet.update(1 / 600, game)
  }
  assert.ok(rock.energy < before, "the shot must drain the shield it visibly struck")
})

test("the player's collision parts tile its drawn outline exactly", () => {
  const game = liveGame()
  const player = game.player
  const outline = player.worldOutline()
  const parts = player.collisionOutline()
  const total = parts.reduce((sum, part) => sum + polygonArea(part), 0)
  assert.ok(parts.length >= 1)
  assert.ok(
    Math.abs(total - polygonArea(outline)) < 1e-6,
    `parts cover ${total.toFixed(2)} of ${polygonArea(outline).toFixed(2)}`,
  )
})

test("a ship driven into a corner is not left inside either rock", () => {
  const game = liveGame()
  const player = game.player
  player.invincible = 1e9 // isolate the geometry from the damage it would cause
  const floor = new Asteroid({
    vertices: [
      { x: 200, y: 400 },
      { x: 600, y: 400 },
      { x: 600, y: 520 },
      { x: 200, y: 520 },
    ],
  })
  const wall = new Asteroid({
    vertices: [
      { x: 600, y: 100 },
      { x: 760, y: 100 },
      { x: 760, y: 400 },
      { x: 600, y: 400 },
    ],
  })
  game.asteroids = [floor, wall]
  player.x = 570
  player.y = 370
  const speed = 200
  // What the hull could travel in one step. The solver may be caught mid-frame
  // with the ship part of the way in, but it must never end a frame deeper than
  // the ship could have moved during it, or it is losing ground rather than
  // holding it. How much of that shows depends on how far the rocks give: these
  // slabs are heavy enough to stay put, which is the worst case for the ship.
  const oneStep = (Math.hypot(speed, speed) * 1) / 60
  const trace = []
  for (let i = 0; i < 180; i++) {
    for (const rock of game.asteroids) {
      rock.vx = 0
      rock.vy = 0
      rock.spin = 0
    }
    player.vx = speed
    player.vy = speed // keep driving into the corner
    game.advance(1 / 60)
    let deepest = 0
    for (const rock of game.asteroids) {
      deepest = Math.max(deepest, overlapDepth(rock.convexParts(), player.collisionOutline()))
    }
    trace.push(deepest)
  }
  const worst = Math.max(...trace)
  assert.ok(
    worst < oneStep,
    `deepest penetration ${worst.toFixed(2)} of a ${oneStep.toFixed(2)} step`,
  )
  // and it is not merely bounded: the ship works its way clear and stays clear
  const settled = Math.max(...trace.slice(60))
  assert.equal(settled, 0, `still ${settled.toFixed(2)} deep after a second of this`)
})

// Deepest overlap between two bodies given as convex parts, 0 when apart.
function overlapDepth(partsA, partsB) {
  let deepest = 0
  for (const a of partsA) {
    for (const b of partsB) {
      const contact = convexContact(a, b, centroidOf(a), centroidOf(b))
      if (contact) {
        deepest = Math.max(deepest, contact.depth)
      }
    }
  }
  return deepest
}

const centroidOf = (vertices) => ({
  x: vertices.reduce((sum, p) => sum + p.x, 0) / vertices.length,
  y: vertices.reduce((sum, p) => sum + p.y, 0) / vertices.length,
})

// ---- ships are solid to each other ----------------------------------------

// A hull bouncing off a rock must take the impulse its mass implies, whichever
// hull it is. The site used to divide by the hull's mass where its inverse
// belongs, which is invisible for the player (mass exactly 1) and wrong for
// everything else: a frigate got 7% of its due and a scout 177% of it.
//
// Momentum is conserved either way, because the impulse is applied symmetrically,
// so conservation cannot detect this. The magnitude is what has to be checked.
test("every hull takes the impulse its mass implies when it hits a rock", () => {
  for (const typeName of ["player", "scout", "frigate"]) {
    const game = liveGame()
    const ship = typeName === "player" ? game.player : plainRival(0, 0, typeName)
    ship.x = 400
    ship.y = 320
    ship.angle = 0
    ship.vx = 100
    ship.vy = 0
    // A rock squarely to the +x of the hull, at the same y: the contact normal is
    // -x and the lever arm through the rock's centre is zero, so the impulse is
    // the textbook one and can be checked without reproducing the solver. Depth 0
    // keeps the hull where it was put.
    const rock = new Asteroid({ vertices: square(400 + ship.boundRadius + 60, 320, 60) })
    const { closing } = resolveHullRockContact(ship, rock, { nx: -1, ny: 0, depth: 0 })

    assert.equal(closing, 100, `${typeName}: the rock is still, so closing is the hull's own speed`)
    const share = 1 / ship.mass + 1 / rockMass(rock.area)
    const j = ((1 + CONFIG.ROCK_RESTITUTION) * closing) / share
    const near = (got, want, what) =>
      assert.ok(
        Math.abs(got - want) < 1e-9 * Math.max(1, Math.abs(want)),
        `${typeName} ${what}: ${got.toFixed(4)}, expected ${want.toFixed(4)}`,
      )
    near(ship.vx - 100, -j / ship.mass, "hull velocity change")
    near(rock.vx, j / rockMass(rock.area), "rock velocity change")
    assert.ok(
      Math.abs(rock.spin) < 1e-12,
      `${typeName}: a contact through the centre must not spin the rock, got ${rock.spin}`,
    )
  }
})

test("a hull resting on a rock tolerates the same overlap as any other contact", () => {
  const game = liveGame()
  const player = game.player
  player.invincible = 1e9 // isolate the geometry from the damage it would cause
  const rock = new Asteroid({ vertices: square(400, 500, 90) })
  game.asteroids = [rock]
  player.x = 400
  player.y = 500 - 90 - 5
  for (let i = 0; i < 120; i++) {
    rock.vx = 0
    rock.vy = 0
    rock.spin = 0
    player.vx = 0
    player.vy = 60 // lean gently onto it
    game.advance(1 / 60)
  }
  const residual = overlapDepth(rock.convexParts(), player.collisionOutline())
  assert.ok(
    residual <= CONFIG.CONTACT_SLOP + 1e-6,
    `settled overlap ${residual.toFixed(3)} of a tolerated ${CONFIG.CONTACT_SLOP}`,
  )
})

// A rival killed part-way through a frame stays in game.rivals until the list is
// filtered after the update loop, so without a guard it took one more turn:
// it fired a parting shot and hoovered up the ore it had just dropped at its own
// feet, crediting it to the rival's haul.
test("a rival killed this frame takes no further turn", () => {
  const game = liveGame()
  const player = game.player
  player.x = 200
  player.y = 320
  player.angle = 0
  // a rock parked far away, so the sector does not count as cleared
  game.asteroids = [new Asteroid({ vertices: square(900, 900, 40) })]
  const scout = plainRival(500, 320, "scout")
  game.rivals = [scout]
  const beam = { a: { x: 200, y: 320 }, dir: { x: 1, y: 0 }, b: { x: 1100, y: 320 } }
  game.applyBeam(beam, player, playerWeapon, 300)
  assert.equal(scout.dead, true, "the beam must kill it")
  const dropped = game.oreChunks.length
  assert.equal(dropped, SHIP_TYPES.scout.oreDrop, "and it must drop its ore")

  const rivalScore = game.rivalScore
  game.advance(1 / 60)
  assert.equal(game.oreChunks.length, dropped, "a dead rival must not collect its own drop")
  assert.equal(game.rivalScore, rivalScore, "and must not be credited for it")
})

test("a dead rival's turret does not fire a parting shot", () => {
  const game = liveGame()
  game.player.x = 560
  game.player.y = 320
  game.asteroids = [new Asteroid({ vertices: square(900, 900, 40) })]
  const gunner = new RivalShip(500, 320, "scout", [
    { hp: 1, weapon: "autocannon", controller: "turret" },
  ])
  gunner.hardpoints[1].module.cooldown = 0
  gunner.dead = true // as it would be, mid-frame, after being killed elsewhere
  game.rivals = [gunner]
  game.advance(1 / 60)
  assert.equal(game.projectiles.length, 0)
})

test("a rival with no player to hunt still steers somewhere", () => {
  // Nothing in a sector runs without a player, but the hunter controller guards
  // for one and this did not, so the two disagreed about whether it can happen.
  const game = liveGame()
  const frigate = plainRival(400, 320, "frigate")
  game.rivals = [frigate]
  game.player = null
  assert.doesNotThrow(() => frigate.update(1 / 60, game))
})

// A rival is outside the arena while it flies in and again while it flies out.
// Out there it took beams, bullets and blasts like anything else, and cutting one
// down left debris that the arena confinement then teleported hundreds of units
// into the field on its first frame. It also fired from out there, which is the
// same disagreement the other way round.
function rivalBeyondTheRing(typeName, beyond) {
  const game = liveGame()
  // a rock parked far away, so the sector does not count as cleared
  game.asteroids = [new Asteroid({ vertices: square(ARENA.cx + 3000, ARENA.cy + 3000, 40) })]
  const distance = ARENA.radius + beyond
  const rival = plainRival(ARENA.cx + distance, ARENA.cy, typeName)
  rival.angle = Math.PI
  rival.vx = 0
  rival.vy = 0
  game.rivals = [rival]
  const player = game.player
  player.x = ARENA.cx + distance - 400
  player.y = ARENA.cy
  player.angle = 0
  return { game, rival, player }
}

test("a rival beyond the arena cannot be harmed, whatever reaches it", () => {
  for (const typeName of ["scout", "frigate"]) {
    const { game, rival, player } = rivalBeyondTheRing(typeName, 140)
    assert.equal(rival.insideArena(), false, `${typeName} must be fully outside the ring`)

    // a charged beam straight through it
    const beam = {
      a: { x: player.x, y: player.y },
      dir: { x: 1, y: 0 },
      b: { x: player.x + 900, y: player.y },
    }
    game.applyBeam(beam, player, playerWeapon, 400)
    assert.equal(rival.dead, false, `${typeName} must survive a beam out of bounds`)
    assert.equal(game.asteroids.length, 1, `${typeName} must leave no debris out of bounds`)

    // and a shot, and a blast
    rival.takeDamage(1e6, game, "projectile")
    assert.equal(rival.dead, false, `${typeName} must survive a shot out of bounds`)
    assert.equal(rival.energy, rival.energyMax, "and must not even lose shield energy")
  }
})

test("a rival beyond the arena holds its fire", () => {
  const { game, rival } = rivalBeyondTheRing("scout", 200)
  rival.hardpoints[1].module = new RivalShip(0, 0, "scout", [
    { hp: 1, weapon: "autocannon", controller: "turret" },
  ]).hardpoints[1].module
  rival.hardpoints[1].module.cooldown = 0
  // put it on screen and make the player a valid target, so nothing else gates it
  game.viewCenter.x = rival.x
  game.viewCenter.y = rival.y
  game.player.invincible = 0
  game.advance(1 / 60)
  assert.equal(game.projectiles.length, 0, "nothing may be fired from outside the ring")

  // ...and once it reaches the field, it does fire. The player comes in with it:
  // this is about the boundary gate, and a target left 660 units away is simply
  // outside a radarless hull's sensor floor.
  rival.x = ARENA.cx
  rival.y = ARENA.cy
  game.player.x = ARENA.cx + 120
  game.player.y = ARENA.cy
  game.viewCenter.x = ARENA.cx
  game.viewCenter.y = ARENA.cy
  assert.equal(rival.insideArena(), true)
  rival.hardpoints[1].module.cooldown = 0
  game.advance(1 / 60)
  assert.ok(game.projectiles.length > 0, "a rival in the field fires as before")
})

test("a departing rival is not dropped while it can still be seen", () => {
  const { game, rival } = rivalBeyondTheRing("frigate", 300)
  rival.leaving = true
  rival.lifeTimer = -1
  assert.equal(rival.insideArena(), false, "it must be clear of the ring")

  // the camera is looking straight at it, so it is off the ring but on screen
  game.viewCenter.x = rival.x
  game.viewCenter.y = rival.y
  game.advance(1 / 60)
  assert.equal(rival.dead, false, "a rival in view must not blink out")

  // look somewhere else entirely and it goes
  game.viewCenter.x = ARENA.cx
  game.viewCenter.y = ARENA.cy
  assert.equal(
    game.onScreen(rival.x, rival.y, rival.boundRadius + CONFIG.RIVAL_DESPAWN_MARGIN),
    false,
    "and for this half it must genuinely be off screen",
  )
  game.advance(1 / 60)
  assert.equal(rival.dead, true, "out of the ring and out of sight, it is dropped")
})

test("a departing rival still inside the arena is kept, however far off screen", () => {
  const game = liveGame()
  game.asteroids = [new Asteroid({ vertices: square(ARENA.cx + 3000, ARENA.cy + 3000, 40) })]
  // deep in the field but on the far side of the arena from the camera
  const rival = plainRival(ARENA.cx - 700, ARENA.cy, "scout")
  rival.leaving = true
  rival.lifeTimer = -1
  game.rivals = [rival]
  game.viewCenter.x = ARENA.cx + 700
  game.viewCenter.y = ARENA.cy
  assert.equal(rival.insideArena(), true)
  assert.equal(game.onScreen(rival.x, rival.y, rival.boundRadius), false, "and off screen")
  game.advance(1 / 60)
  assert.equal(rival.dead, false, "being off screen alone is not enough to drop it")
})

test("whether a rival hunts is declared on its type", () => {
  // It used to be inferred from a loadout entry naming the "hunter" controller,
  // so a new aggressive controller would silently not chase.
  assert.equal(plainRival(0, 0, "frigate").hunts, true, "with no loadout at all")
  assert.equal(new RivalShip(0, 0, "frigate", SHIP_TYPES.frigate.loadout).hunts, true)
  assert.equal(new RivalShip(0, 0, "scout", SHIP_TYPES.scout.loadout).hunts, false)
  assert.equal(!!SHIP_TYPES.frigate.hunts, true, "and it is the type that says so")
})

test("two rivals cannot occupy the same space", () => {
  const game = liveGame()
  game.player.x = -5000 // keep the player out of it
  const a = plainRival(600, 320, "frigate")
  const b = plainRival(611, 325, "frigate")
  a.angle = 0
  b.angle = 0
  game.rivals = [a, b]
  for (let i = 0; i < 300; i++) {
    game.advance(1 / 60)
  }
  // Resting contact keeps CONTACT_SLOP of overlap on purpose, so the test is
  // that nothing is interpenetrating beyond that, not that the centres are far
  // apart: two hulls lying alongside each other are legitimately close.
  const residual = overlapDepth(a.collisionOutline(), b.collisionOutline())
  assert.ok(
    residual <= CONFIG.CONTACT_SLOP + 1e-6,
    `hulls still overlap by ${residual.toFixed(2)} of a tolerated ${CONFIG.CONTACT_SLOP}`,
  )
})

test("the player cannot be flown through a frigate", () => {
  const game = liveGame()
  const frigate = plainRival(600, 320, "frigate")
  frigate.angle = 0
  frigate.lifeTimer = 1e9
  game.rivals = [frigate]
  const player = game.player
  player.x = 600
  player.y = 320
  for (let i = 0; i < 120; i++) {
    game.advance(1 / 60)
  }
  assert.ok(
    Math.hypot(frigate.x - player.x, frigate.y - player.y) > 10,
    "the pair must be pushed apart",
  )
})

test("a light ship bounces off a heavy one without shifting it much", () => {
  const game = liveGame()
  game.player.x = -5000
  const frigate = plainRival(600, 320, "frigate")
  frigate.angle = 0
  // nose just inside the frigate's tail face, closing along +x: a shallow
  // contact, as one caught on the frame it forms would be
  const tailX = Math.min(...frigate.worldOutline().map((p) => p.x))
  const scout = plainRival(tailX - 12, 320, "scout")
  scout.angle = 0
  scout.vx = 200
  frigate.vx = 0
  assert.ok(frigate.mass > scout.mass * 4, "the types must differ in mass")
  game.rivals = [scout, frigate]
  game.resolveShipCollisions()
  assert.ok(scout.vx < 200, `scout still at ${scout.vx.toFixed(1)} u/s, so no contact was found`)
  assert.ok(Math.abs(frigate.vx) < 60, `frigate shoved to ${frigate.vx.toFixed(1)} u/s`)
  assert.ok(Math.abs(frigate.vx) < Math.abs(200 - scout.vx), "the heavier hull moves less")
})

// ---- beams ----------------------------------------------------------------

// A frigate lying along the beam axis, so the cut line would run its length.
function frigateOnAxis(game) {
  // Unshielded, because a raised bubble is what stops a beam: a hull is only ever cut
  // when there is none, and cutting is what these tests are about.
  const frigate = plainRival(600, 320, "frigate", withoutShield(SHIP_TYPES.frigate.loadout))
  frigate.angle = 0
  game.rivals = [frigate]
  const xs = frigate.worldOutline().map((p) => p.x)
  return { frigate, tail: Math.min(...xs), nose: Math.max(...xs) }
}

test("a beam that only grazes a hull scorches it instead of severing it", () => {
  const game = liveGame()
  const { frigate, tail } = frigateOnAxis(game)
  const origin = { x: tail - 20, y: 320 }
  const beam = { a: origin, dir: { x: 1, y: 0 }, b: { x: origin.x + 25, y: 320 } }
  assert.ok(countBeamCrossings(beam, frigate.worldOutline()) < 2, "the beam must not pass through")
  game.applyBeam(beam, game.player, playerWeapon)
  assert.equal(frigate.dead, false, "a 5-unit graze must not cut a 136-unit hull in two")
  assert.equal(game.asteroids.length, 0, "and must leave no debris")
  assert.ok(frigate.hull < SHIP_TYPES.frigate.hull, "but it does take damage")
})

test("a beam driven through a hull severs it", () => {
  const game = liveGame()
  const { frigate, tail } = frigateOnAxis(game)
  const origin = { x: tail - 20, y: 320 }
  const beam = { a: origin, dir: { x: 1, y: 0 }, b: { x: origin.x + 400, y: 320 } }
  assert.ok(countBeamCrossings(beam, frigate.worldOutline()) >= 2)
  game.applyBeam(beam, game.player, playerWeapon)
  assert.equal(frigate.dead, true)
  assert.ok(game.asteroids.length >= 2, `only ${game.asteroids.length} pieces`)
})

test("a hull and a rock agree on what counts as a cut", () => {
  // Same footprint, same beam: neither is severed by a beam that stops inside.
  const game = liveGame()
  const { frigate, tail } = frigateOnAxis(game)
  const grazing = { a: { x: tail - 20, y: 320 }, dir: { x: 1, y: 0 }, b: { x: tail + 5, y: 320 } }
  game.applyBeam(grazing, game.player, playerWeapon)
  const hullCut = frigate.dead

  const rockGame = liveGame()
  const rock = new Asteroid({ vertices: square(600, 320, 68) })
  rockGame.asteroids = [rock]
  const rockBeam = { a: { x: 512, y: 320 }, dir: { x: 1, y: 0 }, b: { x: 537, y: 320 } }
  rockGame.applyBeam(rockBeam, rockGame.player, playerWeapon)
  const rockCut = rockGame.asteroids.length !== 1

  assert.equal(hullCut, rockCut, "a hull and a rock must treat a grazing beam alike")
})

// The gap between a beam's centreline and a polygon, measured independently of
// the beam code: walk the outline densely and take the nearest point-to-segment
// distance. Zero when the centreline is on or inside the outline.
function gapToOutline(beam, outline) {
  const toSegment = (p) => {
    const dx = beam.b.x - beam.a.x,
      dy = beam.b.y - beam.a.y
    const len2 = dx * dx + dy * dy || 1
    const t = clampUnit(((p.x - beam.a.x) * dx + (p.y - beam.a.y) * dy) / len2)
    return Math.hypot(p.x - (beam.a.x + dx * t), p.y - (beam.a.y + dy * t))
  }
  if (pointInPolygon({ x: beam.a.x, y: beam.a.y }, outline)) {
    return 0
  }
  let best = Infinity
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i],
      b = outline[(i + 1) % outline.length]
    for (let t = 0; t <= 1.0001; t += 0.002) {
      best = Math.min(best, toSegment({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }))
    }
  }
  return best
}
const clampUnit = (t) => (t < 0 ? 0 : t > 1 ? 1 : t)

// A beam registers on the surface the view actually draws: the shield bubble
// while one is raised, the hull outline when none is. Neither used to be true of
// the player, which answered on a circle of `radius` sized `width * 0.6 + radius`,
// so a wide beam landed on empty space beside the hull and a narrow one missed the
// nose, which reaches past `radius`.
//
// Run a beam parallel to the hull, offset sideways, and compare what the beam
// resolver decides against the surface it should be using.
function beamPastPlayer(offset, weaponType, { shielded }) {
  const game = liveGame()
  const player = game.player
  player.angle = 0
  player.x = 400
  player.y = 320
  player.energy = player.energyMax
  if (shielded) {
    withShield(game)
  }
  const shooter = plainRival(400 + offset, 320 - 300, "scout")
  game.rivals = [shooter]
  const beam = {
    a: { x: 400 + offset, y: 320 - 300 },
    b: { x: 400 + offset, y: 320 + 300 },
    dir: { x: 0, y: 1 },
  }
  const gap = gapToOutline(beam, player.worldOutline())
  game.applyBeam(beam, shooter, { type: weaponType })
  return { gap, landed: game.stats.damage > 0 }
}

test("a beam hits an unshielded player where its hull actually is", () => {
  // A beam is as thick to the simulation as the core the view draws, so it lands
  // when the hull comes within half that width of the centreline. Offsets are
  // kept clear of the boundary itself, which is a coin toss either way.
  const reaches = (weaponType, gap) => gap < weaponType.width / 2 - 0.5
  const clear = (weaponType, gap) => gap > weaponType.width / 2 + 0.5
  // The widest beam in the game: its old hit circle was ~10x the hull's area.
  for (const offset of [-14, -8, 0, 8, 14, 20, 40]) {
    const r = beamPastPlayer(offset, WEAPON_TYPES.cannonLaser, { shielded: false })
    if (reaches(WEAPON_TYPES.cannonLaser, r.gap)) {
      assert.ok(r.landed, `cannonLaser at offset ${offset}, ${r.gap.toFixed(2)} from the hull`)
    } else if (clear(WEAPON_TYPES.cannonLaser, r.gap)) {
      assert.ok(!r.landed, `cannonLaser at offset ${offset}, ${r.gap.toFixed(2)} from the hull`)
    }
  }
  // The narrowest: its old circle stopped short of the nose.
  for (const offset of [-12, 0, 12, 16, 18, 20]) {
    const r = beamPastPlayer(offset, WEAPON_TYPES.minerLaser, { shielded: false })
    if (reaches(WEAPON_TYPES.minerLaser, r.gap)) {
      assert.ok(r.landed, `minerLaser at offset ${offset}, ${r.gap.toFixed(2)} from the hull`)
    } else if (clear(WEAPON_TYPES.minerLaser, r.gap)) {
      assert.ok(!r.landed, `minerLaser at offset ${offset}, ${r.gap.toFixed(2)} from the hull`)
    }
  }
})

test("a beam laid over a hull registers, rather than needing its centreline on it", () => {
  // The gap that used to be a clean miss: the hull inside the beam's bright core
  // but not under its centreline.
  const laser = WEAPON_TYPES.playerLaserMk1
  const game = liveGame()
  const scout = plainRival(500, 320, "scout") // unarmed, unshielded
  scout.angle = 0
  game.rivals = [scout]
  const nose = Math.max(...scout.worldOutline().map((p) => p.y))
  // just outside the outline, well inside the drawn core
  const beam = {
    a: { x: 200, y: nose + laser.width * 0.25 },
    b: { x: 900, y: nose + laser.width * 0.25 },
    dir: { x: 1, y: 0 },
  }
  const gap = gapToOutline(beam, scout.worldOutline())
  assert.ok(gap > 0, "the centreline must genuinely miss the hull")
  assert.ok(gap < laser.width / 2, `and lie inside the drawn core (${gap.toFixed(2)})`)
  const before = scout.hull
  game.applyBeam(beam, game.player, playerWeapon, 68)
  assert.ok(scout.dead || scout.hull < before, "a beam laid over the hull must register")
})

test("a beam hits a shielded player on the bubble the view draws", () => {
  const bubble = PLAYER_TYPE.bubbleRadius
  const half = WEAPON_TYPES.minerLaser.width / 2
  for (const offset of [0, 8, 14, 18, 22, 24, 26, 34]) {
    // A beam is as thick to the simulation as it is on screen, so one whose edge
    // straddles the bubble may honestly go either way. Where that band sits
    // depends on the hull's reach, so the offsets are read against the bubble
    // rather than against numbers that were true of one particular outline.
    if (Math.abs(Math.abs(offset) - bubble) <= half + 0.5) {
      continue
    }
    const r = beamPastPlayer(offset, WEAPON_TYPES.minerLaser, { shielded: true })
    assert.equal(
      r.landed,
      Math.abs(offset) < bubble,
      `a beam ${offset} from the centre against a bubble of ${bubble}`,
    )
  }
})

// ---- a beam treats every hull the way it treats a rock --------------------

// Put a rival on the axis with a rock well beyond it, and fire through both.
function targetWithRockBehind(game, typeName, loadout) {
  const rival = new RivalShip(520, 320, typeName, loadout)
  rival.angle = Math.PI
  game.rivals = [rival]
  const rock = new Asteroid({ vertices: square(760, 320, 70) })
  game.asteroids = [rock]
  const beam = { a: { x: 300, y: 320 }, dir: { x: 1, y: 0 }, b: { x: 1000, y: 320 } }
  return { rival, beam }
}

test("an unshielded hull does not stop a beam reaching the rocks behind it", () => {
  for (const typeName of ["scout", "frigate"]) {
    const game = liveGame()
    const { rival, beam } = targetWithRockBehind(game, typeName, [])
    game.applyBeam(beam, game.player, playerWeapon)
    assert.equal(rival.dead, true, `${typeName} must be destroyed by a beam driven through it`)
    assert.ok(
      game.asteroids.some((a) => a.center.x > 700),
      `${typeName} must not shield the rock behind it`,
    )
  }
})

test("a sliver cut off a hull is worth what a rock fragment its size is worth", () => {
  // Both go through oreFromFragment, so the two cannot drift apart; check the
  // rule is actually reached from the hull path rather than trusting that.
  const sliverOre = (halfWidth) => {
    const game = liveGame()
    game.player.x = -9000
    game.player.y = -9000
    const scout = plainRival(500, 320, "scout")
    scout.angle = 0
    game.rivals = [scout]
    // shave a strip off one side: too small to survive, and carrying no turret
    const beam = {
      a: { x: 300, y: 320 + halfWidth },
      b: { x: 900, y: 320 + halfWidth },
      dir: { x: 1, y: 0 },
    }
    game.applyBeam(beam, game.player, playerWeapon, 68)
    return game.oreChunks.length
  }
  // A thin shaving is worth less than a thick one, where both used to pay 3.
  const thin = sliverOre(10)
  const thick = sliverOre(2)
  assert.ok(thin > 0, "a sliver still pays something")
  assert.ok(thick >= thin, `a bigger sliver pays at least as much (${thin} vs ${thick})`)
  assert.equal(oreFromFragment(CONFIG.SHIP_DEBRIS_MIN_AREA - 1), 2)
  assert.equal(oreFromFragment(10), 1, "a splinter is worth one chunk, not three")
})

// ---- a raised shield is solid ---------------------------------------------

// Drive the player flat out at a target and report how close the two contact
// surfaces came. A rock is left parked far away, or the empty sector counts as
// cleared and warps the ship out part-way through the run.
function ramTarget(game, centreOf, surfaceOf, pin) {
  const player = game.player
  player.invincible = 1e9 // this is about geometry, not damage
  player.x = 420
  player.y = 320
  player.angle = 0
  let closest = Infinity
  for (let i = 0; i < 240; i++) {
    pin()
    player.vx = 300
    player.vy = 0
    game.advance(1 / 60)
    assert.ok(player.solid, `the ship must stay in the sector (phase ${game.phase})`)
    const c = centreOf()
    closest = Math.min(closest, Math.hypot(player.x - c.x, player.y - c.y))
  }
  const mine = player.shieldUp() ? player.shieldRadius() : player.boundRadius
  return { closest, surfaces: surfaceOf() + mine }
}

// A live sector with one rock, parked out of the way.
function sectorWithARock() {
  const game = liveGame()
  game.asteroids = [new Asteroid({ vertices: square(ARENA.cx, ARENA.cy - 700, 60) })]
  return game
}

test("a hull cannot be flown inside a shield bubble it can see", () => {
  const game = sectorWithARock()
  const frigate = new RivalShip(600, 320, "frigate", SHIP_TYPES.frigate.loadout)
  frigate.angle = 0
  game.rivals = [frigate]
  assert.ok(frigate.shieldUp(), "the frigate must actually have its shield up")
  assert.ok(
    frigate.shieldRadius() > frigate.boundRadius,
    "and the bubble must stand clear of the hull, or there is nothing to test",
  )
  const { closest, surfaces } = ramTarget(
    game,
    () => frigate,
    () => frigate.shieldRadius(),
    () => {
      // A pinned hull still re-accelerates along its facing inside the frame, and
      // where it steers depends on what it can see. This is about geometry, so
      // stop it flying at all.
      frigate.accel = 0
      frigate.x = 600
      frigate.y = 320
      frigate.vx = 0
      frigate.vy = 0
      frigate.angle = 0
    },
  )
  // it rests on the bubble, within the overlap the solver deliberately leaves
  assert.ok(
    surfaces - closest <= CONFIG.CONTACT_SLOP + 0.001,
    `stopped ${(surfaces - closest).toFixed(2)} inside the bubble`,
  )
})

test("an unshielded hull is still touched on its outline", () => {
  const game = sectorWithARock()
  const bare = withoutShield(SHIP_TYPES.frigate.loadout)
  const frigate = new RivalShip(600, 320, "frigate", bare)
  frigate.angle = 0
  game.rivals = [frigate]
  assert.equal(frigate.shieldUp(), false)
  const { closest } = ramTarget(
    game,
    () => frigate,
    () => 0,
    () => {
      // A pinned hull still re-accelerates along its facing inside the frame, and
      // where it steers depends on what it can see. This is about geometry, so
      // stop it flying at all.
      frigate.accel = 0
      frigate.x = 600
      frigate.y = 320
      frigate.vx = 0
      frigate.vy = 0
      frigate.angle = 0
    },
  )
  // the hull reaches far further along its own axis than the bubble did
  const nearFace = 600 - Math.min(...frigate.worldOutline().map((v) => v.x))
  assert.ok(
    closest < frigate.shieldRadius(),
    "without a shield the player gets inside where the bubble would have been",
  )
  assert.ok(closest > nearFace - 1, "but no further in than the hull")
})

test("a shielded rock is solid on its bubble too", () => {
  const game = sectorWithARock()
  const rock = new Asteroid({ vertices: square(640, 320, 70) })
  rock.hardpoints.push({ x: rock.center.x, y: rock.center.y, module: new Shield("standard") })
  rock.refreshEnergy()
  game.asteroids.push(rock)
  assert.ok(rock.shieldUp())
  const { closest, surfaces } = ramTarget(
    game,
    () => rock.center,
    () => rock.shieldRadius(),
    () => {
      rock.vx = 0
      rock.vy = 0
      rock.spin = 0
    },
  )
  assert.ok(
    surfaces - closest <= CONFIG.CONTACT_SLOP + 0.001,
    `stopped ${(surfaces - closest).toFixed(2)} inside the bubble`,
  )
})

test("shapeContact solves a disc against an outline as exactly as two outlines", () => {
  // A disc overlapping a square by a known amount, from every direction.
  const half = 40
  const parts = [square(0, 0, half)]
  const radius = 25
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
    const overlap = 6
    // place the disc centre so it overlaps the square's face by `overlap`
    const along = Math.abs(Math.cos(a)) > Math.abs(Math.sin(a)) ? "x" : "y"
    const centre =
      along === "x"
        ? { x: Math.sign(Math.cos(a)) * (half + radius - overlap), y: 0 }
        : { x: 0, y: Math.sign(Math.sin(a)) * (half + radius - overlap) }
    const contact = shapeContact({ centre: { x: 0, y: 0 }, parts }, { centre, radius })
    assert.ok(contact, `a disc ${overlap} into the square must register`)
    assert.ok(
      Math.abs(contact.depth - overlap) < 1e-6,
      `depth ${contact.depth.toFixed(3)} for an overlap of ${overlap}`,
    )
    // and the push must actually separate them
    const moved = {
      x: centre.x + contact.nx * contact.depth,
      y: centre.y + contact.ny * contact.depth,
    }
    assert.equal(
      shapeContact({ centre: { x: 0, y: 0 }, parts }, { centre: moved, radius }),
      null,
      "one application must clear it",
    )
  }
})

test("two bubbles meet where they are drawn", () => {
  const a = { centre: { x: 0, y: 0 }, radius: 30 }
  const b = { centre: { x: 45, y: 0 }, radius: 25 }
  const contact = shapeContact(a, b)
  assert.ok(contact)
  assert.ok(Math.abs(contact.depth - 10) < 1e-9, `depth ${contact.depth}`)
  assert.ok(Math.abs(contact.nx - 1) < 1e-9 && Math.abs(contact.ny) < 1e-9)
  assert.equal(shapeContact(a, { centre: { x: 56, y: 0 }, radius: 25 }), null, "and apart is apart")
})

test("a beam cuts every hull it passes through, as it cuts every rock", () => {
  const game = liveGame()
  game.player.x = -9000
  game.player.y = -9000
  const line = []
  for (let i = 0; i < 4; i++) {
    const scout = plainRival(400 + i * 90, 320, "scout") // unarmed, unshielded
    scout.angle = 0
    line.push(scout)
  }
  game.rivals = [...line]
  game.applyBeam(
    { a: { x: 300, y: 320 }, b: { x: 1000, y: 320 }, dir: { x: 1, y: 0 } },
    game.player,
    playerWeapon,
    68,
  )
  assert.deepEqual(
    line.map((s) => s.dead),
    [true, true, true, true],
    "a beam that cuts the nearest must cut the ones behind it too",
  )
})

// A shield that covers one channel instead of two is meant to be better at it,
// and to leave its host wide open on the other. Both halves matter, so both are
// pinned here against whichever shields the registry actually declares.
test("a single-channel shield outperforms a general one on the channel it covers", () => {
  // A shield pricing its channels separately is braced against one of them, so it is
  // not the plain general-purpose bubble this is about; see below for its own trade.
  const names = Object.keys(SHIELD_TYPES)
  const general =
    SHIELD_TYPES[
      names.find(
        (k) => SHIELD_TYPES[k].blocks.length > 1 && typeof SHIELD_TYPES[k].efficiency === "number",
      )
    ]
  const specialist = SHIELD_TYPES[names.find((k) => SHIELD_TYPES[k].blocks.length === 1)]
  assert.ok(specialist, "some shield should cover one channel only")
  assert.ok(
    specialist.efficiency < general.efficiency,
    `it should drain less per point (${specialist.efficiency} vs ${general.efficiency})`,
  )
  assert.ok(specialist.dropAt < general.dropAt, "and hold on further down the cell")
  assert.ok(specialist.recoverAt <= general.recoverAt, "and come back sooner")
  assert.ok(specialist.recoverDelay <= general.recoverDelay, "after a shorter wait")
})

test("a shield braced against one channel pays for it on another", () => {
  // Per-channel efficiency is only interesting as a trade. A bubble that prices two
  // channels separately has to be better than the plain one on at least one of them
  // and worse on at least one, or it is a straight upgrade wearing a table.
  const plain = SHIELD_TYPES.standard
  const drain = (type, channel) =>
    typeof type.efficiency === "number" ? type.efficiency : (type.efficiency[channel] ?? 1)
  // Only where there is more than one channel to trade between: a field that stops
  // lasers and repels everything else has one price and nothing to weigh it against.
  const braced = Object.entries(SHIELD_TYPES).filter(
    ([, type]) => typeof type.efficiency === "object" && type.blocks.length > 1,
  )
  assert.ok(braced.length, "some shield should price its channels apart")
  for (const [name, type] of braced) {
    const channels = type.blocks
    assert.ok(
      channels.some((channel) => drain(type, channel) < drain(plain, channel)),
      `${name} should beat the plain bubble somewhere`,
    )
    assert.ok(
      channels.some((channel) => drain(type, channel) > drain(plain, channel)),
      `${name} should be worse than it somewhere too`,
    )
  }

  // And the drain a host actually pays is the one for the channel that hit it.
  const shield = new Shield("bulwark")
  assert.equal(shield.drainPer("projectile"), SHIELD_TYPES.bulwark.efficiency.projectile)
  assert.equal(shield.drainPer("laser"), SHIELD_TYPES.bulwark.efficiency.laser)
  // A channel it blocks without pricing costs a point for a point rather than none.
  assert.equal(new Shield("bulwark").drainPer("gravity"), 1)
})

// A hull with the alien field up, and a square rock `gap` from its centre.
function fieldAndRock(gap) {
  const game = liveGame()
  game.player.x = -9000
  game.player.y = -9000
  const alien = plainRival(500, 320, "alienFrigate")
  game.rivals = [alien]
  const rock = new Asteroid({ vertices: square(500 + gap, 320, 45), vx: 0, vy: 0 })
  game.asteroids = [rock]
  return { game, alien, rock }
}

test("the alien field leans on what comes near it and pays for what it turns away", () => {
  const { game, alien, rock } = fieldAndRock(150)
  assert.ok(alien.shieldUp(), "the field is on")
  alien.regen = 0 // measure the drain rather than the balance
  const cell = alien.energy
  const from = rock.center.x
  for (let i = 0; i < 60; i++) {
    alien.vx = 0
    alien.vy = 0
    alien.x = 500
    alien.y = 320
    game.advance(1 / 60)
  }
  assert.ok(rock.center.x > from + 10, "the rock was pushed away")
  assert.ok(alien.energy < cell, "and the field paid for pushing it")

  // Nothing to hold off is free, which is what makes a rock field a way to strip one.
  const quiet = liveGame()
  quiet.player.x = -9000
  quiet.player.y = -9000
  const alone = plainRival(500, 320, "alienFrigate")
  alone.regen = 0
  quiet.rivals = [alone]
  const held = alone.energy
  for (let i = 0; i < 60; i++) {
    quiet.advance(1 / 60)
  }
  assert.equal(alone.energy, held, "in open space it costs nothing at all")

  // And the more there is to lean on, the faster it goes. The core alone, so what is
  // measured is the field and nothing else: a hull spends from the same cell every time
  // one of its guns goes off, and one orb costs more than a rock in the field does.
  const fieldOnly = SHIP_TYPES.alienFrigate.loadout.filter((entry) => entry.core)
  const drain = (rocks) => {
    const g = liveGame()
    g.player.x = -9000
    g.player.y = -9000
    const host = plainRival(500, 320, "alienFrigate", fieldOnly)
    host.regen = 0
    g.rivals = [host]
    // Rocks that do not turn, so a corner cannot rotate in and out of the field and
    // make the same arrangement cost a different amount twice.
    g.asteroids = rocks.map(
      ([dx, dy]) => new Asteroid({ vertices: square(500 + dx, 320 + dy, 45), spin: 0 }),
    )
    const before = host.energy
    for (let i = 0; i < 60; i++) {
      host.vx = 0
      host.vy = 0
      host.x = 500
      host.y = 320
      for (const r of g.asteroids) {
        r.vx = 0
        r.vy = 0
      }
      g.advance(1 / 60)
    }
    return before - host.energy
  }
  // Three at the same distance as the one, so only the count differs: on a circle
  // round the hull rather than mirrored in y, which would put two of them further out.
  // The radius sits in the shell where the field reaches and the hull does not, which
  // for the pincer is a rock centre between 137 and 216.
  const ring = (count, at) =>
    Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2
      return [Math.cos(angle) * at, Math.sin(angle) * at]
    })
  const one = drain(ring(1, 160))
  const three = drain(ring(3, 160))
  assert.ok(one > 0, "one rock costs something")
  assert.ok(
    three > one * 2,
    `three (${three.toFixed(1)}) should cost about three times one (${one.toFixed(1)})`,
  )
})

test("the alien field is not a wall: it is passed through by what pushes hard enough", () => {
  // A bubble is a barrier a rock stops against and a hull cannot be flown inside. A
  // field that leans on things is not, so what other bodies meet is the outline.
  const { alien } = fieldAndRock(150)
  assert.ok(alien.shieldUp(), "the field is up")
  assert.equal(alien.barrierUp(), false, "but it is not a wall")
  assert.ok(alien.contactShape().parts, "so bodies meet the outline")
  assert.equal(alien.contactReach(), alien.boundRadius, "and its reach is the hull's")

  // A bubble still is one.
  const frigate = plainRival(500, 320, "frigate")
  assert.ok(frigate.barrierUp(), "a bulwark is a wall")
  assert.equal(frigate.contactShape().radius, frigate.shieldRadius())

  // A laser is still stopped by the field, which is the half it does absorb.
  assert.equal(alien.blockingRadius("laser"), alien.shieldRadius())
  assert.equal(alien.blockingRadius("projectile"), 0, "and shot is not blocked, but repelled")
})

// Every lens and tear the view hands the renderer for a frame.
function distortion(game) {
  const lenses = []
  const tears = []
  const renderer = new Proxy(
    {
      setLenses: (list) => lenses.push(...list),
      setTears: (list) => tears.push(...list),
      text: () => {},
    },
    { get: (target, key) => (key in target ? target[key] : () => {}) },
  )
  new GameView(renderer).render(game)
  return { lenses, tears }
}

// The pincer, its wind-up finished, with a well in flight from its muzzle.
function withSingularity(game, at = { x: 500, y: 320 }) {
  const alien = plainRival(at.x, at.y, "alienFrigate")
  alien.angle = 0
  game.rivals = [alien]
  const gun = alien.hardpoints.find((hp) => hp.module && hp.module.typeName === "singularityGun")
  assert.ok(gun, "the pincer should carry the singularity gun")
  const muzzle = alien.mountWorld(gun.local)
  gun.module.launchWell(game, alien, muzzle.x, muzzle.y, 0)
  const well = game.projectiles.find((p) => p instanceof Singularity)
  assert.ok(well, "which should have let go of a well")
  // Its guns come off once the well is away: a pincer left armed shoots whatever else is
  // in the sector, and its orbs landing on the thing being measured is not the well.
  for (const hp of alien.hardpoints) {
    if (hp.module && hp.module.kind === "weapon") {
      hp.module = null
    }
  }
  return { alien, gun: gun.module, well }
}

test("the pincer's wind-up drags in what is loose, and never the rocks", () => {
  const game = liveGame()
  game.player.x = -9000
  game.player.y = -9000
  const alien = plainRival(500, 320, "alienFrigate")
  alien.angle = 0
  game.rivals = [alien]
  const gun = alien.hardpoints.find(
    (hp) => hp.module && hp.module.typeName === "singularityGun",
  ).module
  const muzzle = { x: 600, y: 320 }

  // A rock sitting in the jaws, a drifting particle and someone else's shot.
  const rock = new Asteroid({ vertices: square(660, 320, 30), vx: 0, vy: 0, spin: 0 })
  game.asteroids = [rock]
  game.emit(700, 320, 0, 0, 5, PALETTE.alien.beam)
  const mote = game.particles[game.particles.length - 1]
  const round = new Projectile(700, 360, 0, 0, 10, null, WEAPON_TYPES.autocannon)
  game.projectiles = [round]

  gun.charging = gun.type.chargeTime
  gun.chargeDuration = gun.type.chargeTime
  const rockAt = rock.center.x
  for (let i = 0; i < 30; i++) {
    gun.generate(1 / 60, game, alien, muzzle)
  }
  assert.ok(mote.vx < -1, "a loose particle falls toward the muzzle")
  assert.ok(round.vx < -1, "and so does a loose shot")
  assert.equal(rock.center.x, rockAt, "the rock does not move: a sector heaving would be mayhem")
})

test("a pincer winds up at anything in front of it, and not behind", () => {
  const game = liveGame()
  game.asteroids = [new Asteroid({ vertices: square(-900, -900, 40), spin: 0 })]
  beSolid(game.player)
  // Immortal without being invisible: the invincibility grace is also what hides the ship
  // from anything hunting it, so pinning it would measure a gun with no target.
  game.player.takeDamage = () => {}
  const alien = plainRival(500, 320, "alienFrigate")
  alien.angle = 0
  game.rivals = [alien]
  const gun = alien.hardpoints.find(
    (hp) => hp.module && hp.module.typeName === "singularityGun",
  ).module

  const windsUp = (degrees) => {
    gun.charging = 0
    gun.cooldown = 0
    const bearing = (degrees * Math.PI) / 180
    game.player.x = 500 + Math.cos(bearing) * 400
    game.player.y = 320 + Math.sin(bearing) * 400
    for (let i = 0; i < 10 && gun.charging <= 0; i++) {
      alien.angle = 0
      game.player.vx = 0
      game.player.vy = 0
      game.advance(1 / 60)
    }
    return gun.charging > 0
  }
  for (const degrees of [0, 45, 80]) {
    assert.ok(windsUp(degrees), `it should wind up at something ${degrees} degrees off the nose`)
  }
  for (const degrees of [95, 135, 180]) {
    assert.ok(!windsUp(degrees), `and not at something ${degrees} degrees off it`)
  }
})

test("a well drifts, and leans after what it was thrown at", () => {
  const game = liveGame()
  game.asteroids = [new Asteroid({ vertices: square(-900, -900, 40), spin: 0 })]
  beSolid(game.player)
  game.player.takeDamage = () => {}
  game.player.x = 1100
  game.player.y = 60
  const { alien, well } = withSingularity(game)
  assert.ok(
    Math.hypot(well.vx, well.vy) < SHIP_TYPES.alienFrigate.maxSpeed * 2,
    "it drifts rather than flies",
  )
  const toTarget = bearingTo(well, game.player)
  const before = Math.abs(shortestTurn(Math.atan2(well.vy, well.vx), toTarget))
  for (let i = 0; i < 90; i++) {
    game.player.x = 1100
    game.player.y = 60
    game.player.vx = 0
    game.player.vy = 0
    alien.x = 500
    alien.y = 320
    game.advance(1 / 60)
  }
  const after = Math.abs(shortestTurn(Math.atan2(well.vy, well.vx), bearingTo(well, game.player)))
  assert.ok(after < before, "and comes round toward what it was thrown at")
})

test("a field does not repel the fire of the ship carrying it", () => {
  // Every gun on the hull sits inside the field, so one that turned away its own fire
  // would fling each shot out sideways and hold its own well at arm's length.
  const game = liveGame()
  game.asteroids = [new Asteroid({ vertices: square(-900, -900, 40), spin: 0 })]
  beSolid(game.player)
  game.player.takeDamage = () => {}
  game.player.x = 900
  game.player.y = 320
  const alien = plainRival(500, 320, "alienFrigate")
  alien.angle = 0
  game.rivals = [alien]
  let orb = null
  for (let i = 0; i < 600 && !orb; i++) {
    alien.x = 500
    alien.y = 320
    alien.vx = 0
    alien.vy = 0
    game.player.x = 900
    game.player.y = 320
    game.advance(1 / 60)
    orb = game.projectiles.find((shot) => shot.type === WEAPON_TYPES.warpOrb)
  }
  assert.ok(orb, "a jaw gun should have fired")
  assert.ok(
    Math.abs(Math.hypot(orb.vx, orb.vy) - WEAPON_TYPES.warpOrb.speed) < 1,
    `its own orb should leave at ${WEAPON_TYPES.warpOrb.speed}, left at ${Math.hypot(orb.vx, orb.vy).toFixed(0)}`,
  )
})

test("a singularity pulls, bites through a shield, and spares whoever fired it", () => {
  const game = liveGame()
  game.player.x = -9000
  game.player.y = -9000
  game.asteroids = [new Asteroid({ vertices: square(-600, -600, 40), spin: 0 })]
  const { alien, well } = withSingularity(game)
  assert.ok(Math.hypot(well.vx, well.vy) > 0, "it travels")

  // A shielded rival sat inside it loses hull anyway: the channel is one no shield lists,
  // so a bubble is no help against the space it is sitting in.
  // Its core and bubble only: a hull spends from the same cell every time one of its own
  // guns goes off, and what is being measured is whether the well touched the cell.
  const caught = plainRival(
    well.x + 40,
    well.y,
    "frigate",
    SHIP_TYPES.frigate.loadout.filter((entry) => entry.core),
  )
  game.rivals = [alien, caught]
  assert.ok(caught.shieldUp(), "it has a bubble up")
  const hull = caught.hull
  const cell = caught.energy
  for (let i = 0; i < 30; i++) {
    well.x = caught.x - 40
    well.y = caught.y
    game.advance(1 / 60)
  }
  assert.ok(caught.hull < hull, "and is pulled apart inside the well")
  assert.equal(caught.energy, cell, "with the bubble neither helping nor draining")

  // What fired it is spared while it lives.
  const own = alien.hull
  for (let i = 0; i < 30; i++) {
    well.x = alien.x
    well.y = alien.y
    game.advance(1 / 60)
  }
  assert.equal(alien.hull, own, "its own hull is spared")
})

test("a well grows into itself, and shows what it is pulling", () => {
  const game = liveGame()
  game.player.x = -9000
  game.player.y = -9000
  game.asteroids = [new Asteroid({ vertices: square(-900, -900, 40), spin: 0 })]
  const { well } = withSingularity(game)
  const hold = () => {
    well.x = 500
    well.y = 320
    well.vx = 0
    well.vy = 0
  }
  assert.ok(well.grown < 0.2, "it arrives as a point")
  for (let i = 0; i < 60; i++) {
    hold()
    game.advance(1 / 60)
  }
  assert.equal(well.grown, 1, "and opens out")

  // What it does grows with it: a mote at the rim of the grown well is drawn in, and one
  // outside its reach is not.
  const mote = (at) => {
    game.emit(500 + at, 320, 0, 0, 6, PALETTE.alien.beam)
    return game.particles[game.particles.length - 1]
  }
  const inside = mote(well.type.well.radius * 0.5)
  const outside = mote(well.type.well.radius * 1.5)
  const wasIn = inside.x
  const wasOut = outside.x
  for (let i = 0; i < 45; i++) {
    hold()
    game.advance(1 / 60)
  }
  assert.ok(inside.x < wasIn - 10, "a mote inside it falls in")
  assert.equal(outside.x, wasOut, "one beyond its reach is untouched")

  // And it strikes motes off its own rim, so the accretion reads whether or not the sector
  // has anything loose near it.
  const own = game.particles.filter((p) => p.color === PALETTE.alien.beam).length
  assert.ok(own > 5, `it should be throwing its own motes, found ${own}`)
})

test("a pincer cut while its well is up is finished by its own singularity", () => {
  // The emergent claim the shape was drawn for: a well spares its owner while the owner
  // lives, and stops the moment it does not. Nothing about this case is written down.
  const game = liveGame()
  game.player.x = -9000
  game.player.y = -9000
  game.asteroids = [new Asteroid({ vertices: square(-600, -600, 40), spin: 0 })]
  const { alien, well } = withSingularity(game)

  // Wreckage of the ship that fired it, standing in for the halves a cut leaves.
  alien.dead = true
  const remains = new Asteroid({
    vertices: square(well.x + 30, well.y, 40),
    vx: 0,
    vy: 0,
    spin: 0,
    material: SHIP_PLATING,
  })
  game.asteroids = [remains]
  const before = remains.area
  for (let i = 0; i < 60 && !remains.dead; i++) {
    well.x = remains.center.x - 30
    well.y = remains.center.y
    game.advance(1 / 60)
  }
  // A rock has no hull to lose, so what the well does to it is measured by it being gone.
  assert.ok(before > 0)
  assert.ok(
    remains.dead || game.oreChunks.length > 0,
    "the wreckage of the ship that fired it is not spared",
  )
})

test("the dev page reaches every part of the game without playing up to it", () => {
  const game = liveGame()
  beSolid(game.player)
  game.openDevMenu()
  assert.equal(game.paused, true, "it opens over whatever was happening")
  assert.equal(game.pausePage, "dev")
  const row = (name) => {
    const found = game.pauseMenu().find((entry) => entry.name === name)
    assert.ok(found, `the dev page should offer ${name}`)
    return found
  }

  // Owning everything is every option in every slot, at no cost.
  row("OWN EVERYTHING").action(game)
  for (const [slot, spec] of Object.entries(EQUIPMENT)) {
    assert.equal(
      game.upgrades.owned[slot].length,
      spec.options.length,
      `every ${slot} should be owned`,
    )
  }

  // Fully upgrading fits the top of every ladder and the last core.
  row("FULLY UPGRADE").action(game)
  assert.equal(game.fittedEquipment("laser"), EQUIPMENT.laser.options.at(-1).id)
  assert.equal(game.upgrades.core, shopRow(game, "core").levels.length - 1)
  // A slot that is a choice rather than a climb takes what the yard fits: the last by
  // position would just mean the slowest drive.
  assert.equal(game.fittedEquipment("engine"), EQUIPMENT.engine.options[0].id)

  // The spawn rows are a page of their own, since there are more of them than the rest
  // of the dev tools put together.
  row("SPAWN").action(game)
  assert.equal(game.pausePage, "devSpawn")
  row("BACK").action(game)
  assert.equal(game.pausePage, "dev", "and it leads back to where it was opened from")
})

test("a menu row showing an arrow is one that opens a page", () => {
  // The arrow is what says "there is more behind this". A row that simply does something
  // when it is pressed must not show one, or it reads as a page that never arrives.
  const onPage = (page) => {
    const game = liveGame()
    beSolid(game.player)
    game.openDevMenu()
    game.openPausePage(page)
    return game
  }
  for (const page of ["root", "dev", "devSpawn"]) {
    for (const name of onPage(page)
      .pauseMenu()
      .map((row) => row.name)) {
      // A fresh game a row at a time, since pressing one of these changes the run.
      const game = onPage(page)
      const row = game.pauseMenu().find((entry) => entry.name === name)
      if (!row.action || !row.value || row.value(game) !== ">") {
        continue
      }
      row.action(game)
      assert.notEqual(game.pausePage, page, `${page} / ${name} shows an arrow but stays put`)
    }
  }
})

test("the spawn page offers every hull and every kind of rock", () => {
  const game = liveGame()
  beSolid(game.player)
  game.openDevMenu()
  game.openPausePage("devSpawn")
  const row = (name) => {
    const found = game.pauseMenu().find((entry) => entry.name === name)
    assert.ok(found, `the spawn page should offer ${name}`)
    return found
  }

  // A row per hull the spawner could send and one per kind of rock it could put in a
  // sector, both generated from their registries so the page grows with the game.
  for (const name of Object.keys(SHIP_TYPES)) {
    row(name.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase())
  }
  row("ASTEROID")
  row("ASTEROID, EXPLOSIVE")
  row("ASTEROID, ARMED")

  game.rivals = []
  row("ALIEN FRIGATE").action(game)
  assert.equal(game.rivals.length, 1, "spawning puts one in the sector")
  assert.equal(game.rivals[0].typeName, "alienFrigate")
  assert.ok(game.rivals[0].arrived, "already here, rather than flying in from beyond the ring")

  // What a hull carries is each row's own choice, so one can be spawned rolled against
  // another spawned plain. Rolling at the sector the run is in gives almost nothing early
  // on, which is the least useful of the three, so all three are offered.
  const spawned = (name) => {
    game.rivals = []
    row(name).action(game)
    return [...game.rivals[0].modules()].map((m) => m.typeName)
  }
  const scout = () => row("SCOUT")
  const shown = () => {
    const choice = scout().choices(game)
    return choice.options[choice.at]
  }
  assert.equal(shown(), "NORMAL", "it starts on the design alone")
  const bare = spawned("SCOUT")
  const design = SHIP_TYPES.scout.loadout.map((entry) => entry.weapon).filter(Boolean)
  assert.ok(
    design.every((gun) => bare.includes(gun)),
    "which is everything the design states",
  )
  assert.ok(
    !bare.includes(SHIP_TYPES.scout.arms.gun.weapon),
    "and nothing it only sometimes turns up with",
  )
  scout().adjust(game, 1)
  assert.equal(shown(), "ROLLED")
  scout().adjust(game, 1)
  assert.equal(shown(), "ALL")
  const loaded = spawned("SCOUT")
  for (const arm of Object.values(SHIP_TYPES.scout.arms)) {
    const carried = arm.weapon || arm.shield
    assert.ok(loaded.includes(carried), `every arm should be aboard, missing ${carried}`)
  }
  scout().adjust(game, 1)
  assert.equal(shown(), "NORMAL", "and the choice wraps")

  // Which is each row's own: setting one leaves the others where they were.
  scout().adjust(game, 1)
  const seeker = game
    .pauseMenu()
    .find((entry) => entry.name === "SEEKER")
    .choices(game)
  assert.equal(seeker.options[seeker.at], "NORMAL", "a hull nobody has set is still plain")

  // A rock of each kind, carrying what the kind is named for. The gun pool is cut to the
  // sector, so an armed rock asked for in sector one must still turn up armed.
  const rock = (name) => {
    game.asteroids = []
    row(name).action(game)
    assert.equal(game.asteroids.length, 1, `${name} should put one rock in the sector`)
    return game.asteroids[0]
  }
  assert.equal(game.level, 1, "and this is sector one, where a rock is normally bare")
  const plain = rock("ASTEROID")
  assert.equal(plain.explosive, false)
  assert.equal(plain.hardpoints.length, 0, "a plain rock carries nothing")
  assert.equal(rock("ASTEROID, EXPLOSIVE").explosive, true)
  const armed = rock("ASTEROID, ARMED")
  const guns = armed.hardpoints.filter((hp) => hp.module && hp.module.kind === "weapon")
  assert.ok(guns.length > 0, "an armed rock turns up with guns on it")
  const both = rock("ASTEROID, ARMED + SHIELDED")
  assert.ok(
    both.hardpoints.some((hp) => hp.module && hp.module.kind === "shield"),
    "and a shielded one with a bubble",
  )
})

test("dev spawns are set down clear of each other", () => {
  // Asking for six of something used to stack all six on one spot, where the contact solver
  // would spend the next second shoving them apart and they would scatter as a shower.
  const game = liveGame()
  beSolid(game.player)
  game.openDevMenu()
  const row = (name) => game.pauseMenu().find((entry) => entry.name === name)
  row("TESTING ARENA").action(game)
  game.openDevMenu()
  game.openPausePage("devSpawn")
  for (let i = 0; i < 6; i++) {
    row("ALIEN FRIGATE").action(game)
  }
  for (let i = 0; i < 4; i++) {
    row("SEEKER").action(game)
  }
  assert.equal(game.rivals.length, 10, "all ten arrived")
  let closest = Infinity
  for (let i = 0; i < game.rivals.length; i++) {
    for (let j = i + 1; j < game.rivals.length; j++) {
      const a = game.rivals[i],
        b = game.rivals[j]
      closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y) - a.boundRadius - b.boundRadius)
    }
  }
  assert.ok(closest > 0, `no two are touching: closest pair ${closest.toFixed(0)} apart`)
  for (const ship of game.rivals) {
    assert.ok(
      Math.hypot(ship.x - ARENA.cx, ship.y - ARENA.cy) + ship.boundRadius < ARENA.radius,
      "and all of them are inside the ring",
    )
  }
})

test("a testing arena never clears itself", () => {
  const game = liveGame()
  beSolid(game.player)
  game.openDevMenu()
  game
    .pauseMenu()
    .find((row) => row.name === "TESTING ARENA")
    .action(game)
  assert.equal(game.sandbox, true)
  assert.equal(game.asteroids.length, 0, "nothing in it")
  for (let i = 0; i < 60 * 8; i++) {
    game.advance(1 / 60)
  }
  assert.equal(game.phase, "play", "an empty sector would ordinarily count as cleared")

  // And leaving by any ordinary route puts the game back to normal.
  game.enterShop()
  assert.equal(game.sandbox, false)
})

// The shop row for a levelled upgrade, by id.
function shopRow(game, id) {
  return SHOP.find((row) => row.id === id)
}

test("what bends space says so, and the view finds it", () => {
  const game = liveGame()
  beSolid(game.player)
  game.asteroids = [new Asteroid({ vertices: square(-600, -600, 40), spin: 0 })]
  assert.deepEqual(distortion(game).lenses, [], "an ordinary sector bends nothing")

  // A hull that states a warp bends the space it occupies.
  const alien = plainRival(500, 320, "alienFrigate")
  game.rivals = [alien]
  const withAlien = distortion(game).lenses
  assert.equal(withAlien.length, 1, "the pincer is one source")
  assert.ok(withAlien[0].strength > 0 && withAlien[0].radius > 0, "with a strength and a size")
  assert.ok(
    withAlien[0].x > 0 && withAlien[0].x < 1 && withAlien[0].y > 0 && withAlien[0].y < 1,
    "placed on screen, in the units the shader wants",
  )

  // So do its shots, in flight.
  game.projectiles = [
    new Projectile(600, 320, -10, 0, 10, alien, WEAPON_TYPES.warpOrb),
    new Projectile(650, 320, -10, 0, 10, alien, WEAPON_TYPES.autocannon),
  ]
  const withShots = distortion(game).lenses
  assert.equal(withShots.length, 2, "the orb bends space and the ordinary round does not")

  // A rival hull states none, so nothing about it distorts.
  game.rivals = [plainRival(500, 320, "frigate")]
  game.projectiles = []
  assert.deepEqual(distortion(game).lenses, [], "a rival frigate bends nothing")
})

test("a tear bursts and falls away, rather than being switched off", () => {
  const game = liveGame()
  beSolid(game.player)
  game.asteroids = [new Asteroid({ vertices: square(-600, -600, 40), spin: 0 })]
  assert.deepEqual(distortion(game).tears, [], "nothing torn to begin with")

  game.glitchAt(game.player.x, game.player.y, 1, 200, 0.3)
  const fresh = distortion(game).tears
  assert.equal(fresh.length, 1)
  assert.ok(Math.abs(fresh[0].strength - 1) < 1e-6, "a fresh tear is at full strength")

  // Half its life gone, most of its force is gone: it bursts and falls away rather than
  // dimming evenly, which is what makes it read as a failure and not as an effect.
  game.advance(0.15)
  const half = distortion(game).tears[0]
  assert.ok(half.strength < 0.35, `half way through it should be well down, was ${half.strength}`)
  assert.ok(half.strength > 0, "but not yet gone")

  game.advance(0.2)
  assert.deepEqual(distortion(game).tears, [], "and then it is gone")
})

test("being inside a well fails the whole picture, gently", () => {
  const game = liveGame()
  beSolid(game.player)
  game.player.takeDamage = () => {}
  game.asteroids = [new Asteroid({ vertices: square(-900, -900, 40), spin: 0 })]
  const well = new Singularity(500, 320, 0, 0, 0, null, WEAPON_TYPES.singularityGun)
  game.projectiles = [well]
  for (let i = 0; i < 60; i++) {
    well.x = 500
    well.y = 320
    well.vx = 0
    well.vy = 0
    game.advance(1 / 60)
  }

  // A tear over the whole frame rather than at a point, and only while the ship is in it.
  const wide = () => distortion(game).tears.find((tear) => tear.radius > 1)
  const reach = WEAPON_TYPES.singularityGun.well.radius
  const at = (away) => {
    game.player.x = 500 + away
    game.player.y = 320
    return wide()
  }
  assert.ok(!at(reach * 1.4), "outside its reach the picture is fine")
  const edge = at(reach * 0.9)
  const middle = at(0)
  assert.ok(edge && middle, "inside it, the whole frame is torn")
  assert.ok(middle.strength > edge.strength, "worse the further in the ship is")
  assert.ok(
    middle.strength <= WEAPON_TYPES.singularityGun.well.nearGlitch,
    "and never worse than the well says",
  )
  assert.ok(middle.strength < 0.5, "which is gentle: something to notice, not to fight through")
})

test("an orb landing on the player tears the picture", () => {
  const game = liveGame()
  beSolid(game.player)
  withEquipment(game, "shield", "playerShieldMk4")
  game.asteroids = [new Asteroid({ vertices: square(-600, -600, 40), spin: 0 })]
  game.player.x = 500
  game.player.y = 320
  const orb = new Projectile(
    560,
    320,
    -WEAPON_TYPES.warpOrb.speed,
    0,
    10,
    null,
    WEAPON_TYPES.warpOrb,
  )
  game.projectiles = [orb]
  for (let i = 0; i < 60 && !orb.dead; i++) {
    game.player.x = 500
    game.player.y = 320
    game.advance(1 / 60)
  }
  assert.ok(orb.dead, "the orb landed")
  assert.ok(game.glitches.length > 0, "and tore the picture where it did")

  // A round that says nothing about tearing does not.
  const quiet = liveGame()
  beSolid(quiet.player)
  quiet.asteroids = [new Asteroid({ vertices: square(-600, -600, 40), spin: 0 })]
  withEquipment(quiet, "shield", "playerShieldMk4")
  quiet.player.x = 500
  quiet.player.y = 320
  const round = new Projectile(
    560,
    320,
    -WEAPON_TYPES.autocannon.speed,
    0,
    10,
    null,
    WEAPON_TYPES.autocannon,
  )
  quiet.projectiles = [round]
  for (let i = 0; i < 60 && !round.dead; i++) {
    quiet.player.x = 500
    quiet.player.y = 320
    quiet.advance(1 / 60)
  }
  assert.ok(round.dead, "the round landed")
  assert.equal(quiet.glitches.length, 0, "and left the picture alone")
})

test("an alien plant is deep enough to run a field through a crossfire", () => {
  // A bubble only costs energy when something hits it; a field pays for everything it
  // holds off, and an alien arrives into a sector already thick with other people's
  // fire. So an alien core carries a good deal more than the rival core of its tier,
  // and the pincer's most of all.
  for (const [alien, rival] of [
    ["alienScout", "scout"],
    ["alienSeeker", "seeker"],
    ["alienFrigate", "frigate"],
  ]) {
    assert.ok(
      SHIP_TYPES[alien].energyMax > SHIP_TYPES[rival].energyMax,
      `${alien} should carry more cell than a ${rival}`,
    )
  }

  // What that is worth against the weapon that breaks a field: charged shots at the
  // cadence the gun allows. On a siege core the pincer's field fell to five of them.
  const shotsToStrip = (mark) => {
    const game = liveGame()
    beSolid(game.player)
    game.asteroids = [new Asteroid({ vertices: square(-600, -600, 40), spin: 0 })]
    withEquipment(game, "laser", mark)
    const gun = game.player.mainWeapon
    const cycle = Math.ceil(60 * (gun.type.chargeMax / gun.type.chargeRate + gun.type.reload))
    const reach = gun.type.chargeMax * game.player.beamLengthMult() + gun.type.chargeReach
    const at = 300 + reach * 0.55
    const alien = plainRival(at, 320, "alienFrigate")
    game.rivals = [alien]
    const field = alien.shieldModule()
    let shots = 0
    for (let frame = 0; frame < 60 * 60 && field.up; frame++) {
      game.player.x = 300
      game.player.y = 320
      game.player.angle = 0
      game.player.invincible = 99999
      alien.x = at
      alien.y = 320
      alien.vx = 0
      alien.vy = 0
      if (frame % cycle === 0) {
        gun.cooldown = 0
        gun.charge = gun.type.chargeMax
        game.player.energy = game.player.energyMax
        game.player.fireLaser(game)
        shots++
      }
      game.advance(1 / 60)
    }
    return field.up ? Infinity : shots
  }
  const early = shotsToStrip("playerLaserMk1")
  const late = shotsToStrip("playerLaserMk5")
  assert.ok(early > 10, `the yard's beam should need a good many shots, needed ${early}`)
  assert.ok(late < early, "and the mark the shop finishes with should need fewer")
  assert.ok(late > 5, `but not so few that it is over at once, needed ${late}`)
})

test("a field bounces its own side's fire and pushes against everything else", () => {
  const orbAt = (ownerType) => {
    const game = liveGame()
    game.player.x = -9000
    game.player.y = -9000
    game.asteroids = [new Asteroid({ vertices: square(-900, -900, 40), spin: 0 })]
    const target = plainRival(900, 320, "alienFrigate")
    const owner = ownerType ? plainRival(300, 320, ownerType) : null
    game.rivals = owner ? [owner, target] : [target]
    const orb = new Projectile(
      600,
      320,
      WEAPON_TYPES.warpOrb.speed,
      0,
      10,
      owner,
      WEAPON_TYPES.warpOrb,
    )
    game.projectiles = [orb]
    let near = Infinity
    for (let i = 0; i < 200 && !orb.dead; i++) {
      target.x = 900
      target.y = 320
      target.vx = 0
      target.vy = 0
      if (owner) {
        owner.x = 300
        owner.y = 320
        owner.vx = 0
        owner.vy = 0
      }
      game.advance(1 / 60)
      near = Math.min(near, Math.hypot(orb.x - target.x, orb.y - target.y))
    }
    return {
      near,
      orb,
      lost: SHIP_TYPES.alienFrigate.hull - target.hull,
      field: target.shieldRadius(),
    }
  }

  // Its own side's ordnance comes straight back off the surface, at the speed it arrived.
  const friendly = orbAt("alienFrigate")
  assert.ok(friendly.near > friendly.field * 0.95, "it bounces at the surface of the field")
  assert.ok(friendly.orb.vx < 0, "and goes back the way it came")
  assert.ok(
    Math.abs(Math.hypot(friendly.orb.vx, friendly.orb.vy) - WEAPON_TYPES.warpOrb.speed) < 1,
    "with nothing taken off it",
  )
  assert.equal(friendly.lost, 0, "so a sector of aliens is never one where they shoot each other")

  // A rival's is pushed against instead, which is a slower business and gets further in.
  const hostile = orbAt("frigate")
  assert.ok(hostile.near < friendly.near, "an enemy round gets closer than a friendly one")
  assert.equal(hostile.lost, 0, "though still not to the hull")
})

test("the field turns shot away, so a stream of it cannot take a pincer apart", () => {
  // What a flak turret was doing before the field repelled shot: taking a pincer to
  // pieces. A round now has to push through a field that leans harder the closer it
  // comes, and what matters is whether it arrives at all.
  const fireAt = (gun, rounds) => {
    const game = liveGame()
    game.player.x = -9000
    game.player.y = -9000
    game.asteroids = [new Asteroid({ vertices: square(-600, -600, 40), spin: 0 })]
    // The core alone: what is being measured is what reaches the hull, not what the
    // hull's own guns spend holding the field up.
    const alien = plainRival(
      500,
      320,
      "alienFrigate",
      SHIP_TYPES.alienFrigate.loadout.filter((entry) => entry.core),
    )
    game.rivals = [alien]
    const type = WEAPON_TYPES[gun]
    const full = alien.hull
    let lowest = alien.energy
    for (let shot = 0; shot < rounds; shot++) {
      const round = new Projectile(900, 320, -type.speed, 0, type.damage, null, type)
      game.projectiles = [round]
      for (let i = 0; i < 200 && !round.dead; i++) {
        alien.x = 500
        alien.y = 320
        alien.vx = 0
        alien.vy = 0
        game.advance(1 / 60)
        lowest = Math.min(lowest, alien.energy)
      }
    }
    // The lowest the cell got, not where it ended: a round is turned away in a fraction
    // of a second and the core refills between them, so the cost only shows while it is
    // being paid.
    return { lost: full - alien.hull, lowest }
  }

  const flak = fireAt("defenseFlak", 12)
  assert.equal(flak.lost, 0, "twelve flak rounds must not take a single point of hull")
  assert.ok(
    flak.lowest < SHIP_TYPES.alienFrigate.energyMax,
    "and turning them away cost the field while it was doing it",
  )

  // The beam is the answer instead, which is a channel the field absorbs rather than
  // repels: it pays energy for that and cannot be shot to pieces around it.
  const orbs = fireAt("warpOrb", 6)
  assert.equal(orbs.lost, 0, "nor do its own orbs, fired back at it")
})

test("the frigate's cell soaks far more shot than beam", () => {
  // The point of the bulwark: a turret used to strip a frigate's shield in under two
  // seconds, which is no kind of siege hull.
  const game = liveGame()
  const spend = (channel, damage) => {
    const frigate = new RivalShip(600, 300, "frigate", SHIP_TYPES.frigate.loadout)
    const before = frigate.energy
    frigate.takeDamage(damage, game, channel)
    return before - frigate.energy
  }
  const shot = spend("projectile", 100)
  const beam = spend("laser", 100)
  assert.ok(shot < beam, `the same hit costs less as shot (${shot}) than as beam (${beam})`)
  assert.ok(shot < 100, "and shot costs less than a point per point")
  assert.ok(beam > 100, "while a beam costs more")
})

test("a deflector-shielded hull rides out a point-blank blast", () => {
  // Six seconds without a shield is a death sentence for a 29-point hull in a
  // rock field, so the shield has to take a blast rather than collapse to one.
  const game = liveGame()
  game.player.x = -9000
  game.player.y = -9000
  const seeker = new RivalShip(500, 320, "seeker", SHIP_TYPES.seeker.loadout)
  game.rivals = [seeker]
  assert.equal(seeker.shieldModule().typeName, "deflector")
  assert.ok(seeker.shieldUp())
  seeker.takeDamage(CONFIG.BLAST_DAMAGE, game, "projectile")
  assert.ok(seeker.shieldUp(), "a blast at zero range must not overload it")
  assert.equal(seeker.hull, SHIP_TYPES.seeker.hull, "and must not reach the hull")

  // but it is still wide open to the one channel it does not cover
  const bare = liveGame()
  bare.player.x = -9000
  bare.player.y = -9000
  const other = new RivalShip(500, 320, "seeker", SHIP_TYPES.seeker.loadout)
  other.angle = 0
  bare.rivals = [other]
  bare.applyBeam(
    { a: { x: 200, y: 320 }, b: { x: 900, y: 320 }, dir: { x: 1, y: 0 } },
    bare.player,
    playerWeapon,
    68,
  )
  assert.ok(other.dead, "one laser hit must still finish it")
})

test("the seeker shoots at the player rather than at rocks", () => {
  // Its nose used to carry a miner, which fires only when a rock is near and
  // only along the host's facing, so its offence was a side effect of hunting.
  const nose = SHIP_TYPES.seeker.loadout.find((entry) => entry.hp === 0)
  const weapon = WEAPON_TYPES[nose.weapon]
  assert.equal(weapon.kind, "beam")
  assert.equal(weapon.triggerRange, undefined, "it must not be gated on a rock being close")

  const game = liveGame()
  game.asteroids = [] // nothing to mine, so anything it fires is aimed at the player
  const seeker = new RivalShip(700, 320, "seeker", SHIP_TYPES.seeker.loadout)
  seeker.angle = Math.PI // facing the player
  game.rivals = [seeker]
  const player = game.player
  player.x = 400
  player.y = 320
  const before = player.energy
  for (let i = 0; i < 600 && player.energy >= before; i++) {
    player.vx = 0
    player.vy = 0
    seeker.x = 700
    seeker.y = 320
    seeker.angle = Math.PI
    game.phase = "play" // an empty field would otherwise end the sector
    game.advance(1 / 60)
  }
  assert.ok(player.energy < before, "with no rocks at all, it must still shoot the player")
})

test("a shield only stops the channels it blocks, whichever body carries it", () => {
  // A deflector stops shots and not lasers. Asked of a rock and of a hull, the
  // answer has to be the same one.
  const blocksLaser = Object.keys(SHIELD_TYPES).find((key) =>
    SHIELD_TYPES[key].blocks.includes("laser"),
  )
  const passesLaser = Object.keys(SHIELD_TYPES).find(
    (key) => !SHIELD_TYPES[key].blocks.includes("laser"),
  )
  assert.ok(passesLaser, "some shield should let a laser through, or there is nothing to test")

  const fire = (game) =>
    game.applyBeam(
      { a: { x: 200, y: 320 }, b: { x: 1000, y: 320 }, dir: { x: 1, y: 0 } },
      game.player,
      playerWeapon,
      68,
    )
  // A hull: does the shield soak it, or does the beam reach the hull inside?
  const hitShip = (shield) => {
    const game = liveGame()
    game.player.x = -9000
    game.player.y = -9000
    const ship = new RivalShip(500, 320, "scout", [{ hp: 2, shield }])
    ship.angle = 0
    game.rivals = [ship]
    const energy = ship.energy,
      hull = ship.hull
    fire(game)
    return { soaked: ship.energy < energy, reachedHull: ship.dead || ship.hull < hull }
  }
  // A rock: the same question, where reaching it means being cut apart.
  const hitRock = (shield) => {
    const game = liveGame()
    game.player.x = -9000
    game.player.y = -9000
    const rock = new Asteroid({ vertices: square(500, 320, 70) })
    rock.hardpoints.push({ x: rock.center.x, y: rock.center.y, module: new Shield(shield) })
    rock.refreshEnergy()
    game.asteroids = [rock]
    const energy = rock.energy
    fire(game)
    return { soaked: rock.energy < energy, reachedHull: !game.asteroids.includes(rock) }
  }
  for (const [what, hit] of [
    ["a hull", hitShip],
    ["a rock", hitRock],
  ]) {
    const blocked = hit(blocksLaser)
    assert.ok(blocked.soaked, `${what} with a laser-blocking shield must soak the beam`)
    assert.ok(!blocked.reachedHull, `${what} with one must not be reached through it`)
    const passed = hit(passesLaser)
    assert.ok(!passed.soaked, `${what} with a shield that passes lasers must not soak one`)
    assert.ok(passed.reachedHull, `${what} with one must be reached through it`)
  }
})

test("a raised shield still stops the beam, and shelters what is behind it", () => {
  const game = liveGame()
  game.player.x = -9000
  game.player.y = -9000
  const shielded = new RivalShip(500, 320, "scout", [{ hp: 2, shield: "standard" }])
  shielded.angle = 0
  const behind = plainRival(700, 320, "scout")
  behind.angle = 0
  game.rivals = [shielded, behind]
  const rock = new Asteroid({ vertices: square(860, 320, 60) })
  game.asteroids = [rock]
  assert.ok(shielded.shieldUp())
  const beam = { a: { x: 300, y: 320 }, b: { x: 1000, y: 320 }, dir: { x: 1, y: 0 } }
  game.applyBeam(beam, game.player, playerWeapon, 68)
  assert.equal(behind.dead, false, "a shield must shelter the ship behind it")
  assert.equal(game.asteroids.length, 1, "and the rock behind that")
  assert.ok(beam.b.x < 500, "the beam is truncated at the bubble it struck")
})

// The reported bug: a shot that visibly grazed a scout's shield did nothing,
// because the sim tested the hull outline while the view drew a bubble half again
// as wide around it. A scout's bubble is 22.8 against a hull reaching 16.8, and a
// frigate's is 92 against 71.5 on a hull that is a thin slab, so most of what
// looked like the target was not.
test("a beam registers on a shielded rival's bubble, not on the hull inside it", () => {
  const probe = (typeName, loadout, offset) => {
    const game = liveGame()
    const player = game.player
    player.angle = 0
    player.x = 100
    player.y = 320
    const rival = new RivalShip(500, 320 + offset, typeName, loadout)
    rival.angle = Math.PI
    game.rivals = [rival]
    const shield = rival.shieldModule()
    assert.ok(shield && shield.up, `${typeName} must start shielded`)
    const before = rival.energy
    const beam = { a: { x: 100, y: 320 }, dir: { x: 1, y: 0 }, b: { x: 1100, y: 320 } }
    game.applyBeam(beam, player, playerWeapon)
    return { registered: rival.energy !== before, bubble: rival.shieldRadius() }
  }

  const cases = [
    [
      "scout",
      [
        { hp: 0, weapon: "minerLaser", controller: "miner" },
        { hp: 2, shield: "standard" },
      ],
    ],
    ["frigate", SHIP_TYPES.frigate.loadout],
  ]
  for (const [typeName, loadout] of cases) {
    const bubble = probe(typeName, loadout, 0).bubble
    // inside the bubble but clear of the hull: this is the band that did nothing
    for (const frac of [0.5, 0.75, 0.9]) {
      const offset = bubble * frac
      assert.equal(
        probe(typeName, loadout, offset).registered,
        true,
        `${typeName}: a beam ${offset.toFixed(1)} out, inside a bubble of ${bubble.toFixed(1)}`,
      )
    }
    // and outside it, nothing should register
    assert.equal(
      probe(typeName, loadout, bubble * 1.15).registered,
      false,
      `${typeName}: clear of the bubble must still miss`,
    )
  }
})

// Emergent from cutting every hull by the same rule, and worth keeping. A beam
// through a scout's wing or nose crosses its outline twice, so it cuts. What the
// cut leaves is decided by two things, and a scout is small enough to show both:
// no piece of one ever clears the plating minimum on area, so an unarmed scout goes
// entirely to ore, while a piece holding a module that survives debris is kept
// however small it is - leaving a burning wing that still shoots back.
//
// Cut a scout at a few offsets and drive the beam along +x through it.
function grazeScout(loadout, offset) {
  const game = liveGame()
  const player = game.player
  player.angle = 0
  player.x = 100
  player.y = 320
  const scout = new RivalShip(500, 320, "scout", loadout)
  scout.angle = 0 // nose along +x, so an offset beam clips a wing and exits again
  game.rivals = [scout]
  game.asteroids = [new Asteroid({ vertices: square(2000, 2000, 40) })]
  const beam = {
    a: { x: 100, y: 320 + offset },
    dir: { x: 1, y: 0 },
    b: { x: 1100, y: 320 + offset },
  }
  const crossings = countBeamCrossings(beam, scout.worldOutline())
  const scoreBefore = game.score
  game.applyBeam(beam, player, playerWeapon)
  return {
    crossings,
    scout,
    pieces: game.asteroids.filter((a) => a.center.x < 1000),
    ore: game.oreChunks.length,
    scored: game.score - scoreBefore,
  }
}

const SCOUT_BARE = [{ hp: 0, weapon: "minerLaser", controller: "miner" }]
const SCOUT_ARMED = [
  { hp: 0, weapon: "minerLaser", controller: "miner" },
  { hp: 1, weapon: "autocannon", controller: "turret" },
]

test("a graze through an unarmed scout leaves nothing but ore", () => {
  for (const offset of [8, -8, 4]) {
    const r = grazeScout(SCOUT_BARE, offset)
    assert.equal(r.crossings, 2, `at offset ${offset} the shot must pass through, not stop inside`)
    assert.equal(r.scout.dead, true, `at offset ${offset}`)
    assert.equal(r.pieces.length, 0, `at offset ${offset}: no piece clears the plating minimum`)
    assert.ok(r.ore > 0, `at offset ${offset}: it goes to ore`)
    assert.equal(r.scored, SHIP_TYPES.scout.killScore, "nothing left behind, so it pays as a kill")
  }
})

test("a graze through an armed scout leaves the piece holding the gun, still firing", () => {
  for (const offset of [8, -8, 4]) {
    const r = grazeScout(SCOUT_ARMED, offset)
    assert.equal(r.scout.dead, true, `at offset ${offset}`)
    assert.equal(r.pieces.length, 1, `at offset ${offset}: the armed piece survives`)
    const piece = r.pieces[0]
    assert.equal(piece.hasGun(), true, "and it keeps the gun, so it goes on shooting")
    assert.ok(
      piece.area < piece.minArea,
      `it survived on the module and not on size: area ${piece.area.toFixed(0)}` +
        ` under a minimum of ${piece.minArea}`,
    )
    assert.ok(piece.burn > 0, "and it burns where it was torn")
    assert.equal(
      r.scored,
      SHIP_TYPES.scout.blastScore,
      "wreckage is left to deal with, so it pays as a blast rather than a kill",
    )
  }
})

// Cut a hull along its flank at `fraction` of its half-height, and report what is left.
function grazeHull(name, fraction) {
  const game = liveGame()
  game.player.angle = 0
  game.player.x = 100
  game.player.y = 320
  // Unshielded, since a bubble is what stops a beam reaching a hull to cut it.
  const ship = plainRival(500, 320, name, withoutShield(SHIP_TYPES[name].loadout))
  ship.angle = 0
  game.rivals = [ship]
  const half = Math.max(...SHIP_TYPES[name].outline.map(([, y]) => Math.abs(y)))
  const y = 320 + half * fraction
  const beam = { a: { x: 100, y }, dir: { x: 1, y: 0 }, b: { x: 1100, y } }
  const area = polygonArea(ship.worldOutline())
  assert.ok(countBeamCrossings(beam, ship.worldOutline()) >= 2, "the shot must pass through")
  game.applyBeam(beam, game.player, playerWeapon)
  return {
    game,
    ship,
    dead: ship.dead,
    kept: ship.dead ? 0 : polygonArea(ship.worldOutline()) / area,
    wreckage: game.asteroids.length,
    ore: game.oreChunks.length,
  }
}

test("a graze takes a corner off a big hull and leaves it flying", () => {
  const light = grazeHull("frigate", 0.75)
  assert.equal(light.dead, false, "a slab does not come apart over a corner")
  assert.ok(light.kept > 0.85, `it keeps most of itself, kept ${(light.kept * 100).toFixed(0)}%`)
  assert.ok(light.wreckage + light.ore > 0, "and the corner comes off it")
  // The wreckage burns, which is the material's business and not the cut's.
  const burning = light.game.asteroids.filter((rock) => rock.burn > 0)
  assert.ok(
    light.wreckage === 0 || burning.length > 0,
    "a piece big enough to drift drifts away burning",
  )

  // What it lost, it lost: less hull to lose, less mass to carry, and quicker round for it.
  assert.ok(light.ship.hull < SHIP_TYPES.frigate.hull, "it has less left to lose")
  assert.ok(light.ship.mass < SHIP_TYPES.frigate.laden, "and less to carry")
  assert.ok(light.ship.turnRate > SHIP_TYPES.frigate.turnRate, "so it comes about quicker")

  // A cut through the middle still finishes it: what decides is how much is left.
  const deep = grazeHull("frigate", 0.2)
  assert.equal(deep.dead, true, "a cut through the body is still a cut through the body")
})

test("a cut takes the mounts that were on the part it took, and no others", () => {
  // Some mounts sit a little outside the outline on purpose: a frigate's nozzles hang off
  // the tail so the pair sweeps it round, and the pincer's main gun is on the tip of its
  // spike. A containment test called those "not on the hull" and took them off wherever
  // the cut landed, which left a frigate steering about with no thrusters drawn.
  const noseOff = (name, at) => {
    const game = liveGame()
    game.player.x = 500
    game.player.y = -200
    game.player.angle = Math.PI / 2
    const ship = plainRival(500, 320, name, withoutShield(SHIP_TYPES[name].loadout))
    ship.angle = 0
    game.rivals = [ship]
    // Across the hull rather than along it, close to the nose: the corner it takes is the
    // front of the ship.
    const beam = { a: { x: 500 + at, y: 0 }, dir: { x: 0, y: 1 }, b: { x: 500 + at, y: 700 } }
    game.applyBeam(beam, game.player, playerWeapon)
    return ship
  }

  const frigate = noseOff("frigate", 52)
  assert.equal(frigate.dead, false, "it survives losing its nose")
  const engines = [...frigate.modules()].filter((m) => m.kind === "engine")
  assert.equal(engines.length, 2, "and keeps both nozzles, which sit off the tail")
  assert.ok(frigate.accel > 0, "so it still has something to push it")
  assert.ok(frigate.turnRate > 0, "and something to turn it")
  const nose = frigate.hardpoints.find((hp) => hp.role === "nose")
  assert.equal(nose.module, null, "what it lost is the gun that was on the part that went")

  // And the pincer keeps the gun on its spike, which is also outside the outline.
  const pincer = noseOff("alienFrigate", 62)
  assert.equal(pincer.dead, false)
  const main = pincer.hardpoints.find((hp) => hp.role === "nose")
  assert.ok(main.module, "its main gun is on the piece it kept")
  assert.equal([...pincer.modules()].filter((m) => m.kind === "engine").length, 2)
})

test("the edge a cut leaves on a surviving hull burns", () => {
  // The piece that came off burns, because a rock made of plating does. The ship it came
  // off is made of the same stuff and had the same face left raw, and was showing nothing.
  const light = grazeHull("frigate", 0.5)
  assert.equal(light.dead, false)
  assert.ok(light.ship.burn > 0, "the fresh edge is alight")
  assert.ok(light.ship.burnFaces.length > 0, "along the face the beam left")

  const fire = () =>
    light.game.particles.filter((p) => p.color === PALETTE.fx.fire || p.color === PALETTE.fx.ember)
      .length
  const before = fire()
  for (let i = 0; i < 60; i++) {
    light.game.advance(1 / 60)
  }
  assert.ok(fire() > before, "and it throws fire while it flies")

  // Smoke comes off it as well, and lasts long enough to be strung out behind it.
  const smoke = light.game.particles.filter((p) => p.color === PALETTE.fx.smoke)
  assert.ok(smoke.length > 0, "it smokes as it burns")
  assert.ok(
    Math.max(...smoke.map((p) => p.maxLife)) > 2,
    "and the smoke hangs about for seconds, not for a flicker",
  )

  // It burns out, rather than smoking for the rest of the run. Ticked directly, since
  // it burns for longer than the sector it was cut in lasts once the rocks are gone.
  for (let i = 0; i < 60 * (SHIP_PLATING.burn.seconds + 1); i++) {
    light.ship.updateBurn(1 / 60, light.game)
  }
  assert.equal(light.ship.burn, 0, "and then it is out")

  // The face is drawn too, in the same colour the wreckage burns.
  const cut = grazeHull("frigate", 0.5)
  const drawn = []
  const renderer = new Proxy(
    { line: (x1, y1, x2, y2, opts) => drawn.push(opts && opts.color) },
    { get: (target, key) => (key in target ? target[key] : () => {}) },
  )
  cut.ship.draw(renderer, cut.game)
  assert.ok(drawn.includes(PALETTE.fx.fire), "the raw edge glows")
})

test("a sector full of burning wreckage does not run the particle buffer out", () => {
  // Past the cap the oldest particles go, so a buffer sized under what a busy sector
  // asks for quietly eats the effects of everything else happening in it.
  const game = liveGame()
  game.player.x = -3000
  game.player.y = -3000
  game.player.invincible = 1e9
  const ships = []
  for (let k = 0; k < 6; k++) {
    const which = k % 2 ? "frigate" : "alienFrigate"
    const ship = plainRival(200 + k * 200, 320, which, withoutShield(SHIP_TYPES[which].loadout))
    ship.angle = 0
    ships.push(ship)
  }
  game.rivals = ships
  for (const ship of ships) {
    const y = ship.y + 14
    const beam = { a: { x: ship.x - 200, y }, dir: { x: 1, y: 0 }, b: { x: ship.x + 200, y } }
    game.applyBeam(beam, game.player, playerWeapon)
  }
  assert.ok(
    game.asteroids.filter((rock) => rock.burn > 0).length >= 6,
    "the sector must actually be full of burning wreckage for this to measure anything",
  )
  let peak = 0
  for (let i = 0; i < 60 * 8; i++) {
    game.advance(1 / 60)
    peak = Math.max(peak, game.particles.length)
  }
  assert.ok(peak > 1000, `the scene must be a heavy one, peaked at ${peak}`)
  assert.ok(peak < MAX_PARTICLES, `and must fit, peaked at ${peak} of ${MAX_PARTICLES}`)
})

test("what colour a hull burns is its material's, so an alien burns green", () => {
  // No drawing code holds a colour of its own: the material states what its fire and
  // embers are made of, so a sector strewn with wreckage reads as to whose it is.
  const alien = grazeHull("alienFrigate", 0.6)
  assert.equal(alien.dead, false, "it flies on with a jaw off")
  const piece = alien.game.asteroids.find((rock) => rock.burn > 0)
  assert.ok(piece, "and what came off it burns")
  assert.equal(piece.burnSpec.colour, PALETTE.alien.fire)

  const thrown = new Set(alien.game.particles.map((p) => p.color))
  assert.ok(thrown.has(PALETTE.alien.fire), "the cut throws their fire")
  assert.ok(!thrown.has(PALETTE.fx.fire), "and none of ours")

  const drawn = []
  const renderer = new Proxy(
    { line: (x1, y1, x2, y2, opts) => drawn.push(opts && opts.color) },
    { get: (target, key) => (key in target ? target[key] : () => {}) },
  )
  alien.ship.draw(renderer, alien.game)
  assert.ok(drawn.includes(PALETTE.alien.fire), "and the raw edge glows green")
  assert.ok(!drawn.includes(PALETTE.fx.fire))

  // A rival cut the same way still burns in ours, which is the contrast worth having.
  assert.equal(grazeHull("frigate", 0.5).ship.burnSpec.colour, PALETTE.fx.fire)
})

test("a dart commits to the arc it breaks off along", () => {
  // Turning slower on the way out is what makes it an arc rather than a spin on the spot
  // followed by a straight run: the whole point of a dart is that it has to commit.
  const seeker = SHIP_TYPES.seeker
  assert.ok(seeker.breakOff.turn < 1, "it manages less than its full rate while going")
  assert.ok(seeker.turnRate <= 3.25, "and no better than the player at its best")

  const game = liveGame()
  game.asteroids = [new Asteroid({ vertices: square(-900, -900, 40), spin: 0 })]
  beSolid(game.player)
  game.player.takeDamage = () => {}
  game.player.x = 500
  game.player.y = 320
  game.player.angle = 0
  const rival = plainRival(600, 320, "seeker") // well inside its break-off range
  rival.angle = Math.PI
  game.rivals = [rival]

  let most = 0
  for (let i = 0; i < 30; i++) {
    const was = rival.angle
    game.player.x = 500
    game.player.y = 320
    rival.update(1 / 60, game)
    most = Math.max(most, Math.abs(shortestTurn(was, rival.angle)) * 60)
  }
  assert.ok(rival.breaking > 0, "it is on its way out")
  assert.ok(
    most <= seeker.turnRate * seeker.breakOff.turn + 1e-6,
    `while going it turned at ${most.toFixed(2)}, over its ${(seeker.turnRate * seeker.breakOff.turn).toFixed(2)}`,
  )
})

test("a small hull is finished by any cut at all, however light", () => {
  // The other half of the rule, and what keeps the existing behaviour: the whole of a
  // scout is a fraction of the smallest piece its plating holds together in, so there is
  // no corner it can lose and still be a ship. Grazed or halved, it comes apart.
  for (const name of ["scout", "seeker", "alienScout"]) {
    for (const fraction of [0.9, 0.5, 0]) {
      const cut = grazeHull(name, fraction)
      assert.equal(cut.dead, true, `a ${name} grazed at ${fraction} of its half-height`)
    }
  }
})

test("a raised shield is what stops a beam", () => {
  const game = liveGame()
  const { rival, beam } = targetWithRockBehind(game, "scout", [
    { hp: 0, weapon: "minerLaser", controller: "miner" },
    { hp: 2, shield: "standard" },
  ])
  assert.ok(rival.shieldModule().up, "the shield must be up for this to mean anything")
  game.applyBeam(beam, game.player, playerWeapon)
  assert.equal(rival.dead, false, "a shielded hull is not cut")
  assert.equal(game.asteroids.length, 1, "and it does stop the beam short of the rock")
  assert.ok(game.asteroids[0].center.x > 700, "the rock behind is untouched")
})

// A scout's halves fall below what plating holds together, so it is destroyed
// where it stood, exactly as a rock below AST_MIN_AREA shatters to ore. Nothing
// tests the ship by name: lower the material's threshold and the same hull comes
// apart instead, which is what a type sized between scout and frigate does.
test("what a cut hull leaves is decided by its material, not by its type", () => {
  const cut = (minArea) => {
    const game = liveGame()
    const { rival, beam } = targetWithRockBehind(game, "scout", [])
    rival.type = Object.create(rival.type)
    rival.type.debrisMaterial = { ...SHIP_PLATING, minArea }
    const oreBefore = game.oreChunks.length
    game.applyBeam(beam, game.player, playerWeapon)
    return {
      dead: rival.dead,
      wreckage: game.asteroids.filter((a) => a.center.x < 700).length,
      ore: game.oreChunks.length - oreBefore,
    }
  }
  const asPlating = cut(SHIP_PLATING.minArea)
  assert.equal(asPlating.dead, true)
  assert.equal(asPlating.wreckage, 0, "a scout's halves are too small to hold together")
  assert.ok(asPlating.ore > 0, "so it goes to ore")

  const asTougher = cut(20) // a material that survives in far smaller pieces
  assert.equal(asTougher.dead, true)
  assert.ok(asTougher.wreckage >= 2, `the same hull must split, got ${asTougher.wreckage} pieces`)
})

test("a shattered hull pays what shooting it down pays", () => {
  // Cutting a scout in two destroys it, and must be worth the same as killing it
  // with shots, since in both cases nothing is left behind to mine.
  const game = liveGame()
  const { rival, beam } = targetWithRockBehind(game, "scout", [])
  const scoreBefore = game.score
  game.applyBeam(beam, game.player, playerWeapon)
  assert.equal(rival.dead, true)
  assert.equal(
    game.score - scoreBefore,
    SHIP_TYPES.scout.killScore + CONFIG.SLICE_SCORE,
    "a shattered hull pays killScore (the rock behind adds SLICE_SCORE)",
  )
  assert.equal(game.oreChunks.length, SHIP_TYPES.scout.oreDrop, "and drops its oreDrop")
})

test("the player's hull is never cut into wreckage", () => {
  const game = liveGame()
  const player = game.player
  player.angle = 0
  player.x = 400
  player.y = 320
  player.energy = 0 // nothing to hide behind
  const shooter = plainRival(100, 320, "scout")
  game.rivals = [shooter]
  const beam = { a: { x: 100, y: 320 }, dir: { x: 1, y: 0 }, b: { x: 900, y: 320 } }
  assert.ok(countBeamCrossings(beam, player.worldOutline()) >= 2, "the beam must pass through")
  assert.equal(player.severable, false)
  const lives = game.lives
  game.applyBeam(beam, shooter, { type: WEAPON_TYPES.cannonLaser })
  assert.equal(game.asteroids.length, 0, "the player leaves no hull debris")
  assert.equal(game.lives, lives - 1, "it costs a life instead")
})

test("frigate debris is partitioned into convex parts that tile it", () => {
  const game = liveGame()
  const { tail } = frigateOnAxis(game)
  const origin = { x: tail - 20, y: 320 }
  game.applyBeam(
    { a: origin, dir: { x: 1, y: 0 }, b: { x: origin.x + 400, y: 320 } },
    game.player,
    playerWeapon,
  )
  assert.ok(game.asteroids.length >= 2)
  for (const piece of game.asteroids) {
    const parts = piece.convexParts()
    const total = parts.reduce((sum, part) => sum + polygonArea(part), 0)
    assert.ok(
      Math.abs(total - piece.area) < 1e-6 * Math.max(1, piece.area),
      `parts cover ${total.toFixed(2)} of ${piece.area.toFixed(2)}`,
    )
    assert.equal(parts.length, convexPartition(piece.vertices).length)
  }
})

// The complaint this guards: a full-charge shot stripped a scout's shield in one
// hit and a frigate's in three, so a frigate died in four shots. A shield should
// take a few hits. The exact counts are a tuning matter and deliberately not
// asserted; that one shot is never enough is not.
test("a full-charge shot does not strip a shielded rival's shield in one hit", () => {
  for (const [typeName, loadout] of [
    ["scout", [{ hp: 2, shield: "standard" }]],
    ["frigate", SHIP_TYPES.frigate.loadout],
  ]) {
    const game = liveGame()
    const player = game.player
    player.angle = 0
    player.x = 200
    player.y = 320
    const rival = new RivalShip(500, 320, typeName, loadout)
    rival.angle = Math.PI
    game.rivals = [rival]
    const shield = rival.shieldModule()
    assert.ok(shield && shield.up, `${typeName} must start shielded`)

    player.mainWeapon.charge = WEAPON_TYPES.playerLaserMk1.chargeMax
    player.mainWeapon.cooldown = 0
    player.fireLaser(game)

    assert.ok(rival.energy < rival.energyMax, `${typeName} must take the hit on its shield`)
    assert.equal(shield.up, true, `${typeName}'s shield must survive one full-charge shot`)
    assert.equal(rival.dead, false, `${typeName} must survive it`)
    assert.equal(game.asteroids.length, 0, "and must not be cut while shielded")
  }
})

test("charge buys reach, and damage follows it more gently", () => {
  const weapon = WEAPON_TYPES.playerLaserMk1
  const damageAt = (charge) => {
    const game = liveGame()
    const player = game.player
    player.angle = 0
    const scout = new RivalShip(player.x + 60, player.y, "scout", [{ hp: 2, shield: "standard" }])
    game.rivals = [scout]
    const before = scout.energy
    player.mainWeapon.charge = charge
    player.mainWeapon.cooldown = 0
    player.fireLaser(game)
    return before - scout.energy
  }
  const low = damageAt(weapon.chargeMin)
  const high = damageAt(weapon.chargeMax)
  assert.ok(Math.abs(low - weapon.damage) < 1e-6, "minimum charge does the weapon's base damage")
  assert.ok(high > low, "full charge does more")
  const reachRatio =
    (weapon.chargeMax + weapon.chargeReach) / (weapon.chargeMin + weapon.chargeReach)
  assert.ok(high / low < reachRatio, "damage scales less steeply than reach")
})

// ---- the sector summary ---------------------------------------------------

test("damage taken is recorded even when the shield absorbs it", () => {
  const game = withShield(liveGame())
  const player = game.player
  const shield = player.shieldModule()
  assert.ok(shield && shield.up, "the shield should start up")
  player.takeDamage(50, game, "projectile", 0, { x: player.x + 5, y: player.y })
  assert.ok(player.energy < player.energyMax, "the shield drained")
  assert.equal(game.lives, CONFIG.START_LIVES, "no life was lost")
  assert.equal(game.stats.damage, 50, "the hit is still counted")
})

test("buying a turret mounts the one that was chosen, and owning both allows a swap", () => {
  const game = liveGame()
  const aux = game.player.hardpointByRole("aux")
  assert.equal(aux.module, null, "the mount starts empty: a turret is bought, not issued")
  assert.equal(game.player.hasTurret(), false)

  game.oreBalance = 500
  const [blaster, flak] = EQUIPMENT.turret.options
  game.equipmentRows("turret")[0].action(game)
  assert.equal(aux.module.typeName, blaster.id)
  assert.equal(game.player.hasTurret(), true)

  // fitting what is already there leaves the module alone, so a reload is not reset
  const mounted = aux.module
  game.equipmentRows("turret")[0].action(game)
  assert.equal(aux.module, mounted)

  // neither is a step up from the other, so both are offered at once and swapping
  // between them costs nothing
  assert.ok(!EQUIPMENT.turret.ladder, "the two guns are a choice, not a ladder")
  const ore = game.oreBalance
  game.equipmentRows("turret")[1].action(game)
  assert.equal(aux.module.typeName, flak.id)
  assert.equal(game.oreBalance, ore - flak.cost, "the second one is bought")
  game.equipmentRows("turret")[0].action(game)
  assert.equal(aux.module.typeName, blaster.id, "and swapping back is free")
  assert.equal(game.oreBalance, ore - flak.cost)
})

test("a resumed run re-mounts the turret it had already bought", () => {
  const game = liveGame()
  withEquipment(game, "turret", EQUIPMENT.turret.options[1].id)
  game.level = 5
  game.enterShop()
  const resumed = new Game()
  resumed.savedRun = game.savedRun
  resumed.resumeRun()
  assert.equal(resumed.fittedEquipment("turret"), EQUIPMENT.turret.options[1].id)
  assert.ok(resumed.player.hasTurret(), "the turret must come back with the run")
})

test("the accuracy bonus is withheld when nothing was fired", () => {
  const game = liveGame()
  game.level = 4
  game.enterShop()
  assert.equal(game.summaryData.accuracy, 0)
  assert.equal(game.summaryData.accuracyBonus, 0, "no shots is not perfect accuracy")
})

test("the accuracy bonus scales with the hit fraction", () => {
  const game = liveGame()
  game.level = 4
  game.stats.shots = 4
  game.stats.hits = 3
  game.enterShop()
  assert.equal(game.summaryData.accuracy, 0.75)
  assert.equal(game.summaryData.accuracyBonus, Math.round(0.75 * CONFIG.ACCURACY_BONUS))
})

test("the flawless bonus is withheld after taking a hit", () => {
  const game = liveGame()
  game.player.takeDamage(50, game, "projectile", 0, { x: game.player.x, y: game.player.y })
  game.enterShop()
  assert.equal(game.summaryData.flawlessBonus, 0)
  assert.equal(game.summaryData.damage, 50)
})

test("the flawless bonus is paid for an untouched sector", () => {
  const game = liveGame()
  game.enterShop()
  assert.equal(game.summaryData.flawlessBonus, CONFIG.FLAWLESS_BONUS)
  assert.equal(game.summaryData.damage, 0)
})

test("damage mid-warp is ignored, and not counted", () => {
  const game = liveGame()
  game.player.warp = 0 // dissolved, so nothing can reach it
  game.player.takeDamage(500, game, "projectile", 0, { x: 0, y: 0 })
  assert.equal(game.stats.damage, 0)
  assert.equal(game.player.energy, game.player.energyMax)
})

test("a body that is not in the sector neither stops a beam nor swallows a shot", () => {
  // A rock directly behind the body: it is cut when the beam gets through.
  const behind = () => new Asteroid({ vertices: square(700, 320, 60), vx: 0, vy: 0 })
  const beamPast = (pose) => {
    const game = liveGame()
    const shooter = plainRival(150, 320, "scout")
    shooter.angle = 0
    game.rivals.push(shooter)
    game.asteroids = [behind()]
    pose(game)
    const before = game.asteroids.length
    game.applyBeam(
      { a: { x: 200, y: 320 }, b: { x: 1000, y: 320 }, dir: { x: 1, y: 0 } },
      shooter,
      playerWeapon,
      30,
    )
    return game.asteroids.length > before
  }
  // The player is at the centre of the view, squarely in the beam's path.
  const inTheWay = (game) => {
    game.player.x = 500
    game.player.y = 320
    game.player.angle = 0
  }
  assert.ok(
    beamPast((game) => {
      inTheWay(game)
      game.player.warp = 0.4 // mid-warp: not really here
    }),
    "a beam must pass through a ship that is mid-warp",
  )
  assert.ok(!beamPast(inTheWay), "and must still be stopped by the same ship once it is solid")

  // The same question for a projectile, which must not be spent on it either.
  const shootAt = (pose) => {
    const game = liveGame()
    inTheWay(game)
    pose(game)
    const bullet = new Projectile(game.player.x - 60, game.player.y, 900, 0, 100, null)
    game.projectiles = [bullet]
    for (let i = 0; i < 200 && !bullet.dead; i++) {
      bullet.update(1 / 600, game)
    }
    return bullet.dead
  }
  assert.ok(!shootAt((game) => (game.player.warp = 0.4)), "a shot must fly past a warping ship")
  assert.ok(
    shootAt(() => {}),
    "and must still be stopped by a solid one",
  )
})

test("a rival outside the arena is passed through by a shot, as it is by a beam", () => {
  const game = liveGame()
  // Just past the ring, where a rival flying in actually sits. A shot expires of
  // its own accord out here, so the impact effect is what tells the two apart.
  const rival = plainRival(ARENA.cx + ARENA.radius + 20, ARENA.cy, "scout")
  rival.angle = Math.PI
  game.rivals = [rival]
  assert.ok(!rival.inPlay(), "the rival must actually be outside the arena")
  assert.equal(game.particles.length, 0)
  const bullet = new Projectile(rival.x - 60, rival.y, 900, 0, 100, null)
  game.projectiles = [bullet]
  for (let i = 0; i < 400 && !bullet.dead; i++) {
    bullet.update(1 / 600, game)
  }
  assert.equal(game.particles.length, 0, "a rival that cannot be hurt must strike no sparks")
  assert.equal(rival.hull, SHIP_TYPES.scout.hull)
})

// ---- specials are declared, not special-cased ------------------------------

test("a special's ongoing effect is read from its registry entry", () => {
  const game = liveGame()
  const player = game.player
  assert.equal(player.buffField("beamLengthMult", 1), 1)
  // grant whichever special declares the effect, rather than naming one here
  const id = Object.keys(SPECIAL_TYPES).find((key) => SPECIAL_TYPES[key].beamLengthMult)
  player.grantBuff(id, 5)
  assert.equal(player.beamLengthMult(), SPECIAL_TYPES[id].beamLengthMult)
})

test("a special declaring collisionImmune stops rock contact damage", () => {
  const id = Object.keys(SPECIAL_TYPES).find((key) => SPECIAL_TYPES[key].collisionImmune)
  assert.ok(id, "some special should declare collision immunity")
  const ram = (withBuff) => {
    const game = liveGame()
    const player = game.player
    player.x = 300
    player.y = 320
    if (withBuff) {
      player.grantBuff(id, 10)
    }
    game.asteroids = [new Asteroid({ vertices: square(500, 320, 80), vx: 0, vy: 0 })]
    for (let i = 0; i < 90; i++) {
      player.vx = 300
      player.vy = 0
      game.advance(1 / 60)
    }
    return game.stats.damage
  }
  assert.ok(ram(false) > 0, "ramming a rock should hurt")
  assert.equal(ram(true), 0, "unless a special says otherwise")
})

// Drive a rival into a stationary boulder and report what first contact cost it.
// The ship starts a fixed gap from the rock's face rather than at a fixed x, so
// a frigate at 44 u/s reaches it in the same run as a scout at 190. It stops on
// the first damage: left running it grinds itself to death at any scale, which
// would read the same for all of them.
function ramARock(typeName) {
  const game = liveGame()
  game.player.x = -9000 // keep the player out of it
  game.player.y = -9000
  const rockFace = 440
  const full = SHIP_TYPES[typeName].hull
  // Its own loadout without the shield: the ram has to reach the hull, and the ship
  // needs its drive, since a hull with none has a top speed of nothing and the speed
  // clamp would hold it still.
  //
  // Placed so the hull's leading edge starts 60 units short of the rock, whatever the
  // hull is: measured from the centre instead, a wide slow one spent the whole run
  // closing and only reached the rock at all if its own spin happened to swing a
  // corner into the way.
  const ship = plainRival(
    rockFace - SHIP_TYPES[typeName].boundRadius - 60,
    320,
    typeName,
    withoutShield(SHIP_TYPES[typeName].loadout),
  )
  ship.angle = 0
  game.rivals = [ship]
  game.asteroids = [new Asteroid({ vertices: square(rockFace + 80, 320, 80), vx: 0, vy: 0 })]
  for (let i = 0; i < 400; i++) {
    ship.vx = SHIP_TYPES[typeName].maxSpeed
    ship.vy = 0
    game.advance(1 / 60)
    if (ship.dead) {
      return full
    }
    if (ship.hull < full) {
      return full - ship.hull
    }
  }
  return 0
}

test("a mount only fires where it can bear", () => {
  // A gun buried in the jaw of a pincer covers what is in front of the ship and
  // nothing behind it, which is a property of the mount rather than of the gun: the
  // same autocannon on a ring traverses freely.
  const game = liveGame()
  const target = plainRival(500, 320, "scout")
  game.rivals = [target]
  const held = new Weapon("autocannon", "turret", 0.5)
  const free = new Weapon("autocannon", "turret")
  assert.equal(free.arc, Infinity, "a mount that states no arc has none")

  const host = { angle: 0, x: 400, y: 320 }
  assert.ok(held.bearsOn(host, 0), "dead ahead is inside a forward mount's arc")
  assert.ok(held.bearsOn(host, 0.4), "and so is a bearing just inside it")
  assert.ok(!held.bearsOn(host, 1), "a bearing outside it is not")
  assert.ok(!held.bearsOn(host, Math.PI), "least of all one astern")
  assert.ok(free.bearsOn(host, Math.PI), "which the free mount answers regardless")

  // The gun's own arc still applies when the mount states none, which is what the
  // heavy cannon has always used to decide whether it is lined up.
  const cannon = new Weapon("cannonLaser", "hunter")
  assert.equal(cannon.arc, WEAPON_TYPES.cannonLaser.arc)
})

test("the pincer's jaw guns face forward and its rear pair do not", () => {
  const design = SHIP_TYPES.alienFrigate
  // By the mount rather than by the gun on it: what it carries is data, where it can
  // point is the claim.
  const arcs = design.loadout
    .filter((entry) => design.hardpoints[entry.hp].role === "gun")
    .map((entry) => entry.arc ?? Infinity)
  assert.equal(arcs.length, 4, "four turrets")
  assert.equal(arcs.filter((arc) => arc < Math.PI / 2).length, 2, "two held to the front")
  assert.equal(arcs.filter((arc) => arc === Infinity).length, 2, "two that traverse freely")
})

test("a round is drawn the way its own gun draws rounds", () => {
  // Every projectile in the game was drawn as the same orange streak, whatever fired
  // it: the guns each stated a colour and nothing read it.
  const drawn = []
  const renderer = {
    line: (x1, y1, x2, y2, opts) => drawn.push({ kind: "line", colour: opts.color }),
    circle: (x, y, r, opts) => drawn.push({ kind: "circle", r, colour: opts.stroke || opts.fill }),
  }
  const shot = (weapon) => {
    drawn.length = 0
    const p = new Projectile(0, 0, 100, 0, 10, null, WEAPON_TYPES[weapon])
    p.draw(renderer)
    return [...drawn]
  }

  // A gun that says nothing about its rounds still gets the streak, in its own colour.
  const cannon = shot("autocannon")
  assert.equal(cannon.length, 1, "one streak")
  assert.equal(cannon[0].kind, "line")
  assert.equal(cannon[0].colour, WEAPON_TYPES.autocannon.colour)

  // The aliens throw balls, which is a different shape and not a streak at all.
  const orb = shot("warpOrb")
  assert.ok(
    orb.every((piece) => piece.kind === "circle"),
    "an orb is drawn as circles rather than as a smear",
  )
  assert.equal(orb[0].colour, WEAPON_TYPES.warpOrb.colour)
  assert.ok(orb[0].r >= WEAPON_TYPES.warpOrb.shot.radius * 0.8, "about the size it states")

  // And it breathes, so two moments of the same shot are not the same size.
  const one = new Projectile(0, 0, 100, 0, 10, null, WEAPON_TYPES.warpOrb)
  one.age = 0
  drawn.length = 0
  one.draw(renderer)
  const first = drawn[0].r
  one.age = Math.PI / (2 * WEAPON_TYPES.warpOrb.shot.pulse)
  drawn.length = 0
  one.draw(renderer)
  assert.ok(Math.abs(drawn[0].r - first) > 0.5, "the ball pulses as it travels")
})

test("an alien orb leans after what it was fired at", () => {
  const game = liveGame()
  game.player.x = 500
  game.player.y = 200 // off to one side of where the shot is going
  const alien = plainRival(500, 500, "alienSeeker")
  game.rivals = [alien]

  // Fired straight along +x, with the player well off that line, and started clear of
  // the alien's own field: that repels loose shot, including its own, which would bend
  // the very thing being measured.
  const orb = new Projectile(
    800,
    500,
    WEAPON_TYPES.warpOrb.speed,
    0,
    10,
    alien,
    WEAPON_TYPES.warpOrb,
  )
  game.projectiles = [orb]
  const heading = () => Math.atan2(orb.vy, orb.vx)
  const before = heading()
  const speed = Math.hypot(orb.vx, orb.vy)
  for (let i = 0; i < 30; i++) {
    game.advance(1 / 60)
  }
  assert.ok(heading() < before, "it curved toward the player")
  assert.ok(Math.abs(Math.hypot(orb.vx, orb.vy) - speed) < 1e-6, "by turning, not by speeding up")
  // Gently: half a second of steering must not have it pointing at the target already.
  const straightAt = bearingTo(orb, game.player)
  assert.ok(Math.abs(shortestTurn(heading(), straightAt)) > 0.2, "and not sharply")

  // With whatever fired it gone, it stops caring.
  alien.dead = true
  const held = heading()
  for (let i = 0; i < 30; i++) {
    game.advance(1 / 60)
  }
  assert.equal(heading(), held, "a ball with nothing behind it flies on as it was")
})

test("an orb lands with weight, and comes apart even if it reaches nothing", () => {
  const shoot = (gun, place) => {
    const game = liveGame()
    beSolid(game.player)
    // Shielded, so the round is absorbed: an unshielded player loses a life to anything
    // that lands, and the shake of dying is louder than the shake being measured.
    withEquipment(game, "shield", "playerShieldMk4")
    game.player.x = 500
    game.player.y = 320
    // One rock, well out of the way. An empty field is a cleared sector, and a cleared
    // sector sends the run to the shop and empties the projectile list part way through
    // the measurement.
    game.asteroids = [new Asteroid({ vertices: square(200, 620, 40), spin: 0 })]
    const type = WEAPON_TYPES[gun]
    const shot = new Projectile(place.x, place.y, place.vx, 0, 10, null, type)
    game.projectiles = [shot]
    game.screenShake = 0
    for (let i = 0; i < 300 && !shot.dead; i++) {
      game.player.x = 500
      game.player.y = 320
      game.advance(1 / 60)
    }
    // Counted by colour: the sector is full of particles the ship's own drive is
    // throwing, and what is being measured is what came off the round.
    const colour = (type.impact && type.impact.colour) || PALETTE.weapon.bulletImpact
    const made = game.particles.filter((p) => p.color === colour).length
    return { shot, made, shake: game.screenShake }
  }

  // On the hull: much more comes off it than off an ordinary round, and the screen
  // moves for it.
  const orb = shoot("warpOrb", { x: 620, y: 320, vx: -WEAPON_TYPES.warpOrb.speed })
  const round = shoot("autocannon", { x: 620, y: 320, vx: -WEAPON_TYPES.autocannon.speed })
  assert.ok(orb.shot.dead && round.shot.dead, "both landed")
  assert.ok(
    orb.made > round.made * 2,
    `an orb should throw far more than a round: ${orb.made} against ${round.made}`,
  )
  assert.ok(
    orb.shake > round.shake,
    `and shake the screen harder: ${orb.shake} against ${round.shake}`,
  )

  // And one that reaches nothing at all still goes off where it ran out.
  const spent = shoot("warpOrb", { x: 500, y: 320, vx: 0 })
  assert.ok(spent.shot.dead, "it expired")
  assert.ok(spent.made > 0, "leaving something behind rather than winking out")
})

test("every alien hull carries alien guns", () => {
  // A hull is alien by faction, but a sector reads as alien because of what is being
  // fired across it.
  const alienGuns = Object.keys(WEAPON_TYPES).filter((name) => name.startsWith("warp"))
  assert.ok(alienGuns.length >= 3, "there should be a family of them")
  for (const [name, type] of Object.entries(SHIP_TYPES)) {
    if (type.faction !== "alien") {
      continue
    }
    const guns = [...type.loadout, ...Object.values(type.arms || {})]
      .filter((entry) => entry.weapon)
      .map((entry) => entry.weapon)
    assert.ok(guns.length, `${name} should be armed`)
    // The pincer's main gun is the singularity it was drawn around, which is still to
    // come; everything else it carries is already alien.
    const rivalGuns = guns.filter((gun) => !gun.startsWith("warp"))
    assert.ok(rivalGuns.length <= 1, `${name} still carries rival guns: ${rivalGuns.join(", ")}`)
  }
})

test("a bump against a rock costs the player hull, not the run", () => {
  // Touching a rock in the first sector used to end a life outright: the player was the
  // one hull in the game with no hull points, so anything a bubble did not take was
  // fatal, and a run starts with no bubble.
  const bump = (speed) => {
    const game = liveGame()
    beSolid(game.player)
    game.player.x = 400
    game.player.y = 320
    game.player.vx = speed
    game.player.vy = 0
    game.player.angle = 0
    game.asteroids = [new Asteroid({ vertices: square(500, 320, 50), vx: 0, vy: 0, spin: 0 })]
    const lives = game.lives
    for (let i = 0; i < 40 && game.lives === lives; i++) {
      game.advance(1 / 60)
    }
    return { alive: game.lives === lives, left: game.player.hull / PLAYER_TYPE.hull }
  }
  assert.ok(PLAYER_TYPE.hull > 0, "the player has hull, like every other ship")
  assert.equal(
    liveGame().fittedEquipment("shield"),
    null,
    "and starts a run with nothing in the shield slot, so the hull is all there is",
  )

  const gentle = bump(30)
  assert.ok(gentle.alive, "a gentle bump is survived")
  assert.ok(gentle.left > 0.9, "at little or no cost")

  const hard = bump(340)
  assert.ok(hard.alive, "so is a ram at full speed, once")
  // Which is the relationship's own promise: a full-speed ram takes about
  // `ramSurvivability` of the hull, whatever ship is doing the ramming.
  assert.ok(
    Math.abs(1 - hard.left - SHIP_SCALARS.ramSurvivability) < 0.1,
    `a full ram should cost about ${SHIP_SCALARS.ramSurvivability} of the hull, cost ${(1 - hard.left).toFixed(2)}`,
  )
  assert.ok(bump(30).left > bump(150).left, "and what it costs follows how hard it was")
})

test("the hull just lost is shown receding, so a hit reads at a glance", () => {
  const game = liveGame()
  beSolid(game.player)
  game.player.x = 400
  game.player.y = 320
  game.player.vx = 300
  game.player.angle = 0
  game.asteroids = [new Asteroid({ vertices: square(500, 320, 50), vx: 0, vy: 0, spin: 0 })]
  for (let i = 0; i < 40 && game.player.hull === PLAYER_TYPE.hull; i++) {
    game.advance(1 / 60)
  }
  assert.ok(game.player.hull < PLAYER_TYPE.hull, "the ram cost hull")
  assert.ok(game.player.hullShown > game.player.hull, "the bar still reads where it was")

  // And it closes the gap over time rather than at once.
  const gap = game.player.hullShown - game.player.hull
  game.player.vx = 0
  game.player.x = -9000 // clear of the rock, so nothing else lands
  game.advance(0.25)
  const closing = game.player.hullShown - game.player.hull
  assert.ok(closing < gap, "the lost part shrinks")
  assert.ok(closing > 0, "but not instantly")
  game.advance(gap / CONFIG.HULL_LOSS_FADE + 0.1)
  assert.equal(game.player.hullShown, game.player.hull, "and it arrives")

  // A fresh ship is whole at once: there is nothing to explain about being repaired.
  game.player.hull = PLAYER_TYPE.hull
  game.advance(1 / 60)
  assert.equal(game.player.hullShown, PLAYER_TYPE.hull)
})

test("a piece hit harder than it holds together comes apart, and otherwise is shoved", () => {
  // One rule, priced in closing speed, so nothing here knows what wreckage is: a hull
  // fragment still carrying its ship's momentum bursts on the first thing it meets, the
  // same fragment slowed to a drift is shouldered aside, and rock takes far more.
  const thrown = (speed, material) => {
    const game = liveGame()
    game.player.x = -9000
    game.player.y = -9000
    const piece = new Asteroid({
      vertices: square(300, 320, 30),
      vx: speed,
      vy: 0,
      spin: 0,
      material,
    })
    const rock = new Asteroid({ vertices: square(500, 320, 60), vx: 0, vy: 0, spin: 0 })
    game.asteroids = [piece, rock]
    const ore = game.oreChunks.length
    const particles = game.particles.length
    for (let i = 0; i < 180 && !piece.dead && !rock.dead; i++) {
      game.advance(1 / 60)
    }
    return {
      burst: piece.dead,
      rockBurst: rock.dead,
      ore: game.oreChunks.length - ore,
      made: game.particles.length - particles,
    }
  }

  const fast = thrown(SHIP_PLATING.shatterAt + 40, SHIP_PLATING)
  assert.ok(fast.burst, "plating thrown faster than it holds bursts")
  assert.ok(fast.ore > 0, "leaving ore where it struck")
  assert.ok(!fast.rockBurst, "and the rock it struck is untouched, being far tougher")
  // And it looks like something breaking up rather than a handful of ore appearing: how
  // much comes off follows how big the piece was and how hard it was hit.
  assert.ok(fast.made > 30, `a break-up should throw a shower, threw ${fast.made}`)
  const harder = thrown(SHIP_PLATING.shatterAt + 170, SHIP_PLATING)
  assert.ok(harder.made > fast.made, "a harder hit throws more")

  const slow = thrown(SHIP_PLATING.shatterAt - 40, SHIP_PLATING)
  assert.ok(!slow.burst, "the same piece drifting is shoved aside instead")

  // Rock holds together through anything a hull can do to it short of a full-tilt ram.
  assert.ok(
    CONFIG.ROCK_SHATTER_SPEED > Math.max(...Object.values(SHIP_TYPES).map((t) => t.maxSpeed)),
    "no rival can drive a rock hard enough to break it",
  )
  assert.ok(!thrown(CONFIG.ROCK_SHATTER_SPEED - 50, null).burst, "so an ordinary field holds")
  assert.ok(thrown(CONFIG.ROCK_SHATTER_SPEED + 40, null).burst, "and a hard enough hit does not")
})

test("a rock costs a rival hull, as it costs the player energy", () => {
  for (const typeName of Object.keys(SHIP_TYPES)) {
    assert.ok(ramARock(typeName) > 0, `a ${typeName} driving into a rock must be worn down by it`)
  }
})

test("what rock contact costs a hull is the type's business, not the code's", () => {
  // Same contact, same code path: only the registry entry differs. Stated and re-derived
  // rather than poked onto the type afterwards, because a ship prices rock contact off
  // its own hull and speed when it is fitted out, and a value written down has to be
  // remembered as written down to survive that.
  const cost = (scale) => {
    const original = SHIP_TYPES.scout
    SHIP_TYPES.scout = deriveShipStats({ ...original, rockContact: scale })
    try {
      return ramARock("scout")
    } finally {
      SHIP_TYPES.scout = original
    }
  }
  assert.equal(cost(0), 0, "a type that declares no susceptibility takes nothing")
  assert.ok(cost(0.2) > 0, "and one that does is worn down")
  assert.ok(cost(0.1) < cost(0.2), "proportionally to what it declares")
})

// ---- the shop sells the loadout --------------------------------------------

test("a run starts with no shield, and the first mark of plating fits one", () => {
  const game = liveGame()
  assert.deepEqual(game.upgrades.owned.shield, [], "nothing is issued with the ship")
  assert.equal(game.fittedEquipment("shield"), null)
  assert.equal(game.player.shieldModule(), null, "and there is no bubble to hide behind")

  game.oreBalance = 999
  game.enterShop()
  game.shopSelection = equipmentRowIndex(game, "shield")
  game.doShopAction() // opens on the marks
  game.menuConfirm() // buys the first
  assert.equal(game.fittedEquipment("shield"), optionAt("shield", 0))
  const shield = game.player.shieldModule()
  assert.ok(shield && shield.up, "the first mark mounts a bubble, raised")

  // and the marks above it are what the levels were: a cheaper hit
  const drain = (mark) => {
    const g = withShield(liveGame(), mark)
    g.player.takeDamage(100, g, "projectile", 0, { x: g.player.x + 5, y: g.player.y })
    return g.player.energyMax - g.player.energy
  }
  assert.ok(
    drain(optionAt("shield", -1)) < drain(optionAt("shield", 0)),
    "the top mark drains less than the first",
  )
})

test("a resumed run re-mounts the shield it had bought", () => {
  const game = liveGame()
  withShield(game, optionAt("shield", 1))
  game.level = 4
  game.enterShop()
  const resumed = new Game()
  resumed.savedRun = game.savedRun
  resumed.resumeRun()
  assert.ok(resumed.player.shieldModule(), "the bubble comes back with the run")
})

// Every levelled upgrade indexes one or more tables by the same level, so a table
// left one entry short is a level the shop can reach and the game cannot answer.
test("every level the shop offers is one every table it indexes can answer", () => {
  // Only what is still levelled. The laser and the shield are slots of marks now,
  // each stating its own gun or bubble, so there is no table left to run short.
  const tables = {
    core: [CORE_TYPES.minerCore.levels],
  }
  for (const [id, indexed] of Object.entries(tables)) {
    const item = SHOP.find((entry) => entry.id === id)
    assert.ok(item, `${id} should be on sale`)
    assert.ok(item.max >= 1, `${id} should offer levels to buy`)
    // How many an upgrade offers is its own business; that every table it indexes
    // can answer the top one is not.
    for (const table of indexed) {
      assert.equal(table.length, item.max + 1, `a ${id} table is short of level ${item.max}`)
    }
  }
})

// ---- what a laser mark buys ------------------------------------------------

test("a laser mark that pays for damage lands more of it", () => {
  // Measured on a raised shield, which drains by the damage landed. An unshielded
  // hull is cut through at either level, so it reports the same either way.
  const damageAt = (id) => {
    const game = liveGame()
    withLaser(game, id)
    const player = game.player
    player.x = 100
    player.y = 320
    player.angle = 0
    const frigate = new RivalShip(500, 320, "frigate", [{ hp: 1, shield: "standard" }])
    game.rivals = [frigate]
    const before = frigate.energy
    fullChargeShot(game)
    return before - frigate.energy
  }
  const options = EQUIPMENT.laser.options
  const base = WEAPON_TYPES[options[0].id].damage
  const at = options.findIndex((option) => WEAPON_TYPES[option.id].damage > base)
  assert.ok(at > 0, "some mark should pay for damage")
  assert.ok(
    damageAt(options[at].id) > damageAt(options[at - 1].id),
    "and land more than the mark below it",
  )
})

test("overdrive shatters a rock, but only wound up and only where it is sold", () => {
  const fire = (mark, overdrive) => {
    const game = liveGame()
    withLaser(game, mark)
    const player = game.player
    player.x = 300
    player.y = 320
    player.angle = 0
    const rocks = [
      new Asteroid({ vertices: square(600, 320, 60) }),
      new Asteroid({ vertices: square(800, 320, 60) }),
    ]
    game.asteroids = [...rocks]
    fullChargeShot(game, 1, overdrive)
    return {
      shattered: rocks.every((rock) => !game.asteroids.includes(rock)) && game.oreChunks.length > 0,
      shots: game.laserShots,
    }
  }
  const marks = laserMarkThat("canOverdrive")
  assert.equal(
    fire(marks.with, 1).shattered,
    true,
    "a wound-up shot shatters every rock it reaches",
  )
  assert.equal(fire(marks.with, 0.9).shattered, false, "short of wound up it does not")
  assert.equal(fire(marks.without, 1).shattered, false, "and neither does the mark below")
  // the guarantee is visible: the beam is drawn in its own colour
  assert.equal(fire(marks.with, 1).shots[0].color, PALETTE.player.overdrive)
  assert.equal(fire(marks.with, 0.9).shots[0].color, WEAPON_TYPES.playerLaserMk1.colour)

  // and the effect beam is one shot the length of the beam, not one per rock
  const effects = fire(marks.with, 1).shots.filter((s) => s.color === PALETTE.ore.shatterBeam)
  assert.equal(effects.length, 1, "two rocks shattered, one effect beam")
  const [drawn] = effects[0].beams
  const fired = fire(marks.with, 1).shots[0].beams[0]
  assert.equal(drawn.b.x, fired.b.x, "and it runs the whole length of the shot")
  assert.equal(drawn.b.y, fired.b.y)
})

test("overdrive winds up past full charge, on time and energy it draws for itself", () => {
  const game = liveGame()
  withLaser(game, laserMarkThat("canOverdrive").with)
  const player = game.player,
    weapon = player.mainWeapon
  game.holding = (name) => name === "fire"

  // the ordinary charge first, which reaches its own ceiling and stops
  for (let frame = 0; frame < 300 && weapon.charge < weapon.type.chargeMax; frame++) {
    player.energy = player.energyMax
    player.update(1 / 60, game)
  }
  assert.equal(weapon.charge, weapon.type.chargeMax, "the charge fills")
  assert.equal(player.overdriveWind, 0, "and no overdrive is wound onto it yet")

  // then the wind-up, at its own rate and its own price
  player.energy = player.energyMax
  const before = player.energy
  let held = 0
  while (!player.overdriven && held < 10) {
    player.update(1 / 60, game)
    held += 1 / 60
  }
  assert.ok(player.overdriven, "holding on reaches overdrive")
  assert.ok(
    Math.abs(held - CONFIG.LASER_OVERDRIVE_TIME) < 0.05,
    `it should take ${CONFIG.LASER_OVERDRIVE_TIME}s, took ${held.toFixed(2)}s`,
  )
  const drawn = before - player.energy
  const expected = CONFIG.LASER_OVERDRIVE_TIME * CONFIG.LASER_OVERDRIVE_COST
  assert.ok(Math.abs(drawn - expected) < 15, `it should draw ${expected}, drew ${drawn.toFixed(1)}`)

  // and letting go drops the whole shot, wind-up and all
  game.holding = () => false
  player.update(1 / 60, game)
  assert.equal(weapon.charge, 0)
  assert.equal(weapon.overdrive, 0)
})

test("a mark without overdrive never winds one up, however long it is held", () => {
  const game = liveGame()
  withLaser(game, laserMarkThat("canOverdrive").without)
  const player = game.player
  game.holding = (name) => name === "fire"
  for (let frame = 0; frame < 400; frame++) {
    player.energy = player.energyMax
    player.update(1 / 60, game)
  }
  assert.equal(player.overdriveWind, 0)
  assert.equal(player.overdriven, false)
})

// ---- what the shop does with a special -------------------------------------

test("every special has a price, and fetches less than it than when sold", () => {
  const game = liveGame()
  for (const [id, type] of Object.entries(SPECIAL_TYPES)) {
    assert.equal(typeof type.cost, "number", `${id} needs a price`)
    assert.ok(type.cost > 0, `${id} should cost something`)
    const sell = game.specialSellValue(id)
    assert.ok(sell > 0, `${id} should be worth something traded in`)
    assert.ok(sell < type.cost, `${id} must not be worth more sold than bought`)
  }
})

test("carried specials survive the trip to the next sector, and a saved run", () => {
  const game = liveGame()
  withSlots(game, 2)
  equip(game, 0, "repel")
  equip(game, 1, "booster")
  game.level = 4
  game.enterShop()
  assert.deepEqual(carried(game), ["repel", "booster"], "the shop does not empty the slots")
  game.shopSelection = game.launchRow
  game.doShopAction()
  assert.equal(game.level, 5)
  assert.deepEqual(carried(game), ["repel", "booster"], "and neither does the next sector")

  const resumed = new Game()
  resumed.savedRun = game.savedRun
  resumed.resumeRun()
  assert.deepEqual(carried(resumed), ["repel", "booster"], "nor a session boundary")
})

test("a saved run drops a special the registry no longer knows", () => {
  const game = liveGame()
  equip(game, 0, "repel")
  game.level = 2
  game.enterShop()
  game.savedRun.items = ["repel", "somethingRemoved"]
  const resumed = new Game()
  resumed.savedRun = game.savedRun
  resumed.resumeRun()
  assert.deepEqual(carried(resumed), ["repel"])
})

test("launch sits above options, both starting where the item names do", () => {
  const game = liveGame()
  game.enterShop()
  const drawn = []
  const renderer = new Proxy(
    {
      text: (text, x, y, opts) =>
        drawn.push({ text: String(text).trim(), x, y, size: opts && opts.size }),
    },
    { get: (target, key) => (key in target ? target[key] : () => {}) },
  )
  new GameView(renderer).render(game)
  const find = (match) => drawn.find((row) => match.test(row.text))
  const launch = find(/^LAUNCH TO SECTOR/)
  const options = find(/^OPTIONS$/)
  const hint = drawn.find((row) => row.text === "One more spare ship.")
  assert.ok(launch && options && hint, "all three are drawn")
  assert.ok(launch.y < options.y, "launch is the line above")
  // Left-aligned together, and to the same pixel: they are set at different sizes, and a
  // leading space is proportional to its size, so a placeholder inside the label put the
  // smaller of them a couple of pixels to the left of the larger.
  assert.equal(options.x, launch.x, "and starts in the same column")
  const names = drawn.filter((row) => row.size === 17 && /^(TURRET|ENGINE)$/.test(row.text))
  assert.ok(names.length, "the item rows are drawn")
  assert.ok(
    Math.abs(names[0].x + 17 * 0.45 * 2 - launch.x) < 0.01,
    "which is where the item names begin, once their own placeholder is counted",
  )
  assert.ok(launch.y - hint.y > 40, "and clear of the hint above them")
})

test("the shop calls the spare ships LIVES", () => {
  const game = liveGame()
  game.enterShop()
  assert.equal(game.shopItem(0).name, "LIVES")
})

test("a dev build offers its tools first, and a testing arena opens on them", () => {
  const game = liveGame()
  game.toggleOptions()
  assert.equal(game.pauseMenu()[0].name, "DEV TOOLS", "first of the rows on a dev build")
  // And the way back out of the dev page is the options page, since in an arena there is
  // nothing behind it to go back to.
  game.openPausePage("dev")
  const out = game.pauseMenu().at(-1)
  assert.equal(out.name, "OPTIONS")
  out.action(game)
  assert.equal(game.pausePage, "root")

  // In a testing arena, ESCAPE opens the dev page rather than the options.
  game.openPausePage("dev")
  game
    .pauseMenu()
    .find((row) => row.name === "TESTING ARENA")
    .action(game)
  assert.equal(game.sandbox, true)
  game.toggleOptions()
  assert.equal(game.paused, true)
  assert.equal(game.pausePage, "dev", "which is the only reason to be in one")
})

test("the specials row is titled like the rows it sits among", () => {
  // It is a row of that list and has to read as one: it was drawn two points smaller than
  // its neighbours and never took the colour they take when there is nothing left to buy,
  // so a fully upgraded shop had one white line in a column of green ones.
  const titles = (game) => {
    const found = []
    const renderer = new Proxy(
      {
        text: (text, x, y, opts) =>
          found.push({
            text: String(text).trim(),
            x: Math.round(x),
            size: opts && opts.size,
            colour: opts && opts.color,
          }),
      },
      { get: (target, key) => (key in target ? target[key] : () => {}) },
    )
    new GameView(renderer).render(game)
    return found
  }
  const rowFor = (game, name) => titles(game).find((row) => row.text === name)

  const fresh = liveGame()
  fresh.enterShop()
  const laser = rowFor(fresh, "LASER")
  const specials = rowFor(fresh, "SPECIALS")
  assert.ok(laser && specials, "both rows are drawn")
  assert.equal(specials.size, laser.size, "the same size as a purchase row")
  assert.equal(specials.colour, laser.colour, "and the same colour")
  const radar = rowFor(fresh, "RADAR")
  assert.equal(specials.x, radar.x, "inset with the rest of what the core carries")

  // And it goes green with them once the core gives every slot there is.
  const full = liveGame()
  withSlots(full, MAX_SLOTS)
  full.enterShop()
  assert.equal(rowFor(full, "SPECIALS").colour, PALETTE.ui.good, "nothing left to unlock")
})

test("the shop sits what the core carries under it, and the loadout below", () => {
  const game = liveGame()
  game.enterShop()
  assert.equal(SHOP[0].id, "life", "a spare ship heads the page")

  // The page reads as three groups: the spare ship, then the core and everything it
  // carries, then what is bolted to the hull outside it.
  const order = []
  for (let row = 0; row <= SHOP.length; row++) {
    const item = game.shopItem(row)
    order.push(item ? item.id : "specials")
  }
  assert.deepEqual(order, [
    "life",
    "core",
    "shield",
    "radar",
    "thruster",
    "specials",
    "laser",
    "turret",
    "engine",
  ])

  // and what the core carries is inset, which is how the page says so
  const inset = order.filter((id) => {
    const item = SHOP.find((entry) => entry.id === id)
    return id === "specials" || (item && item.inset)
  })
  assert.deepEqual(inset, ["shield", "radar", "thruster", "specials"])
  // every purchase is still reachable, exactly once, in registry order
  assert.deepEqual(
    order.filter((id) => id !== "specials"),
    SHOP.map((item) => item.id),
  )
  assert.equal(game.launchRow, SHOP.length + 1)
  assert.equal(game.optionsRow, SHOP.length + 2)
  assert.equal(game.menuRows(), SHOP.length + 3, "the cursor can reach all of them")
})

test("the cursor walks every slot box, fitted or not, and stops at either end", () => {
  const game = liveGame()
  withSlots(game, 3)
  game.enterShop()
  game.shopSelection = game.slotsRow
  assert.equal(game.shopSlot, 0)
  assert.equal(game.menuAdjust(-1), true, "left is taken by the row, not passed on")
  assert.equal(game.shopSlot, 0, "and stops at the first")
  for (let step = 0; step < MAX_SLOTS + 2; step++) {
    game.menuAdjust(1)
  }
  // an unfitted slot is where the next one is bought, so the cursor must reach it
  assert.equal(game.shopSlot, MAX_SLOTS - 1, "the last box is the last it reaches")
  // and the launch line still moves the way it always did
  game.shopSelection = game.optionsRow
  game.menuAdjust(1)
  assert.equal(game.shopSelection, game.launchRow)
})

test("the pop-over opens on a slot with something in it, and not on an empty one", () => {
  const game = clearSlots(liveGame())
  withSlots(game, 2)
  equip(game, 0, "booster")
  game.enterShop()
  game.shopSelection = game.slotsRow

  game.shopSlot = 1 // empty
  game.menuConfirm()
  assert.equal(game.slotMenu, null, "an empty slot has nothing to offer yet")

  game.shopSlot = 0
  game.menuConfirm()
  assert.deepEqual(game.slotMenu, { slot: 0, selection: 0 })
  assert.deepEqual(
    game.slotMenuRows(0).map((row) => row.name),
    ["SELL"],
  )
})

test("the pop-over takes the input the shop behind it would have taken", () => {
  const game = liveGame()
  equip(game, 0, "booster")
  game.enterShop()
  game.shopSelection = game.slotsRow
  game.menuConfirm()
  const row = game.shopSelection
  game.menuMove(1)
  assert.equal(game.shopSelection, row, "the shop's cursor stays where it was")
  assert.equal(game.menuAdjust(1), true, "and sideways presses are swallowed too")
  assert.equal(game.shopSlot, 0)
  game.menuBack()
  assert.equal(game.slotMenu, null, "back closes it")
  game.menuConfirm()
  game.escape()
  assert.equal(game.slotMenu, null, "and so does escape")
})

test("a purchase lands the cursor on the next thing worth buying", () => {
  // So a ladder is climbed with repeated presses of the same key instead of walking
  // the cursor back down to the next mark after every purchase.
  const game = liveGame()
  game.oreBalance = 9000
  game.enterShop()
  game.shopSelection = equipmentRowIndex(game, "laser")
  game.menuConfirm() // opens the laser's marks
  const marks = EQUIPMENT.laser.options
  assert.equal(game.slotMenu.selection, 1, "the pop-over opens on the first mark worth buying")

  for (let mark = 1; mark < marks.length - 1; mark++) {
    game.menuConfirm()
    assert.ok(game.ownsEquipment("laser", marks[mark].id), `mark ${mark + 1} was bought`)
    assert.equal(
      game.slotMenu.selection,
      mark + 1,
      `after buying mark ${mark + 1} the cursor should sit on the one above it`,
    )
  }
  // The top of the ladder: nothing left to spend on, so the cursor stays put.
  game.menuConfirm()
  assert.equal(game.slotMenu.selection, marks.length - 1)
  assert.ok(game.ownsEquipment("laser", marks[marks.length - 1].id), "every mark is owned")
})

test("a purchase that cannot be afforded leaves the cursor on it", () => {
  const game = liveGame()
  game.oreBalance = 0
  game.enterShop()
  game.shopSelection = equipmentRowIndex(game, "shield")
  game.menuConfirm()
  const before = game.slotMenu.selection
  game.menuConfirm()
  assert.equal(game.slotMenu.selection, before, "nothing was bought, so nothing moves")
  assert.equal(game.fittedEquipment("shield"), null, "and no shield was fitted")
})

test("selling a slot pays what the special is worth and empties that slot", () => {
  const game = liveGame()
  withSlots(game, 3)
  equip(game, 0, "repel")
  equip(game, 1, "booster")
  equip(game, 2, "oreMagnet")
  game.level = 3
  game.enterShop()
  const ore = game.oreBalance
  game.shopSelection = game.slotsRow
  game.shopSlot = 1
  game.menuConfirm()
  game.menuConfirm() // SELL
  assert.equal(game.oreBalance, ore + game.specialSellValue("booster"))
  // a slot's index is its identity, so the ones beside it stay where they are
  assert.deepEqual(carried(game), ["repel", null, "oreMagnet"])
  assert.equal(game.slotMenu, null, "and the pop-over goes with it")
  assert.deepEqual(game.savedRun.items.slice(0, 3), ["repel", null, "oreMagnet"])
})

// ---- a special is equipment, not ammunition --------------------------------

test("using a special keeps it, spends energy and puts the slot on cooldown", () => {
  const game = liveGame()
  const player = game.player
  const item = equip(game, 0, "repel")
  const type = SPECIAL_TYPES.repel
  player.energy = player.energyMax

  const cost = type.energy * player.energyMax
  game.useSpecialSlot(0)
  assert.equal(player.items[0], item, "the special stays in its slot")
  assert.equal(player.energy, player.energyMax - cost, "and the cell paid for it")
  assert.equal(item.cooldown, type.cooldown)

  // and it cannot be used again until the cooldown has run out
  const spent = player.energy
  game.useSpecialSlot(0)
  assert.equal(player.energy, spent, "a slot on cooldown does nothing")
  for (let frame = 0; frame < Math.ceil(type.cooldown * 60) + 1; frame++) {
    player.update(1 / 60, game)
  }
  assert.equal(item.cooldown, 0, "the cooldown runs down")
  player.energy = player.energyMax
  game.useSpecialSlot(0)
  assert.ok(player.energy < player.energyMax, "and it works again")
})

test("a single-use special is spent, leaving the slot empty", () => {
  const game = liveGame()
  const player = game.player
  const single = SPECIAL_IDS.find((id) => SPECIAL_TYPES[id].mode === "single")
  assert.ok(single, "some special should be spent on use")
  equip(game, 0, single)
  player.energy = player.energyMax * 0.2
  game.useSpecialSlot(0)
  assert.ok(player.energy > player.energyMax * 0.2, "it did what it does")
  assert.equal(player.items[0], null, "and the slot is empty again")
})

test("a special the cell cannot pay for does not go off", () => {
  const game = liveGame()
  const player = game.player
  const item = equip(game, 0, "repel")
  const short = SPECIAL_TYPES.repel.energy * player.energyMax - 1
  player.energy = short
  game.useSpecialSlot(0)
  assert.equal(item.cooldown, 0, "nothing was used")
  assert.equal(player.energy, short, "and nothing was spent")
})

test("a timed special starts its cooldown when the effect ends, not when it starts", () => {
  const game = liveGame()
  const player = game.player
  const type = SPECIAL_TYPES.booster
  const item = equip(game, 0, "booster")
  player.energy = player.energyMax
  game.useSpecialSlot(0)
  assert.ok(player.buffTime("booster") > 0, "the effect is running")
  assert.equal(item.cooldown, 0, "and the slot is not counting down yet")

  for (let frame = 0; frame < Math.ceil(type.seconds * 60) + 1; frame++) {
    player.update(1 / 60, game)
  }
  assert.equal(player.buffTime("booster"), 0, "the effect ran out")
  assert.ok(item.cooldown > type.cooldown - 0.1, "and the cooldown started then")
})

test("repel reaches what is around the ship and nothing across the sector", () => {
  const game = liveGame()
  const player = game.player
  player.x = 400
  player.y = 320
  player.energy = player.energyMax
  const type = SPECIAL_TYPES.repel
  const near = new Asteroid({ vertices: square(400 + type.range / 2, 320, 30), vx: 0, vy: 0 })
  const far = new Asteroid({ vertices: square(400 + type.range * 3, 320, 30), vx: 0, vy: 0 })
  game.asteroids = [near, far]
  equip(game, 0, "repel")
  game.useSpecialSlot(0)
  assert.ok(near.vx > 0, "a rock in the neighbourhood is shoved clear")
  assert.equal(far.vx, 0, "one across the sector is not")
})

// ---- throwing a special overboard ------------------------------------------

test("holding a slot button throws the special out, and the release does not use it", () => {
  const game = liveGame()
  const player = game.player
  player.energy = player.energyMax
  equip(game, 0, "repel")

  game.slotDownAt(0)
  game.update(CONFIG.SPECIAL_JETTISON_HOLD / 2)
  assert.ok(player.items[0], "a short hold has not thrown it yet")
  game.update(CONFIG.SPECIAL_JETTISON_HOLD)
  assert.equal(player.items[0], null, "holding on throws it overboard")
  assert.equal(game.specialPickups.length, 1, "and it is out there to be picked up again")

  const pickup = game.specialPickups[0]
  assert.equal(pickup.type, "repel")
  assert.ok(Math.hypot(pickup.vx, pickup.vy) > 0, "flung clear rather than dropped")
  assert.ok(pickup.arming > 0, "and not collectable the instant it leaves")

  // the release that ends the hold must not then use the slot it emptied
  game.slotUpAt(0)
  assert.equal(player.energy, player.energyMax, "nothing was spent on the way out")
})

test("a jettisoned special is passed over until it has armed, then picked up again", () => {
  const game = liveGame()
  const player = game.player
  player.energy = player.energyMax
  equip(game, 0, "repel")
  game.slotDownAt(0)
  game.update(CONFIG.SPECIAL_JETTISON_HOLD + 0.01)
  game.slotUpAt(0)
  const pickup = game.specialPickups[0]

  // parked on top of the ship, it is still passed over while it arms
  pickup.vx = 0
  pickup.vy = 0
  for (let frame = 0; frame < 20; frame++) {
    pickup.x = player.x
    pickup.y = player.y
    player.update(1 / 60, game)
    pickup.update(1 / 60, game)
  }
  assert.equal(player.items[0], null, "it cannot be taken straight back")

  for (let frame = 0; frame < Math.ceil(CONFIG.SPECIAL_ARM_TIME * 60) + 20; frame++) {
    pickup.x = player.x
    pickup.y = player.y
    pickup.update(1 / 60, game)
    player.update(1 / 60, game)
  }
  assert.equal(carried(game)[0], "repel", "once armed it goes back in the slot")
})

test("throwing a special out takes its effect with it", () => {
  const game = liveGame()
  const player = game.player
  player.energy = player.energyMax
  equip(game, 0, "stealth")
  game.useSpecialSlot(0)
  assert.equal(game.visiblePlayer(), null, "hidden while it runs")
  game.slotDownAt(0)
  game.update(CONFIG.SPECIAL_JETTISON_HOLD + 0.01)
  assert.equal(player.items[0], null)
  assert.equal(game.visiblePlayer(), player, "and visible again once it is gone")
})

// ---- buying a special the run has found ------------------------------------

test("the shop sells only what the run has found, and dev mode sells everything", () => {
  const game = liveGame()
  // The magnet the hull came with counts as met, so it can be bought back.
  assert.deepEqual(game.buyableSpecials(), ["oreMagnet"], "a fresh run has met its own kit")
  game.findSpecial("repel")
  assert.deepEqual(game.buyableSpecials().sort(), ["oreMagnet", "repel"])
  game.devMode = true
  assert.deepEqual(game.buyableSpecials(), SPECIAL_IDS, "dev mode stocks the lot")
})

test("picking a special up is what puts it on the shop's shelf", () => {
  const game = clearSlots(liveGame())
  const player = game.player
  const pickup = new Special(player.x, player.y, 0, 0, "oreMagnet")
  game.specialPickups = [pickup]
  player.update(1 / 60, game)
  assert.equal(carried(game)[0], "oreMagnet", "collected into the free slot")
  assert.ok(game.seenSpecials.has("oreMagnet"), "and remembered as found")
})

test("an empty slot offers what is in stock, and buying one fills that slot", () => {
  const game = clearSlots(liveGame())
  withSlots(game, 2)
  game.findSpecial("oreMagnet")
  game.findSpecial("repel")
  game.oreBalance = 1000
  game.enterShop()
  game.shopSelection = game.slotsRow
  game.shopSlot = 1
  game.menuConfirm()
  assert.ok(game.slotMenu, "an empty slot opens once there is something to offer")
  assert.deepEqual(
    game.slotMenuRows(1).map((row) => row.name),
    [SPECIAL_TYPES.repel.label, SPECIAL_TYPES.oreMagnet.label],
    "one row per special found, in registry order",
  )
  const before = game.oreBalance
  game.slotMenu.selection = 1 // MAGNET
  game.menuConfirm()
  assert.equal(carried(game)[1], "oreMagnet", "it goes into the slot it was bought for")
  assert.equal(carried(game)[0], null, "and no other")
  assert.equal(game.oreBalance, before - SPECIAL_TYPES.oreMagnet.cost)
  assert.equal(game.slotMenu, null, "the pop-over closes behind it")
  assert.deepEqual(game.savedRun.items[1], "oreMagnet", "and the purchase is banked")
})

test("a slot comes with the power core, along with the cell to run it", () => {
  // Slots used to be bought one at a time, separately from the cell, so a ship
  // could carry four specials it had no energy to run. One purchase now.
  const game = liveGame()
  const core = CORE_TYPES.minerCore.levels
  assert.equal(game.specialSlots(), core[0].special, "a fresh hull has what level 0 gives")
  assert.equal(game.maxEnergy(), core[0].energy)

  game.oreBalance = 1000
  const ore = game.oreBalance
  const cost = SHOP.find((entry) => entry.id === "core").cost(game)
  buyNextLevel(game, "core")

  assert.equal(game.upgrades.core, 1)
  assert.equal(game.specialSlots(), core[1].special, "another slot")
  assert.equal(game.maxEnergy(), core[1].energy, "and the cell to spend through it")
  assert.equal(game.player.energyMax, core[1].energy, "the fitted hull knows about it")
  assert.equal(game.oreBalance, ore - cost)
  // Every level earns both, so none of them is energy on its own: that was the
  // shape where the last purchase bought a cell with nowhere to spend it.
  for (let i = 1; i < core.length; i++) {
    assert.ok(core[i].energy > core[i - 1].energy, `level ${i} must hold more`)
    assert.ok(core[i].special > core[i - 1].special, `level ${i} must earn a slot`)
  }
  assert.equal(core[core.length - 1].special, MAX_SLOTS, "the last level fills the ship")
})

test("a slot the core does not provide is inert, and the next level opens it", () => {
  const game = clearSlots(liveGame())
  game.findSpecial("oreMagnet")
  game.oreBalance = 1000
  const beyond = game.specialSlots() // the first slot the core does not reach
  game.enterShop()
  game.shopSelection = game.slotsRow
  game.shopSlot = beyond
  game.menuConfirm()
  assert.equal(game.slotMenu, null, "nothing to offer for a slot the ship has not got")

  // buying the core reaches it, and then it stocks like any other
  buyNextLevel(game, "core")
  assert.ok(game.specialSlots() > beyond, "the level pays for that slot")
  game.menuConfirm()
  assert.ok(game.slotMenu, "so the pop-over opens on it")
  assert.deepEqual(
    game.slotMenuRows(beyond).map((row) => row.name),
    [SPECIAL_TYPES.oreMagnet.label],
  )
  game.menuConfirm()
  assert.equal(carried(game)[beyond], "oreMagnet")
})

test("slots are no longer sold as a row of their own", () => {
  assert.equal(
    SHOP.find((item) => item.id === "slot"),
    undefined,
    "the specials row is where a slot is bought",
  )
})

test("a special that cannot be afforded is not bought", () => {
  const game = clearSlots(liveGame())
  game.findSpecial("oreMagnet")
  game.enterShop()
  game.oreBalance = SPECIAL_TYPES.oreMagnet.cost - 1
  game.buySpecial(0, "oreMagnet")
  assert.equal(carried(game)[0], null)
  assert.equal(game.oreBalance, SPECIAL_TYPES.oreMagnet.cost - 1)
})

test("a slot with nothing in it and nothing to offer does not open", () => {
  const game = clearSlots(liveGame())
  game.enterShop()
  game.shopSelection = game.slotsRow
  game.menuConfirm()
  assert.equal(game.slotMenu, null)
})

// ---- stealth ---------------------------------------------------------------

test("stealth toggles, drains the cell while it runs, and drops when it is empty", () => {
  const game = liveGame()
  const player = game.player
  const type = SPECIAL_TYPES.stealth
  const item = equip(game, 0, "stealth")
  player.energy = player.energyMax

  game.useSpecialSlot(0)
  assert.equal(item.active, true)
  // Costs are a fraction of the cell, so a bigger core buys no more stealth; what
  // the ship actually loses is that draw less what it regenerates meanwhile.
  const net = type.drain * player.energyMax - game.playerCore().regen
  assert.ok(net > 0, "stealth must out-draw the cell's own regen")
  const before = player.energy
  for (let frame = 0; frame < 60; frame++) {
    player.update(1 / 60, game)
  }
  assert.ok(
    Math.abs(before - player.energy - net) < net * 0.25,
    `a second of stealth should cost about ${net.toFixed(0)}`,
  )

  // pressing again switches it off, onto its cooldown
  game.useSpecialSlot(0)
  assert.equal(item.active, false)
  assert.ok(item.cooldown > 0)

  // and running the cell dry switches it off rather than stranding the ship
  item.cooldown = 0
  player.energy = type.drain * player.energyMax * 0.2
  game.useSpecialSlot(0)
  for (let frame = 0; frame < 60; frame++) {
    player.update(1 / 60, game)
  }
  assert.equal(item.active, false, "it gives up when there is nothing left to draw on")
})

test("switching one special off leaves the others running", () => {
  const game = liveGame()
  const player = game.player
  withSlots(game, 2)
  player.energy = player.energyMax
  equip(game, 0, "stealth")
  equip(game, 1, "booster")
  game.useSpecialSlot(0)
  game.useSpecialSlot(1)
  assert.equal(player.items[0].active, true)
  assert.ok(player.buffTime("booster") > 0)

  game.useSpecialSlot(0) // switch stealth back off
  assert.equal(player.items[0].active, false)
  assert.ok(player.buffTime("booster") > 0, "the booster is still running")
})

test("nothing hunting the player can see a stealthed ship", () => {
  const game = liveGame()
  const player = game.player
  player.energy = player.energyMax
  equip(game, 0, "stealth")
  assert.equal(game.visiblePlayer(), player)
  game.useSpecialSlot(0)
  assert.equal(game.visiblePlayer(), null, "the player is hidden")

  // a rock turret holds fire at a ship it cannot see
  const shots = (hidden) => {
    const sector = liveGame()
    sector.player.x = 400
    sector.player.y = 460
    if (hidden) {
      sector.player.energy = sector.player.energyMax
      equip(sector, 0, "stealth")
      sector.useSpecialSlot(0)
    }
    const rock = new Asteroid({
      vertices: square(400, 320, 60),
      traits: { gun: { weapon: "blaster", controller: "turret", count: [1, 1] } },
    })
    rock.hardpoints.push({
      x: rock.center.x,
      y: rock.center.y,
      module: new Weapon("blaster", "turret"),
    })
    rock.refreshEnergy()
    sector.asteroids = [rock, new Asteroid({ vertices: square(400, -900, 60) })]
    let fired = 0
    for (let frame = 0; frame < 400; frame++) {
      sector.player.energy = sector.player.energyMax // kept flying, and kept hidden
      const before = sector.projectiles.length
      sector.advance(1 / 60)
      fired += Math.max(0, sector.projectiles.length - before)
    }
    return fired
  }
  assert.ok(shots(false) > 0, "a turret shoots at a ship it can see")
  assert.equal(shots(true), 0, "and holds fire at one it cannot")
})

test("a hunting rival comes for a ship it can see, and not for one it cannot", () => {
  // The player is parked out near the wall with the rival between it and the centre, so
  // closing on the player means turning outward.
  //
  // Measured as how close it ever came rather than where it ended up: a dart that breaks
  // off makes a pass and leaves, so the distance at the end of a run says nothing about
  // whether it came at all. And a rival that cannot see the player searches, and a search
  // wanders toward it as readily as away, so both cases are means over the same seeds.
  const approach = (hidden) => {
    const game = liveGame()
    const player = game.player
    player.x = ARENA.cx + 780
    player.y = ARENA.cy
    player.energy = player.energyMax
    if (hidden) {
      equip(game, 0, "stealth")
      game.useSpecialSlot(0)
    }
    const hunter = Object.keys(SHIP_TYPES).find((name) => SHIP_TYPES[name].hunts)
    assert.ok(hunter, "some ship should hunt the player")
    const rival = plainRival(ARENA.cx + 400, ARENA.cy, hunter)
    rival.angle = Math.PI // pointing at the centre, away from the player
    game.rivals = [rival]
    const before = Math.hypot(rival.x - player.x, rival.y - player.y)
    let nearest = before
    for (let frame = 0; frame < 240; frame++) {
      player.energy = player.energyMax
      rival.update(1 / 60, game)
      nearest = Math.min(nearest, Math.hypot(rival.x - player.x, rival.y - player.y))
    }
    return before - nearest
  }
  const seeds = [13, 29, 47, 61, 79, 97, 113, 131]
  const seen = seeds.map((seed) => seeded(seed, () => approach(false)))
  const blind = seeds.map((seed) => seeded(seed, () => approach(true)))
  const mean = (runs) => runs.reduce((sum, run) => sum + run, 0) / runs.length
  assert.ok(
    Math.min(...seen) > 90,
    `seeing it, every run should come for it: ${seen.map((r) => r.toFixed(0)).join(", ")}`,
  )
  assert.ok(
    mean(blind) < mean(seen) * 0.65,
    `blind ${mean(blind).toFixed(0)} against seeing ${mean(seen).toFixed(0)}`,
  )
})

test("firing the main laser gives a stealthed ship away", () => {
  const game = liveGame()
  const player = game.player
  player.energy = player.energyMax
  const item = equip(game, 0, "stealth")
  game.useSpecialSlot(0)
  assert.equal(game.visiblePlayer(), null)
  fullChargeShot(game)
  assert.equal(item.active, false, "the shot drops it")
  assert.equal(game.visiblePlayer(), player)
  assert.ok(item.cooldown > 0, "and it goes onto its cooldown like any other end")
})

test("the defense turret holds fire in stealth, but still answers the player's hand", () => {
  const armed = (hidden, manual) => {
    const game = liveGame()
    const player = game.player
    withEquipment(game, "turret", "defenseBlaster")
    player.x = 400
    player.y = 320
    player.energy = player.energyMax
    if (hidden) {
      equip(game, 0, "stealth")
      game.useSpecialSlot(0)
    }
    if (manual) {
      // held through the bound control, since the ship reads its own input each
      // frame and would otherwise clear these straight back
      game.pressedKeys.add(game.bindings.keys.turretFire[0])
      player.turretAim = 0
    }
    game.rivals = [plainRival(560, 320, "scout")]
    let fired = 0
    for (let frame = 0; frame < 240; frame++) {
      player.energy = player.energyMax
      const before = game.projectiles.length
      player.update(1 / 60, game)
      fired += Math.max(0, game.projectiles.length - before)
    }
    return fired
  }
  assert.ok(armed(false, false) > 0, "it fires on rivals in the open")
  assert.equal(armed(true, false), 0, "and holds fire while the ship is hidden")
  assert.ok(armed(true, true) > 0, "unless the player is working it by hand")
})

test("a special left too long flashes out rather than blinking away", () => {
  const game = liveGame()
  game.player.x = -9000 // well clear, so it expires rather than being collected
  game.player.y = -9000
  const pickup = new Special(ARENA.cx, ARENA.cy, 0, 0, "oreMagnet")
  game.specialPickups = [pickup]
  pickup.life = CONFIG.EXPIRY_WARN
  game.particles = []
  for (let frame = 0; frame < Math.ceil(CONFIG.EXPIRY_WARN * 60) + 2; frame++) {
    pickup.update(1 / 60, game)
  }
  assert.equal(pickup.dead, true, "it went")
  assert.ok(game.particles.length > 0, "and left something behind when it did")
})

test("a loose special names itself for a ship close by, when help text is on", () => {
  // Counted as drawn text, since the label is the whole point of the feature.
  const labels = (distance, help) => {
    const game = liveGame()
    game.settings.help = help
    game.player.x = ARENA.cx
    game.player.y = ARENA.cy
    const pickup = new Special(ARENA.cx + distance, ARENA.cy, 0, 0, "oreMagnet")
    const drawn = []
    const renderer = { strokePoly() {}, line() {}, circle() {}, text: (str) => drawn.push(str) }
    pickup.draw(renderer, game)
    return drawn
  }
  const near = CONFIG.SPECIAL_LABEL_RANGE * 0.5,
    far = CONFIG.SPECIAL_LABEL_RANGE * 1.5
  assert.ok(labels(near, true).includes(SPECIAL_TYPES.oreMagnet.label), "named when close by")
  assert.ok(
    !labels(far, true).includes(SPECIAL_TYPES.oreMagnet.label),
    "and not from across the sector",
  )
  assert.ok(!labels(near, false).includes(SPECIAL_TYPES.oreMagnet.label), "nor with help text off")
})

test("the shop stocks only what the registry says is for sale", () => {
  const game = liveGame()
  game.devMode = true
  assert.deepEqual(game.buyableSpecials(), SPECIAL_IDS, "everything is for sale today")
  for (const id of SPECIAL_IDS) {
    assert.equal(typeof SPECIAL_TYPES[id].buyable, "boolean", `${id} must say either way`)
  }
  // and one taken off the shelf is gone from the list, dev mode or not
  const id = SPECIAL_IDS[0]
  const was = SPECIAL_TYPES[id].buyable
  SPECIAL_TYPES[id].buyable = false
  try {
    assert.ok(!game.buyableSpecials().includes(id), "not offered in dev mode")
    game.findSpecial(id)
    game.devMode = false
    assert.ok(!game.buyableSpecials().includes(id), "nor once the run has found one")
  } finally {
    SPECIAL_TYPES[id].buyable = was
  }
})

// ---- the HUD is drawn at the size the player asked for ----------------------

test("help text and HUD size are settings that survive a session", () => {
  const game = new Game()
  assert.equal(game.settings.help, true, "help text starts on")
  assert.equal(game.settings.uiScale, UI_SCALES[0])

  game.setHelp(false)
  assert.equal(game.settings.help, false)

  // one row steps the sizes offered, and wraps at the end of them
  for (const expected of [...UI_SCALES.slice(1), UI_SCALES[0]]) {
    game.stepUiScale(1)
    assert.equal(game.settings.uiScale, expected)
  }
  game.stepUiScale(-1)
  assert.equal(game.settings.uiScale, UI_SCALES[UI_SCALES.length - 1], "and the other way")

  const resumed = new Game()
  resumed.settings = { ...resumed.settings, ...JSON.parse(JSON.stringify(game.settings)) }
  assert.equal(resumed.settings.help, false)
  assert.equal(resumed.settings.uiScale, game.settings.uiScale)
})

// Every HUD element is anchored to a screen edge and grows inward, so raising the
// scale must make things bigger without pushing any of them off the page. A
// coordinate left unscaled is exactly what this catches.
function hudAt(uiScale, { shield = false } = {}) {
  const game = liveGame()
  game.settings.uiScale = uiScale
  game.upgrades.slots = MAX_SLOTS
  equip(game, 0, "repel")
  if (shield) {
    withShield(game)
  }
  game.lives = CONFIG.MAX_LIVES
  game.plan = { ...game.plan, rivals: 1 }
  game.showToast("A TOAST")

  const shapes = [],
    labels = []
  const note = (x, y, w, h) => shapes.push({ x, y, w, h })
  const renderer = {
    rect: (x, y, w, h) => note(x, y, w, h),
    circle: (x, y, radius) => note(x - radius, y - radius, radius * 2, radius * 2),
    line: (ax, ay, bx, by) =>
      note(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)),
    strokePoly: (points) => {
      const xs = points.map((p) => p.x),
        ys = points.map((p) => p.y)
      note(
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs) - Math.min(...xs),
        Math.max(...ys) - Math.min(...ys),
      )
    },
    text: (str, x, y, opts = {}) => labels.push({ str, x, y, size: opts.size || 12 }),
  }
  new GameView(renderer).drawHud(game)
  return { shapes, labels }
}

test("every HUD element is anchored to the page and scales from where it is anchored", () => {
  // The property, rather than the layout: a coordinate is measured from the left
  // edge, the right edge or the middle, and whichever it is, raising the scale
  // multiplies that distance. A `* ui` left off any of them breaks exactly this.
  // The shield's markers are the one exception, sitting a fraction of the way
  // along a bar that spans the page; the test below covers those.
  const factor = UI_SCALES[UI_SCALES.length - 1]
  const small = hudAt(1),
    large = hudAt(factor)
  assert.ok(small.shapes.length > 0 && small.labels.length > 0, "something was drawn")
  assert.equal(large.shapes.length, small.shapes.length, "the same shapes at either size")
  assert.equal(large.labels.length, small.labels.length, "and the same readouts")

  const axis = (at1, at2, span, what) => {
    const ways = [
      [at1, at2], // from the left or the top
      [span - at1, span - at2], // from the right or the bottom
      [at1 - span / 2, at2 - span / 2], // from the middle
    ]
    assert.ok(
      ways.some(([from, to]) => Math.abs(to - from * factor) < 0.5),
      `${what} sits at ${at1.toFixed(1)} then ${at2.toFixed(1)}, which is no edge scaled by ${factor}`,
    )
  }

  for (let i = 0; i < small.shapes.length; i++) {
    const a = small.shapes[i],
      b = large.shapes[i]
    axis(a.x, b.x, VIEW_W, `shape ${i} left`)
    axis(a.x + a.w, b.x + b.w, VIEW_W, `shape ${i} right`)
    axis(a.y, b.y, VIEW_H, `shape ${i} top`)
    axis(a.y + a.h, b.y + b.h, VIEW_H, `shape ${i} bottom`)
  }
  for (let i = 0; i < small.labels.length; i++) {
    const a = small.labels[i],
      b = large.labels[i]
    axis(a.x, b.x, VIEW_W, `"${a.str}" x`)
    axis(a.y, b.y, VIEW_H, `"${a.str}" y`)
    assert.ok(
      Math.abs(b.size - a.size * factor) < 0.01,
      `"${a.str}" is ${a.size} then ${b.size}, not ${factor} times bigger`,
    )
  }
})

test("the shield's markers hold their place along the bar at any HUD size", () => {
  const factor = UI_SCALES[UI_SCALES.length - 1]
  // The bar is the widest thing the HUD draws, so it is the widest shape recorded.
  const bar = (hud) => hud.shapes.reduce((a, b) => (b.w > a.w ? b : a))
  const markers = (hud) => {
    const along = bar(hud)
    return hud.shapes
      .filter((shape) => shape.w === 0 && shape.x > along.x && shape.x < along.x + along.w)
      .map((shape) => ({ fraction: (shape.x - along.x) / along.w, height: shape.h }))
  }
  const small = markers(hudAt(1, { shield: true })),
    large = markers(hudAt(factor, { shield: true }))
  assert.equal(small.length, 2, "an offline marker and a recovery marker")
  assert.equal(large.length, small.length)
  for (let i = 0; i < small.length; i++) {
    assert.ok(
      Math.abs(large[i].fraction - small[i].fraction) < 0.001,
      `marker ${i} moved along the bar, ${small[i].fraction} to ${large[i].fraction}`,
    )
    assert.ok(
      Math.abs(large[i].height - small[i].height * factor) < 0.5,
      `marker ${i} did not grow with the bar`,
    )
  }
  const labels = hudAt(factor, { shield: true }).labels.map((label) => label.str)
  assert.ok(
    labels.some((str) => str.startsWith("SHIELD")),
    "and the bar is still labelled",
  )
})

test("the spawn point is cleared before the ship warps back into it", () => {
  const game = liveGame()
  const player = game.player
  // a boulder sitting right where the ship will reappear
  const rock = new Asteroid({ vertices: square(ARENA.cx + 10, ARENA.cy, 70), vx: 0, vy: 0 })
  game.asteroids = [rock]
  game.lives = 3
  game.playerLoseLife()
  assert.equal(player.x, ARENA.cx)
  assert.equal(player.y, ARENA.cy)

  // it eases out over the arrival rather than jumping: a single frame moves it a
  // little, and it is clear by the time the ship is solid
  const before = rock.center.x
  game.advance(1 / 60)
  const firstFrame = rock.center.x - before
  // the capped ease, plus the drift the same frame's push has just given it
  const perFrame = (CONFIG.SPAWN_CLEAR_SPEED + CONFIG.SPAWN_CLEAR_PUSH / 60) / 60
  assert.ok(
    firstFrame > 0 && firstFrame <= perFrame,
    `one frame moved it ${firstFrame.toFixed(2)}, over the ${perFrame.toFixed(2)} it may`,
  )

  for (let frame = 0; frame < 60 * 8 && !player.solid; frame++) {
    game.advance(1 / 60)
  }
  assert.ok(player.solid, "the ship arrived")
  assert.ok(
    !pointInPolygon({ x: player.x, y: player.y }, rock.vertices),
    "and must not come back inside a rock",
  )
  const gap = Math.hypot(rock.center.x - player.x, rock.center.y - player.y) - rock.boundRadius
  assert.ok(gap > 0, `the hull has clear space around it, ${gap.toFixed(1)} units`)
  assert.ok(rock.vx > 0, "and the rock was sent on its way, so it does not drift straight back")
})

test("a rock centred exactly on the spawn point still gets a direction to go", () => {
  const game = liveGame()
  const rock = new Asteroid({ vertices: square(ARENA.cx, ARENA.cy, 60), vx: 0, vy: 0 })
  game.asteroids = [rock]
  for (let frame = 0; frame < 120; frame++) {
    game.clearSpawnArea(1 / 60, ARENA.cx, ARENA.cy)
  }
  const moved = Math.hypot(rock.center.x - ARENA.cx, rock.center.y - ARENA.cy)
  assert.ok(Number.isFinite(moved) && moved > 0, `it went somewhere, ${moved.toFixed(1)} away`)
  assert.ok(Number.isFinite(rock.vx) && Number.isFinite(rock.vy))
})

test("a spawn point that is already clear is left alone", () => {
  const game = liveGame()
  const far = new Asteroid({ vertices: square(ARENA.cx + 500, ARENA.cy, 60), vx: 0, vy: 0 })
  game.asteroids = [far]
  assert.equal(game.clearSpawnArea(1 / 60, ARENA.cx, ARENA.cy), false)
  assert.equal(far.vx, 0, "nothing was shoved")
})

test("the grace period after arriving is time the ship can actually be flown", () => {
  const game = liveGame()
  const player = game.player
  game.lives = 3
  game.playerLoseLife()
  assert.equal(player.invincible, CONFIG.INVIN_TIME)

  let warping = 0
  for (let frame = 0; frame < 60 * 8 && !player.solid; frame++) {
    game.advance(1 / 60)
    warping += 1 / 60
  }
  assert.ok(warping > 0.5, `the arrival takes a while, ${warping.toFixed(2)}s`)
  assert.ok(
    Math.abs(player.invincible - CONFIG.INVIN_TIME) < 0.05,
    "none of it is spent while the ship cannot be flown",
  )

  for (let frame = 0; frame < Math.ceil(CONFIG.INVIN_TIME * 60) - 6; frame++) {
    game.advance(1 / 60)
  }
  assert.ok(player.invincible > 0, "and it lasts the whole of what it says")
})

test("the screen stops shaking once the run is over", () => {
  const game = liveGame()
  game.lives = 1
  game.playerLoseLife()
  assert.equal(game.phase, "over")
  assert.ok(game.screenShake > 0, "losing the last life throws the screen about")
  for (let frame = 0; frame < 120; frame++) {
    game.advance(1 / 60)
  }
  assert.equal(game.screenShake, 0, "and it settles, rather than shaking for good")
})

// Range used to be measured to the rock's middle, so a boulder with its face in
// the exhaust counted as most of a range away and was barely moved, which is
// exactly the rock the wash is wanted for.
test("the exhaust wash shoves a boulder behind the ship, not only a pebble", () => {
  // Seeded: a rock's outline is generated, so an unseeded one changes shape run to
  // run and a comparison near the edge of the wash's reach flips with it.
  const pushed = (radius, gap) =>
    seeded(8140 + radius, () => {
      const game = liveGame()
      const player = game.player
      player.x = ARENA.cx
      player.y = ARENA.cy
      player.angle = 0 // nose along +x, so the exhaust washes along -x
      player.energyMax = 1e6
      game.holding = (name) => name === "thrust"
      const rock = new Asteroid({ radius, x: 0, y: 0, vx: 0, vy: 0, spin: 0 })
      // Parked by its true surface, and clear of the hull as well, so nothing is
      // touching and the only thing acting on the rock is the exhaust.
      const from = gap + rock.boundRadius + player.boundRadius
      rock.translate(ARENA.cx - from - rock.center.x, ARENA.cy - rock.center.y)
      game.asteroids = [rock]
      for (let frame = 0; frame < 60; frame++) {
        player.x = ARENA.cx
        player.y = ARENA.cy
        player.vx = 0
        player.vy = 0
        player.energy = player.energyMax
        player.update(1 / 60, game)
      }
      return { pushed: -rock.vx, mass: rockMass(rock.area) }
    })

  const gap = CONFIG.EXHAUST_WASH_RANGE / 2
  const pebble = pushed(30, gap),
    boulder = pushed(100, gap)
  assert.ok(boulder.mass > pebble.mass * 3, "the two are worth comparing")
  assert.ok(pebble.pushed > 0, "a pebble is blown clear")
  assert.ok(boulder.pushed > 0, "and a boulder is moved too, however heavy it is")
  assert.ok(boulder.pushed < pebble.pushed, "less, in proportion to what it weighs")

  // the falloff runs on the gap to the rock's surface, so the reach is the same
  // whatever size the rock is
  for (const radius of [30, 100]) {
    const close = pushed(radius, 10),
      far = pushed(radius, CONFIG.EXHAUST_WASH_RANGE * 0.8)
    assert.ok(close.pushed > far.pushed, `a ${radius} rock is shoved harder up close`)
    assert.ok(far.pushed > 0, `and still felt at the edge of the wash's reach`)
    const beyond = pushed(radius, CONFIG.EXHAUST_WASH_RANGE * 1.2).pushed
    assert.ok(Math.abs(beyond) < 1e-9, `and not past it, but it moved ${beyond}`)
  }
})

// ---- one answer to "what is nearest" ---------------------------------------

// Four inlined loops used to spell this four ways, with three different sentinel
// seeds and three different sets of filters. These pin the shared rule.
test("a nearest scan takes the closest of what can be shot at", () => {
  const game = liveGame()
  const from = { x: ARENA.cx, y: ARENA.cy }
  const near = plainRival(ARENA.cx + 120, ARENA.cy, "scout")
  const far = plainRival(ARENA.cx + 300, ARENA.cy, "scout")
  game.rivals = [far, near] // out of order, so the scan is doing the choosing

  const found = game.nearestRival(from)
  assert.equal(found.target, near)
  assert.ok(Math.abs(found.distance - 120) < 1e-9, `measured ${found.distance}`)

  // a body killed earlier in the frame is still in the list, and must not be taken
  near.dead = true
  assert.equal(game.nearestRival(from).target, far, "a dead rival is passed over")

  // nor one that is not in play: a rival outside the ring cannot be harmed
  near.dead = false
  const { game: outside, rival } = rivalBeyondTheRing("scout", 200)
  assert.equal(rival.inPlay(), false, "the pose must actually be out of play")
  outside.rivals = [rival]
  assert.equal(outside.nearestRival({ x: rival.x, y: rival.y }), null)

  // and `within` bounds the search rather than being measured afterwards
  assert.equal(game.nearestRival(from, 100), null, "nothing inside 100")
  assert.equal(game.nearestRival(from, 121).target, near)
})

test("a nearest scan answers for every collection it is asked about", () => {
  const game = liveGame()
  const from = { x: ARENA.cx, y: ARENA.cy }
  assert.equal(game.nearestRival(from), null, "an empty sector has no answer")
  assert.equal(game.nearestAsteroid(from), null)
  assert.equal(game.nearestOre(from), null)

  const rock = new Asteroid({ vertices: square(ARENA.cx + 200, ARENA.cy, 40), vx: 0, vy: 0 })
  game.asteroids = [rock]
  const found = game.nearestAsteroid(from)
  assert.equal(found.target, rock, "the rock itself, not its centre")
  // a rock's x/y is its own centroid, so measuring to the body measures to the
  // middle of it, which is what the steering code wants
  assert.equal(rock.x, rock.center.x)
  assert.equal(rock.y, rock.center.y)

  game.oreChunks = [new Ore(ARENA.cx + 50, ARENA.cy, 0, 0)]
  assert.ok(Math.abs(game.nearestOre(from).distance - 50) < 1e-9)
})

// ---- weights ---------------------------------------------------------------

test("what an entry weighs follows its own fields and nothing else", () => {
  const entry = { fromSector: 5, weightPerSector: 2, weightCap: 8 }
  assert.equal(weightAt(entry, 4), 0, "not in the running before its sector")
  assert.equal(weightAt(entry, 5), 1, "and weighs the default once it is")
  assert.equal(weightAt(entry, 7), 5, "growing by weightPerSector each sector after")
  assert.equal(weightAt(entry, 20), 8, "up to the cap and no further")
  assert.equal(weightAt({ weight: 4 }, 0), 4, "a stated weight is taken as it stands")
  assert.equal(weightAt({}, 0), 1, "and an entry that states nothing weighs one")
})

test("a hazard's share can be worked out rather than sampled", () => {
  // The point of weighing them: the share is one weight over the total, so it is
  // arithmetic. It used to be whatever was left after the rolls before it, which
  // could only be recovered by running the rolls.
  const game = liveGame()
  const label = (t) =>
    [t.explosive && "explosive", t.gun && "gun", t.shield && "shield"].filter(Boolean).join("+")
  for (const sector of [5, 8, 20]) {
    const total = HAZARD_TRAITS.reduce((sum, h) => sum + weightAt(h, sector), 0)
    const counts = new Map()
    const rolls = 20000
    seeded(sector * 1000 + 7, () => {
      for (let i = 0; i < rolls; i++) {
        const key = label(game.rollHazardTraits(sector))
        counts.set(key, (counts.get(key) || 0) + 1)
      }
    })
    for (const hazard of HAZARD_TRAITS) {
      const want = weightAt(hazard, sector) / total
      const got = (counts.get(label(hazard.traits)) || 0) / rolls
      assert.ok(
        Math.abs(want - got) < 0.02,
        `sector ${sector} ${label(hazard.traits)}: weights say ${want.toFixed(3)}, rolled ${got.toFixed(3)}`,
      )
    }
  }
})

test("a rival's share of arrivals is its own weight over the total", () => {
  // It used to be whatever the types rolled before it left over, so the frigate's
  // declared 0.3 arrived 23.8% of the time and the scout, which declared nothing
  // at all, took 56%. timeline.html had to sample the spawner to say so.
  const game = liveGame()
  const names = Object.keys(SHIP_TYPES)
  for (const sector of [4, 6, 12]) {
    game.level = sector
    const total = names.reduce((sum, name) => sum + game.spawnWeight(name), 0)
    const counts = new Map()
    const rolls = 20000
    seeded(sector * 31 + 5, () => {
      for (let i = 0; i < rolls; i++) {
        game.rivals.length = 0
        game.spawnRival()
        const ship = game.rivals[0]
        if (ship) {
          counts.set(ship.typeName, (counts.get(ship.typeName) || 0) + 1)
        }
      }
    })
    game.rivals.length = 0
    for (const name of names) {
      const want = game.spawnWeight(name) / total
      const got = (counts.get(name) || 0) / rolls
      assert.ok(
        Math.abs(want - got) < 0.02,
        `sector ${sector} ${name}: weights say ${want.toFixed(3)}, arrived ${got.toFixed(3)}`,
      )
    }
  }
})

test("a type already at its limit is out of the running, and something always is not", () => {
  const game = liveGame()
  game.level = 12
  const capped = Object.keys(SHIP_TYPES).find((name) => SHIP_TYPES[name].spawn.maxConcurrent === 1)
  assert.ok(game.spawnWeight(capped) > 0, "it must be in the running with the field empty")
  game.rivals = [plainRival(ARENA.cx, ARENA.cy, capped)]
  assert.equal(game.spawnWeight(capped), 0, "and out of it once one is already there")
  // The fallback type is gone, so what guarantees an arrival is that one type
  // states no limit at all. Without that a spawn could be silently lost.
  const open = Object.keys(SHIP_TYPES).filter((name) => game.spawnWeight(name) > 0)
  assert.ok(open.length > 0, "some type must always be available to arrive")
})

// ---- who shoots at whom ----------------------------------------------------

// Hostility was hard-wired: every gun read visiblePlayer and the player's turret
// read nearestRival, so a third side could not be said at all. These pin the rule
// that replaced it. No alien type ships yet, so one is flown for that side here,
// which is what a real one will do through its own registry entry.
function flyingFor(typeName, faction, body) {
  const type = SHIP_TYPES[typeName]
  const original = type.faction
  type.faction = faction
  try {
    return body()
  } finally {
    type.faction = original
  }
}

test("a hull takes aim at the sides its own faction is hostile to", () => {
  flyingFor("seeker", "alien", () => {
    const game = liveGame()
    const rival = plainRival(ARENA.cx + 100, ARENA.cy, "scout")
    const alien = plainRival(ARENA.cx + 160, ARENA.cy, "seeker")
    game.rivals = [rival, alien]
    assert.equal(rival.faction, "rival", "a type says nothing and flies for the rivals")
    assert.equal(alien.faction, "alien")

    // the rival is 100 from the player and 60 from the alien, so it takes the alien
    assert.equal(game.hostileTarget(rival).target, alien, "a rival fights the aliens as well")
    assert.equal(game.hostileTarget(alien).target, rival, "and is fought back")
    assert.equal(game.hostileTarget(game.player).target, rival, "the player fights both")
  })
})

test("a hidden player is no target, and the other side still is", () => {
  flyingFor("seeker", "alien", () => {
    const game = liveGame()
    const rival = plainRival(ARENA.cx + 60, ARENA.cy, "scout")
    const alien = plainRival(ARENA.cx + 300, ARENA.cy, "seeker")
    game.rivals = [rival, alien]
    assert.equal(game.hostileTarget(rival).target, game.player, "in the open the player is nearest")
    hideThePlayer(game)
    assert.equal(game.hostileTarget(rival).target, alien, "hidden, the rival turns on the alien")
  })
})

test("a rock is a hazard: it fights the player and leaves the rivals to it", () => {
  const game = liveGame()
  const rock = new Asteroid({ x: ARENA.cx + 200, y: ARENA.cy, radius: 40, traits: {} })
  const rival = plainRival(ARENA.cx + 210, ARENA.cy, "scout")
  game.asteroids = [rock]
  game.rivals = [rival]
  assert.equal(rock.faction, "hazard")
  // the rival is 10 units off it and the player 200, and it still takes the player:
  // scenery that fought the AI would be a sector the player could sit out
  assert.equal(game.hostileTarget(rock).target, game.player)
})

// A turret that swings toward a ship nothing can see gives its position away, so
// the drawn bearing has to ask the same question the controller does. Rock
// turrets were fixed for this and ships were missed.
function drawnBearings(game, body) {
  const bearings = []
  const renderer = {
    strokePoly() {},
    circle() {},
    rect() {},
    text() {},
    line: (ax, ay, bx, by) => bearings.push(Math.atan2(by - ay, bx - ax)),
  }
  body.draw(renderer, game)
  return bearings
}

function hideThePlayer(game) {
  game.player.energy = game.player.energyMax
  equip(game, 0, "stealth")
  game.useSpecialSlot(0)
  assert.equal(game.visiblePlayer(), null, "the pose must actually be hidden")
}

test("a turret does not track a ship nothing can see", () => {
  const poses = [
    [400, 0],
    [0, 400],
    [-400, 0],
  ]
  const swing = (bearings) => Math.max(...bearings) - Math.min(...bearings)

  for (const armed of ["a rival", "a rock"]) {
    const build = (game) => {
      if (armed === "a rival") {
        const rival = new RivalShip(ARENA.cx, ARENA.cy, "frigate", [
          { hp: 1, weapon: "autocannon", controller: "turret" },
        ])
        game.rivals = [rival]
        return rival
      }
      const rock = new Asteroid({ vertices: square(ARENA.cx, ARENA.cy, 60) })
      rock.hardpoints.push({
        x: rock.center.x,
        y: rock.center.y,
        module: new Weapon("blaster", "turret"),
      })
      rock.refreshEnergy()
      game.asteroids = [rock]
      return rock
    }

    // seen: the barrels follow the ship, which is what makes a turret legible
    const open = liveGame()
    const seen = build(open)
    const followed = poses.map(([dx, dy]) => {
      open.player.x = ARENA.cx + dx
      open.player.y = ARENA.cy + dy
      const bearings = drawnBearings(open, seen)
      assert.equal(bearings.length, 1, `${armed} should draw one barrel`)
      return bearings[0]
    })
    assert.ok(swing(followed) > 1, `${armed} should track a ship it can see`)

    // hidden: they hold whatever bearing they had, however the ship moves
    const dark = liveGame()
    const hiding = build(dark)
    hideThePlayer(dark)
    const held = poses.map(([dx, dy]) => {
      dark.player.x = ARENA.cx + dx
      dark.player.y = ARENA.cy + dy
      return drawnBearings(dark, hiding)[0]
    })
    assert.ok(
      swing(held) < 1e-9,
      `${armed} tracked a hidden ship across ${((swing(held) * 180) / Math.PI).toFixed(1)} degrees`,
    )
  }
})

// A ship's heading accumulates and is never normalised, so a rival that has been
// turning one way for a while sits past a full turn. The wrap this replaces was
// only correct while (goal - heading) stayed above -3 PI, and past that it turned
// the long way round. At a heading of 8 rad with a goal bearing of -2 it gave
// -3.72 where the short way is +2.57: the opposite direction.
test("a rival past a full turn still turns the short way", () => {
  const game = liveGame()
  const player = game.player
  const hunter = Object.keys(SHIP_TYPES).find((name) => SHIP_TYPES[name].hunts)
  assert.ok(hunter, "some ship should hunt the player")

  const goal = -2 // where the player sits, as a bearing from the rival
  player.x = ARENA.cx + Math.cos(goal) * 300
  player.y = ARENA.cy + Math.sin(goal) * 300

  const rival = plainRival(ARENA.cx, ARENA.cy, hunter)
  rival.angle = 8 // past one full turn, which real play reaches
  rival.lifeTimer = 99 // so it is hunting rather than leaving
  game.rivals = [rival]
  assert.ok(rival.angle > Math.PI * 2, "the pose must actually be past a full turn")

  const before = rival.angle
  rival.update(1 / 60, game)
  assert.ok(
    rival.angle > before,
    `it turned ${(rival.angle - before).toFixed(3)}, which is away from the player`,
  )
})

// The player's hull has no health of its own: onHull costs a life outright. So a
// grace period that turns away rock contact and nothing else is no protection at
// all, and a single shot arriving as the ship lands is a one-shot kill. It was
// checked at the one thing that reads it and not in takeDamage, which is where
// every channel arrives.
test("the grace period after arriving turns away every kind of damage", () => {
  const arrived = () => {
    const game = liveGame()
    const player = game.player
    player.x = 400
    player.y = 320
    player.invincible = CONFIG.INVIN_TIME
    return game
  }

  const shot = arrived()
  shot.projectiles = [new Projectile(400, 320, 0, 0, CONFIG.DMG_RIVAL_GUN, null)]
  shot.projectiles[0].update(1 / 60, shot)
  assert.equal(shot.lives, CONFIG.START_LIVES, "a bullet must not cost a life")

  const beamed = arrived()
  const shooter = plainRival(100, 320, "scout")
  beamed.rivals = [shooter]
  beamed.applyBeam(
    { a: { x: 100, y: 320 }, dir: { x: 1, y: 0 }, b: { x: 900, y: 320 } },
    shooter,
    { type: WEAPON_TYPES.cannonLaser },
    CONFIG.DMG_FRIGATE_LASER,
  )
  assert.equal(beamed.lives, CONFIG.START_LIVES, "nor a beam")

  const blasted = arrived()
  const bomb = new Asteroid({ vertices: square(400 + 60, 320, 40) })
  bomb.explosive = true
  blasted.asteroids = [bomb]
  bomb.detonate(blasted)
  assert.equal(blasted.lives, CONFIG.START_LIVES, "nor a blast going off beside it")

  const ground = arrived()
  ground.asteroids = [new Asteroid({ vertices: square(400, 320, 70), vx: 0, vy: 0 })]
  for (let frame = 0; frame < 60; frame++) {
    ground.player.x = 400
    ground.player.y = 320
    ground.advance(1 / 60)
  }
  assert.equal(ground.lives, CONFIG.START_LIVES, "nor grinding against a rock")

  // none of it counts toward the sector summary, because none of it landed
  for (const game of [shot, beamed, blasted, ground]) {
    assert.equal(game.stats.damage, 0, "nothing that was turned away is totalled")
  }

  // and once it runs out, everything lands again
  const exposed = arrived()
  exposed.player.invincible = 0
  exposed.projectiles = [new Projectile(400, 320, 0, 0, CONFIG.DMG_RIVAL_GUN, null)]
  exposed.projectiles[0].update(1 / 60, exposed)
  assert.equal(exposed.lives, CONFIG.START_LIVES - 1, "the grace period is a period")
})

test("a respawn cannot be shot down before it can be flown", () => {
  // The whole journey, with a round arriving on the spawn point every frame: the
  // pause, the warp in, and the grace period after it. Stops a frame short of the
  // end, since a shot already touching the hull the instant the grace runs out is
  // meant to land.
  const game = liveGame()
  const player = game.player
  game.asteroids = [new Asteroid({ vertices: square(ARENA.cx, ARENA.cy - 900, 60) })]
  game.lives = 3
  game.playerLoseLife()
  const lives = game.lives

  const covered = CONFIG.RESPAWN_PAUSE + CONFIG.WARP_TIME + CONFIG.INVIN_TIME
  let warpingFrames = 0
  for (let frame = 0; frame < Math.floor((covered - 0.1) * 60); frame++) {
    game.projectiles.push(new Projectile(player.x, player.y, 0, 0, CONFIG.DMG_RIVAL_GUN, null))
    game.advance(1 / 60)
    if (!player.solid) {
      warpingFrames++
    }
    assert.equal(game.lives, lives, `a life went ${(frame / 60).toFixed(2)}s in`)
  }
  assert.ok(warpingFrames > 0, "the journey must include the warp, not just the grace")
  assert.ok(player.solid, "and must reach the point the ship is solid")
  assert.ok(player.invincible > 0, "with the grace period not yet spent")

  // and it does end: the same round costs a life once it has
  player.invincible = 0
  game.projectiles.push(new Projectile(player.x, player.y, 0, 0, CONFIG.DMG_RIVAL_GUN, null))
  game.advance(1 / 60)
  assert.equal(game.lives, lives - 1, "the grace period is a period")
})

// If nothing can hurt the ship, nothing should be able to see it either. A gun
// allowed to keep shooting at a ship it cannot hurt is only stacking up rounds to
// land the moment the grace period runs out, and a cannon that commits to a shot
// mid-warp fires it into a ship that has only just arrived. The turret controller
// held its fire for this and the hunter did not, which is the same case answered
// two ways.
test("nothing can see the ship while nothing can reach it", () => {
  const game = liveGame()
  const player = game.player
  assert.equal(game.visiblePlayer(), player, "a flying ship is there to be seen")

  player.invincible = CONFIG.INVIN_TIME
  assert.equal(game.visiblePlayer(), null, "not during the grace period")
  assert.equal(player.untouchable, true)

  player.invincible = 0
  player.warp = 0.5
  player.warpTarget = 1
  assert.equal(game.visiblePlayer(), null, "nor mid-warp")
  assert.equal(player.untouchable, true)

  player.warp = 1
  assert.equal(game.visiblePlayer(), player, "and visible again once it can be hurt")
  assert.equal(player.untouchable, false)
})

test("a cannon does not wind up on a ship that has just arrived", () => {
  // The hunter controller commits: once winding up it fires even if the player
  // slips away, so starting a wind-up on an untouchable ship lands a shot on one
  // that has only just become solid.
  const hunter = Object.keys(SHIP_TYPES).find((name) =>
    SHIP_TYPES[name].loadout.some((entry) => entry.controller === "hunter"),
  )
  assert.ok(hunter, "some ship should carry a committed cannon")

  const game = liveGame()
  const player = game.player
  player.x = ARENA.cx
  player.y = ARENA.cy
  game.asteroids = [new Asteroid({ vertices: square(ARENA.cx, ARENA.cy - 900, 60) })]
  const rival = new RivalShip(ARENA.cx + 180, ARENA.cy, hunter, SHIP_TYPES[hunter].loadout)
  rival.lifeTimer = 99
  rival.accel = 0
  game.rivals = [rival]
  game.lives = 3
  game.playerLoseLife()
  const lives = game.lives

  const hold = () => {
    rival.x = ARENA.cx + 180
    rival.y = ARENA.cy
    rival.vx = 0
    rival.vy = 0
    rival.angle = Math.PI // pointed at the spawn point the whole time
    rival.energy = rival.energyMax
  }
  const windingUp = () =>
    rival.hardpoints.some(
      (hp) => hp.module && hp.module.kind === "weapon" && hp.module.charging > 0,
    )

  // Only frames that ended still untouchable are asserted: the grace runs out
  // inside a frame, and the frame it runs out in is fair game.
  let frames = 0
  while (frames < 60 * 10) {
    hold()
    game.advance(1 / 60)
    frames++
    if (!player.untouchable) {
      break
    }
    assert.equal(windingUp(), false, `it began a shot ${(frames / 60).toFixed(2)}s in`)
    assert.equal(game.lives, lives, "and the respawn survives untouched")
  }
  assert.ok(frames > 60, "the untouchable window must be worth measuring")

  // a guard, not a mute: it commits as soon as the ship can be hurt again
  let committed = false
  for (let after = 0; after < 60 * 3 && !committed; after++) {
    hold()
    game.advance(1 / 60)
    committed = windingUp() || game.lives < lives
  }
  assert.ok(committed, "and it takes the shot once the ship is fair game")
})

// Put a hunter 700 units out, take the player away with a respawn, and report how
// much of that gap it closed while it could not be seen.
function spawnCampRun() {
  const hunter = Object.keys(SHIP_TYPES).find((name) => SHIP_TYPES[name].hunts)
  const game = liveGame()
  const player = game.player
  player.x = ARENA.cx
  player.y = ARENA.cy
  game.asteroids = [new Asteroid({ vertices: square(ARENA.cx, ARENA.cy - 900, 60) })]
  const rival = plainRival(ARENA.cx + 700, ARENA.cy, hunter)
  rival.angle = Math.PI // already pointed at the spawn point
  rival.lifeTimer = 99
  game.rivals = [rival]
  game.lives = 3
  game.playerLoseLife()

  const startedAt = Math.hypot(rival.x - ARENA.cx, rival.y - ARENA.cy)
  let frames = 0
  while (player.untouchable && frames < 60 * 10) {
    game.advance(1 / 60)
    frames++
  }
  assert.ok(frames > 60, "the untouchable window must be worth measuring")
  return { startedAt, endedAt: Math.hypot(rival.x - ARENA.cx, rival.y - ARENA.cy) }
}

test("a hunting rival does not settle on a spawn point it cannot see", () => {
  // Steering at the middle of the arena closed 630 of the 700 units every single
  // time and then waited there, which is the behaviour worth forbidding. A search
  // is random, so what replaces it cannot be pinned by one run or by how far it
  // happened to travel: a walk about a field ends up somewhere in that field, and
  // sometimes that is nearby.
  //
  // What must hold is that it does not end up on the spawn. Measured over several
  // searches: it must sit a fair way off on average, and it must not be true that
  // every search brings it closer.
  const runs = [11, 23, 37, 41, 59, 71, 83, 97].map((seed) => seeded(seed, spawnCampRun))
  const ended = runs.map((r) => r.endedAt)
  const mean = ended.reduce((sum, at) => sum + at, 0) / ended.length
  const report = ended.map((at) => at.toFixed(0)).join(", ")
  assert.ok(mean > 350, `ended a mean of ${mean.toFixed(0)} from the spawn: ${report}`)
  assert.ok(
    runs.some((r) => r.endedAt > r.startedAt),
    `every search closed on the spawn, so it is still drawn to it: ${report}`,
  )
})

// ---- progression is data ---------------------------------------------------

// ---- an exploding rock and its neighbours ---------------------------------

// Range used to be measured centre to centre, so a boulder with its face against
// the blast counted as 150 units away and took nothing but a shove, and no rock
// took blast damage at all: they were either shattered outright or pushed, while
// the player and rivals both took BLAST_DAMAGE through takeDamage.
const EXPLOSIVE = HAZARD_TRAITS.find((h) => h.traits.explosive).traits
const ROCK_SHIELD = HAZARD_TRAITS.find((h) => h.traits.shield && !h.traits.gun).traits

// A bomb at the arena centre with one neighbour whose surface sits `gap` from it.
function detonateBeside(radius, gap, traits) {
  const game = liveGame()
  const bomb = new Asteroid({ x: ARENA.cx, y: ARENA.cy, radius: 45, traits: EXPLOSIVE })
  const neighbour = new Asteroid({
    x: ARENA.cx + bomb.boundRadius + radius + gap,
    y: ARENA.cy,
    radius,
    traits,
  })
  game.asteroids = [bomb, neighbour]
  bomb.detonate(game)
  return { game, bomb, neighbour }
}

test("a blast breaks up a neighbour whose surface is against it, however big it is", () => {
  for (const radius of [30, 60, 100]) {
    const { neighbour } = detonateBeside(radius, -4, {})
    assert.equal(
      neighbour.dead,
      true,
      `a radius-${radius} rock touching the blast must be broken up` +
        ` (its centre is ${Math.round(neighbour.boundRadius + 45)} away, which is what used to be measured)`,
    )
  }
})

test("a blast reaches the same distance whatever size the neighbour is", () => {
  // The property that measuring to the surface buys: reach no longer depends on
  // how far off centre the neighbour's middle happens to sit.
  //
  // Rock silhouettes are random, so the exact reach wobbles with the shape. Seed
  // the generator for the measurement, or this passes or fails according to how
  // much randomness the tests before it happened to consume.
  const reachFor = (radius) => {
    for (let gap = 0; gap <= 300; gap += 2) {
      if (!detonateBeside(radius, gap, {}).neighbour.dead) {
        return gap
      }
    }
    return null
  }
  const reaches = seeded(20260725, () => [30, 60, 100].map(reachFor))
  assert.ok(
    reaches.every((r) => r !== null),
    "each size must have a reach",
  )
  const spread = Math.max(...reaches) - Math.min(...reaches)
  assert.ok(
    spread <= 20,
    `reach varied by ${spread} units across neighbour sizes: ${JSON.stringify(reaches)}`,
  )
})

test("a shielded rock takes a blast on its shield and survives it", () => {
  const { neighbour } = detonateBeside(100, -4, ROCK_SHIELD)
  assert.ok(neighbour.shieldModule(), "the neighbour must actually be shielded")
  assert.equal(neighbour.dead, false, "the shield that met the blast earns it this one")
  assert.equal(neighbour.energy, 0, "but the blast drains it")
  assert.ok(Math.hypot(neighbour.vx, neighbour.vy) > 0, "and still throws the rock clear")

  // once bare, the next blast does break it up
  const bare = detonateBeside(100, -4, ROCK_SHIELD)
  bare.neighbour.shieldModule().up = false
  const second = new Asteroid({
    x: bare.neighbour.center.x - bare.neighbour.boundRadius - 40,
    y: bare.neighbour.center.y,
    radius: 45,
    traits: EXPLOSIVE,
  })
  bare.game.asteroids.push(second)
  second.detonate(bare.game)
  assert.equal(bare.neighbour.dead, true, "with the shield down it goes")
})

test("a blast leaves alone what is already wreckage", () => {
  // Every other traversal skips a body that died earlier in the frame, and the
  // blast now does too. Hitting one again destroys it a second time, which pays
  // its kill twice.
  const game = liveGame()
  const bomb = new Asteroid({ x: ARENA.cx, y: ARENA.cy, radius: 45, traits: EXPLOSIVE })
  const rival = plainRival(ARENA.cx + 40, ARENA.cy, "scout")
  rival.dead = true
  game.asteroids = [bomb]
  game.rivals = [rival]
  const before = game.score
  bomb.detonate(game)
  assert.equal(game.score, before, "a hull already gone must not be killed again")
})

test("dev mode walks the sector only from the row that shows it", () => {
  const game = liveGame()
  game.devMode = true
  game.enterShop()
  const sector = game.shopSector

  // anywhere but the launch line, a sideways press must leave it alone
  game.shopSelection = 0
  game.menuAdjust(1)
  game.menuAdjust(-1)
  assert.equal(game.shopSector, sector, "a press on another row must not move the sector")

  game.shopSelection = game.launchRow
  game.menuAdjust(1)
  assert.equal(game.shopSector, sector + 1, "and from the launch line it does")
  game.menuAdjust(-1)
  assert.equal(game.shopSector, sector)

  // at the floor the press is not swallowed, so OPTIONS is still reachable
  game.shopSector = 1
  game.shopSelection = game.launchRow
  game.menuAdjust(-1)
  assert.equal(game.shopSector, 1, "it cannot go below the first sector")
  assert.equal(game.shopSelection, game.optionsRow, "and the press walks to OPTIONS instead")
})

// Every string the shop draws, with the y it landed at. The pop-over is drawn last
// and over the rows, so what it says has to be read out of the whole frame.
function shopText(game) {
  const texts = []
  const renderer = {
    beginFrame() {},
    endFrame() {},
    clearFrame() {},
    pushView() {},
    popView() {},
    nebula() {},
    compositeBackground() {},
    setWarp() {},
    strokePoly() {},
    line() {},
    circle() {},
    rect() {},
    point() {},
    planet() {},
    text: (str, x, y) => texts.push({ str: String(str), y: Math.round(y) }),
  }
  new GameView(renderer).render(game)
  return texts
}

// Which shop row fills an equipment slot, since the order is the registry's.
function equipmentRowIndex(game, slot) {
  for (let row = 0; row < 20; row++) {
    const item = game.shopItem(row)
    if (item && item.equipment === slot) {
      return row
    }
  }
  throw new Error(`no shop row for the ${slot} slot`)
}

test("a pop-over is titled by whatever opened it, not by the first special slot", () => {
  // The equipment menu carried no identity of its own, so it was drawn as a
  // specials menu on slot 0: the ENGINE options appeared under the title ORE
  // MAGNET, in the ore magnet's box.
  const game = liveGame()
  game.enterShop()
  game.oreBalance = 500
  game.shopSelection = equipmentRowIndex(game, "engine")
  game.doShopAction()
  assert.ok(game.slotMenu, "the row should open a pop-over")
  assert.equal(game.slotMenu.equipment, "engine")

  const said = shopText(game).map((entry) => entry.str)
  assert.ok(said.includes(EQUIPMENT.engine.label), "titled for the slot it fills")
  assert.ok(
    !said.includes(SPECIAL_TYPES.oreMagnet.label),
    "and not for whatever happens to be in the first special slot",
  )
  for (const option of EQUIPMENT.engine.options) {
    assert.ok(
      said.some((line) => line.includes(option.name)),
      `${option.name} should be offered`,
    )
  }
})

test("a specials pop-over is still titled by what is in its slot", () => {
  const game = liveGame()
  game.enterShop()
  game.shopSelection = game.slotsRow
  game.shopSlot = 0
  game.doShopAction()
  assert.ok(game.slotMenu, "a filled slot opens")
  assert.equal(game.slotMenu.equipment, undefined)
  const said = shopText(game).map((entry) => entry.str)
  assert.ok(said.includes(SPECIAL_TYPES.oreMagnet.label), "named for what it holds")
})

test("a slot that will go without can be emptied, and stays empty across a save", () => {
  // A shieldless run is a way to play, so what is fitted can be taken off. It is not
  // sold: it stays owned, so the choice can be taken back.
  const game = liveGame()
  game.oreBalance = 500
  const mark = optionAt("shield", 0)
  game.equipmentRows("shield")[0].action(game)
  assert.ok(game.player.shieldModule(), "bought and fitted")

  const none = game.equipmentRows("shield").at(-1)
  assert.equal(none.name, "NONE", "the last row is the one that takes it off")
  none.action(game)
  assert.equal(game.player.shieldModule(), null, "the bubble is gone")
  assert.ok(game.ownsEquipment("shield", mark), "but it is still owned")
  assert.equal(game.equipmentRows("shield").at(-1).value(game), "FITTED", "and NONE is what is on")

  // an empty slot must not be quietly refilled by a resume
  game.level = 3
  game.enterShop()
  const resumed = new Game()
  resumed.savedRun = game.savedRun
  resumed.resumeRun()
  assert.equal(resumed.player.shieldModule(), null, "still off after a resume")
  assert.ok(resumed.ownsEquipment("shield", mark), "and still owned")

  // and it goes back on for nothing
  const ore = resumed.oreBalance
  resumed.equipmentRows("shield")[0].action(resumed)
  assert.ok(resumed.player.shieldModule(), "back on")
  assert.equal(resumed.oreBalance, ore, "at no cost, since it was never sold")
})

test("a radar taken off leaves the ship seeing only what is close", () => {
  const game = liveGame()
  const far = game.player.sensorRange("rocks")
  assert.equal(far, Infinity, "the hull comes with a set that finds rock anywhere")
  game.equipmentRows("radar").at(-1).action(game)
  assert.equal(game.player.sensorRange("rocks"), CONFIG.SENSOR_FLOOR, "off, it sees to the floor")
  assert.equal(
    [...game.player.modules()].filter((module) => module.kind === "radar").length,
    0,
    "and the set is out of the core rather than merely ignored",
  )
})

test("the laser and the drive cannot be taken off", () => {
  // There is no run without a gun to mine with or an engine to move, so those slots
  // are not marked removable and offer no way to empty them.
  const game = liveGame()
  for (const slot of ["laser", "engine"]) {
    assert.ok(!EQUIPMENT[slot].removable, `${slot} must not be removable`)
    const rows = game.equipmentRows(slot)
    assert.ok(!rows.some((row) => row.name === "NONE"), `${slot} must not offer a NONE row`)
    const fitted = game.fittedEquipment(slot)
    game.removeEquipment(slot)
    assert.equal(game.fittedEquipment(slot), fitted, `${slot} stays fitted`)
  }
})

test("with a special slot open, sideways walks the pop-over to the next box", () => {
  // Working through four slots meant closing the pop-over, stepping along and opening
  // it again. It follows the cursor instead.
  const game = liveGame()
  withSlots(game, 3)
  game.findSpecial("repel")
  game.player.equip(1, "repel")
  game.oreBalance = 400
  game.enterShop()
  game.shopSelection = game.slotsRow
  game.shopSlot = 0
  game.doShopAction()
  assert.equal(game.slotMenuTitle(), SPECIAL_TYPES.oreMagnet.label, "opened on the first box")

  game.menuAdjust(1)
  assert.ok(game.slotMenu, "still open")
  assert.equal(game.shopSlot, 1)
  assert.equal(game.slotMenuTitle(), SPECIAL_TYPES.repel.label, "and showing the next box")
  assert.equal(game.slotMenu.selection, 0, "starting at the top of the new list")

  // it stops at the end rather than wrapping: the row is a row of boxes, not a loop
  game.menuAdjust(1)
  assert.equal(game.shopSlot, 2)
  game.menuAdjust(1)
  assert.equal(game.shopSlot, 2, "the last box is the last one")
  game.menuAdjust(-1)
  assert.equal(game.shopSlot, 1)

  // and the shop behind it must not move while it is open
  const row = game.shopSelection
  game.menuAdjust(1)
  assert.equal(game.shopSelection, row)
})

test("a fly-out opened from a shop row has nothing beside it to walk to", () => {
  const game = liveGame()
  game.enterShop()
  game.shopSelection = equipmentRowIndex(game, "engine")
  game.doShopAction()
  const before = { ...game.slotMenu }
  game.menuAdjust(1)
  game.menuAdjust(-1)
  assert.deepEqual({ ...game.slotMenu }, before, "sideways does nothing on an equipment menu")
  assert.equal(game.shopSelection, equipmentRowIndex(game, "engine"), "and the shop stays put")
})

// ---- control bindings -----------------------------------------------------

test("the default bindings are the controls the game shipped with", () => {
  const game = new Game()
  assert.deepEqual(game.bindings.keys.thrust, ["KeyW"])
  assert.deepEqual(game.bindings.keys.fire, ["Space"])
  assert.deepEqual(game.bindings.keys.slot1, ["Digit1", "Numpad1"])
  assert.equal(game.bindings.buttons.thrust, 7)
  assert.equal(game.bindings.buttons.slot1, 0)
  // turning is a stick on a pad, so there is nothing to bind for it there
  assert.equal(game.bindings.buttons.turnLeft, undefined)
})

test("a rebound key flies the ship and the old one stops", () => {
  const game = liveGame()
  game.bindings.keys.thrust = ["KeyI"]
  game.pressedKeys.add("KeyW")
  game.advance(1 / 60)
  assert.equal(game.player.thrusting, false, "the old key must do nothing")
  game.pressedKeys.clear()
  game.pressedKeys.add("KeyI")
  game.advance(1 / 60)
  assert.equal(game.player.thrusting, true, "the new one flies it")
})

test("a rebound fire key still fires on release", () => {
  const game = liveGame()
  game.asteroids = [new Asteroid({ vertices: square(600, 320, 60) })]
  game.bindings.keys.fire = ["KeyJ"]
  game.player.mainWeapon.charge = WEAPON_TYPES.playerLaserMk1.chargeMax
  game.player.mainWeapon.cooldown = 0
  const shots = game.stats.shots
  game.onKeyUp({ code: "KeyJ" })
  assert.equal(game.stats.shots, shots + 1, "release on the bound key shoots")
})

test("a rebound slot key uses that slot", () => {
  const game = liveGame()
  withSlots(game, 2)
  game.player.equip(0, "refuel")
  game.player.equip(1, "repel")
  game.bindings.keys.slot2 = ["KeyN"]
  game.onKeyDown({ code: "KeyN", preventDefault() {} })
  game.onKeyUp({ code: "KeyN" })
  assert.ok(game.player.items[1].cooldown > 0, "the second slot was the one used")
  assert.equal(game.player.items[0].cooldown, 0, "and only that one")
})

test("capturing a key takes it off whatever else held it", () => {
  const game = new Game()
  game.beginRebind("keys", "thrust")
  assert.equal(game.captureBinding("keys", "KeyS"), true, "the press is consumed")
  assert.deepEqual(game.bindings.keys.thrust, ["KeyS"])
  assert.deepEqual(game.bindings.keys.reverse, [], "reverse lost the key it shared")
  assert.equal(game.rebinding, null, "and the row stops waiting")
})

test("a reserved key is refused and the row keeps waiting", () => {
  const game = new Game()
  for (const code of ["KeyP", "Enter"]) {
    game.beginRebind("keys", "thrust")
    assert.equal(game.captureBinding("keys", code), true, `${code} is swallowed`)
    assert.deepEqual(game.bindings.keys.thrust, ["KeyW"], `${code} must not be bound`)
    assert.ok(game.rebinding, "and the row is still waiting")
  }
})

test("escape abandons a rebind", () => {
  const game = new Game()
  game.beginRebind("keys", "thrust")
  assert.equal(game.captureBinding("keys", "Escape"), true)
  assert.equal(game.rebinding, null)
  assert.deepEqual(game.bindings.keys.thrust, ["KeyW"], "unchanged")
})

test("a key press is not acted on while a row is waiting for it", () => {
  const game = liveGame()
  game.paused = true
  game.beginRebind("keys", "thrust")
  game.onKeyDown({ code: "KeyI", preventDefault() {} })
  assert.deepEqual(game.bindings.keys.thrust, ["KeyI"], "bound")
  assert.equal(game.pressedKeys.has("KeyI"), false, "and not also held as a control")
})

test("resetting bindings puts every control back", () => {
  const game = new Game()
  game.bindings.keys.thrust = ["KeyI"]
  game.bindings.buttons.fire = 11
  game.resetBindings()
  assert.deepEqual(game.bindings.keys.thrust, ["KeyW"])
  assert.equal(game.bindings.buttons.fire, 6)
})

test("a binding reads in the menu the way a player would say it", () => {
  const game = new Game()
  assert.equal(game.bindingLabel("keys", "thrust"), "W")
  assert.equal(game.bindingLabel("keys", "fire"), "SPACE")
  assert.equal(game.bindingLabel("keys", "turretLeft"), "LEFT")
  assert.equal(game.bindingLabel("keys", "slot1"), "1 / NUM 1")
  assert.equal(game.bindingLabel("buttons", "thrust"), "BUTTON 7")
  assert.equal(game.bindingLabel("buttons", "turnLeft"), "-", "nothing bound reads as a dash")
})

test("the controls page offers every bindable control, in device sections", () => {
  const game = liveGame()
  game.toggleOptions()
  const root = game.pauseMenu()
  const controls = root.find((row) => row.name === "CONTROLS")
  assert.ok(controls, "the pause menu offers a way in")
  controls.action(game)
  assert.equal(game.pausePage, "controls")
  assert.equal(game.pauseSelection, 0, "and lands the cursor at the top")

  const rows = game.pauseMenu()
  const sections = [...new Set(rows.map((row) => row.section).filter(Boolean))]
  assert.deepEqual(
    sections,
    BINDING_DEVICES.map((d) => d.name),
  )
  for (const device of BINDING_DEVICES) {
    const offered = rows.filter((row) => row.section === device.name).map((row) => row.name)
    const expected = BINDABLE_CONTROLS.filter((c) => c.defaults[device.id] !== undefined).map(
      (c) => c.name,
    )
    assert.deepEqual(offered, expected, `${device.name} section`)
  }
  assert.ok(rows.some((row) => row.name === "RESET TO DEFAULTS"))
  assert.ok(rows.some((row) => row.name === "BACK"))
})

test("BACK returns to the root page", () => {
  const game = liveGame()
  game.toggleOptions()
  game.openPausePage("controls")
  const back = game.pauseMenu().find((row) => row.name === "BACK")
  back.action(game)
  assert.equal(game.pausePage, "root")
  assert.ok(game.pauseMenu().some((row) => row.name === "RESUME"))
})

test("choosing a control row waits for a key, and the row says so", () => {
  const game = liveGame()
  game.toggleOptions()
  game.openPausePage("controls")
  const row = game.pauseMenu().find((r) => r.section === "KEYBOARD" && r.name === "THRUST")
  assert.equal(row.waiting(), null, "not waiting until it is chosen")
  row.action(game)
  assert.equal(row.waiting(), "PRESS A KEY")
  // the gamepad row for the same control is not the one waiting
  const padRow = game.pauseMenu().find((r) => r.section === "GAMEPAD" && r.name === "THRUST")
  assert.equal(padRow.waiting(), null)
})

test("the cursor holds still while a row waits for its key", () => {
  const game = liveGame()
  game.toggleOptions()
  game.openPausePage("controls")
  game.pauseSelection = 3
  game.pauseMenu()[3].action(game)
  game.menuMove(1)
  assert.equal(game.pauseSelection, 3, "moving is refused so the input lands on the binding")
})

test("resetting from the menu restores every control and asks first", () => {
  const game = liveGame()
  game.bindings.keys.thrust = ["KeyI"]
  game.toggleOptions()
  game.openPausePage("controls")
  const rows = game.pauseMenu()
  const reset = rows.findIndex((row) => row.name === "RESET TO DEFAULTS")
  game.pauseSelection = reset
  game.menuConfirm()
  assert.equal(game.pauseConfirming, "RESET TO DEFAULTS", "it asks once")
  assert.deepEqual(game.bindings.keys.thrust, ["KeyI"], "and changes nothing yet")
  game.menuConfirm()
  assert.deepEqual(game.bindings.keys.thrust, ["KeyW"], "the second press does it")
})

test("closing the pause menu leaves the controls page behind", () => {
  const game = liveGame()
  game.toggleOptions()
  game.openPausePage("controls")
  game.beginRebind("keys", "thrust")
  game.toggleOptions() // close
  game.toggleOptions() // and reopen
  assert.equal(game.pausePage, "root", "reopens at the root")
  assert.equal(game.rebinding, null, "with nothing left waiting")
})

test("escape backs out of the page, and cancels a wait before it does", () => {
  const game = liveGame()
  game.toggleOptions()
  game.openPausePage("controls")
  game.beginRebind("buttons", "thrust")
  game.onKeyDown({ code: "Escape", preventDefault() {} })
  assert.equal(game.rebinding, null, "the wait is abandoned")
  assert.equal(game.pausePage, "controls", "without leaving the page")
  game.onKeyDown({ code: "Escape", preventDefault() {} })
  assert.equal(game.pausePage, "root", "a second press backs out")
  game.onKeyDown({ code: "Escape", preventDefault() {} })
  assert.equal(game.paused, false, "and a third closes the menu")
})

test("left and right cross between the binding columns", () => {
  const game = liveGame()
  game.toggleOptions()
  game.openPausePage("controls")
  const rows = game.pauseMenu()

  // The nth row of one column becomes the nth row of the other. Nothing cleverer:
  // the columns do not hold the same controls, and a row that moved to wherever its
  // own control happened to sit would jump about unpredictably.
  const keyboard = rows.filter((row) => row.section === "KEYBOARD")
  const gamepad = rows.filter((row) => row.section === "GAMEPAD")
  for (let n = 0; n < gamepad.length; n++) {
    game.pauseSelection = rows.indexOf(keyboard[n])
    assert.equal(game.menuAdjust(1), true, "the press is handled")
    assert.equal(rows[game.pauseSelection], gamepad[n], `row ${n} crosses to row ${n}`)
    game.menuAdjust(-1)
    assert.equal(rows[game.pauseSelection], keyboard[n], `and back to row ${n}`)
  }
})

test("crossing to a shorter column lands on its last row", () => {
  const game = liveGame()
  game.toggleOptions()
  game.openPausePage("controls")
  const rows = game.pauseMenu()
  const keyboard = rows.filter((row) => row.section === "KEYBOARD")
  const gamepad = rows.filter((row) => row.section === "GAMEPAD")
  assert.ok(keyboard.length > gamepad.length, "the keyboard column must be the longer one")
  for (let n = gamepad.length; n < keyboard.length; n++) {
    game.pauseSelection = rows.indexOf(keyboard[n])
    game.menuAdjust(1)
    assert.equal(
      rows[game.pauseSelection],
      gamepad[gamepad.length - 1],
      `keyboard row ${n} has no opposite number, so it clamps`,
    )
  }
})

test("there is nothing to the left of the first column or the right of the last", () => {
  const game = liveGame()
  game.toggleOptions()
  game.openPausePage("controls")
  const rows = game.pauseMenu()
  game.pauseSelection = 0
  assert.equal(game.menuAdjust(-1), false, "left of the first column does nothing")
  assert.equal(game.pauseSelection, 0)
  game.pauseSelection = rows.findIndex((row) => row.section === "GAMEPAD")
  assert.equal(game.menuAdjust(1), false, "and right of the last")
})

test("the rows below the columns pair up on their own line", () => {
  const game = liveGame()
  game.toggleOptions()
  game.openPausePage("controls")
  const rows = game.pauseMenu()
  const at = (name) => rows.findIndex((row) => row.name === name)
  // BACK sits left and RESET TO DEFAULTS right, so they cross as the columns do
  game.pauseSelection = at("BACK")
  assert.equal(game.menuAdjust(1), true)
  assert.equal(rows[game.pauseSelection].name, "RESET TO DEFAULTS")
  assert.equal(game.menuAdjust(-1), true)
  assert.equal(rows[game.pauseSelection].name, "BACK")
  // and there is nothing beyond either end of the pair
  assert.equal(game.menuAdjust(-1), false, "nothing to the left of BACK")
  game.pauseSelection = at("RESET TO DEFAULTS")
  assert.equal(game.menuAdjust(1), false, "nor to the right of RESET")
})

test("a sideways press holds the cursor still on a page laid out in one column", () => {
  // The pairing above is for the line beneath the columns. The root page is one
  // column all the way down, where a sideways press used to walk the cursor
  // onto the next row - including, from CONTROLS, straight onto RESET PROGRESS.
  const game = liveGame()
  game.toggleOptions()
  const rows = game.pauseMenu()
  assert.ok(
    !rows.some((row) => row.section),
    "the root page must have no columns for this to be the case being tested",
  )
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].adjust) {
      continue // a row with a scale is what left and right are for
    }
    for (const step of [1, -1]) {
      game.pauseSelection = i
      assert.equal(game.menuAdjust(step), false, `"${rows[i].name}" has nothing to adjust`)
      assert.equal(game.pauseSelection, i, `"${rows[i].name}" must hold the cursor still`)
    }
  }
})

test("a waiting row swallows left and right too", () => {
  const game = liveGame()
  game.toggleOptions()
  game.openPausePage("controls")
  game.pauseSelection = 2
  game.beginRebind("keys", "turnRight")
  assert.equal(game.menuAdjust(1), true, "consumed, so it is not read as a binding")
  assert.equal(game.pauseSelection, 2, "and the cursor holds still")
})

test("the volume row still adjusts, on the page that has it", () => {
  const game = liveGame()
  game.toggleOptions()
  const rows = game.pauseMenu()
  game.pauseSelection = rows.findIndex((row) => row.name === "VOLUME")
  const before = game.settings.volume
  assert.equal(game.menuAdjust(-1), true)
  assert.ok(game.settings.volume < before, "left turned it down")
})

// ---- a ship is a shape, two numbers and what is bolted to it ---------------

test("every ship type states only its shape, its two stats and its loadout", () => {
  // The derived settings must not be written down as well, or the relationships
  // stop being the thing that decides them and quietly become decoration.
  const derived = [
    "accel",
    "maxSpeed",
    "turnRate",
    "drag",
    "hull",
    "boundRadius",
    "bubbleRadius",
    "hullWidth",
    "rockContact",
  ]
  for (const [name, type] of Object.entries(SHIP_TYPES)) {
    for (const field of ["mass", "armour"]) {
      assert.equal(typeof type[field], "number", `${name} must state ${field}`)
    }
    // Thrust is not a number on the type any more: it is whatever is bolted on.
    assert.equal(type.power, undefined, `${name} must not state its own thrust`)
    assert.ok(thrustOf(type) > 0, `${name} must have an engine to push it`)
    for (const field of derived) {
      assert.equal(typeof type[field], "number", `${name} must end up with ${field}`)
      assert.ok(Number.isFinite(type[field]), `${name}.${field} is ${type[field]}`)
    }
  }
})

test("the ship stats follow from the shape, the numbers and what is fitted", () => {
  const k = SHIP_SCALARS
  const reach = (outline) => Math.max(...outline.map(([x, y]) => Math.hypot(x, y)))
  for (const [name, t] of Object.entries(SHIP_TYPES)) {
    const thrust = thrustOf(t)
    // Laden, not stated: `mass` is the bare hull and everything divides by what the
    // hull actually weighs with its loadout aboard.
    const laden = ladenMass(t)
    assert.ok(laden > t.mass, `${name} must weigh more with its loadout on`)
    assert.equal(t.laden, laden, `${name} reports what it weighs`)
    assert.ok(Math.abs(t.accel - thrust / laden) < 1e-9, `${name} accel`)
    assert.ok(Math.abs(t.maxSpeed - t.accel * k.speedPerAccel) < 1e-9, `${name} maxSpeed`)
    // `handling` is the one sanctioned trim, a plain multiplier on the turn the shape
    // implies: the darts state 0.8, so they come about like the player rather than better.
    assert.ok(
      Math.abs(
        t.turnRate -
          (torqueOf(t) * k.turnPerReach * (t.handling ?? 1)) / (laden * reach(t.outline)),
      ) < 1e-9,
      `${name} turnRate`,
    )
    assert.ok(Math.abs(t.drag - (1 - k.dragPerMass / laden)) < 1e-9, `${name} drag`)
    assert.ok(
      Math.abs(t.bubbleRadius - reach(t.outline) * k.shieldClearance) < 1e-9,
      `${name} bubbleRadius`,
    )
    // the bubble has to clear the hull it is drawn around, whatever the shape
    assert.ok(t.bubbleRadius > reach(t.outline), `${name} bubble must stand clear of the outline`)
  }
})

test("a new ship needs a shape, two numbers, an engine and a core, and nothing else", () => {
  // Same machinery the shipped types go through, so this cannot pass by way of
  // a value written down somewhere. What pushes it and what turns it are both
  // fitted: a drive on a hardpoint and a set of thrusters in the core, which is
  // also where its cell comes from.
  const design = {
    outline: [
      [30, 0],
      [-20, -16],
      [-12, 0],
      [-20, 16],
    ],
    colour: PALETTE.rival.hull,
    mass: 2,
    armour: 0.8,
    hardpoints: [
      { local: [0, 0], role: "core" },
      { local: [-20, 0], role: "engine" },
    ],
    loadout: [
      { hp: 0, core: "prospectorCore", fitted: { thruster: "attitudeJets" } },
      { hp: 1, engine: "pulseDrive" },
    ],
    spawn: { fromSector: 5, chance: 0.5, maxConcurrent: 1 },
    lifeTime: [20, 30],
    debrisMaterial: SHIP_PLATING,
    debris: { particles: 30, speed: 250, ring: 20, shake: 12 },
    killScore: 500,
    blastScore: 250,
    oreDrop: 6,
  }
  SHIP_TYPES.corvette = deriveShipStats(design)
  try {
    const game = liveGame()
    game.player.x = -9000
    game.player.y = -9000
    const ship = plainRival(300, 320, "corvette")
    game.rivals = [ship]
    for (const field of ["accel", "maxSpeed", "turnRate", "drag", "hull", "energyMax", "regen"]) {
      assert.ok(Number.isFinite(ship[field]), `corvette ${field} is ${ship[field]}`)
      assert.ok(ship[field] > 0, `corvette ${field} is ${ship[field]}`)
    }
    assert.ok(ship.shieldRadius() > ship.boundRadius, "its bubble clears its hull")
    // and it flies
    const startX = ship.x
    for (let i = 0; i < 120; i++) {
      game.advance(1 / 60)
    }
    assert.notEqual(ship.x, startX, "it moves under its own power")
  } finally {
    delete SHIP_TYPES.corvette
  }
})

test("the player's speed is its drive's, through the same relationship as any hull", () => {
  const game = liveGame()
  const scalar = SHIP_SCALARS.speedPerAccel
  const speedOn = (id) => {
    withEquipment(game, "engine", id)
    return { accel: game.player.accel, top: game.player.maxSpeed }
  }
  const miner = speedOn("minerDrive")
  assert.equal(
    miner.accel,
    ENGINE_TYPES.minerDrive.thrust / game.player.mass,
    "thrust over what the ship weighs with everything aboard",
  )
  assert.ok(game.player.mass > PLAYER_TYPE.mass, "which is more than the bare hull")
  assert.ok(Math.abs(miner.top - miner.accel * scalar) < 1e-9, "and top speed follows from it")

  // The drive that can push backwards makes less thrust, so it costs top speed as
  // well as acceleration: the trade is in the numbers and not in a rule.
  const vectored = speedOn("vectoredDrive")
  assert.ok(vectored.accel < miner.accel, "the vectored drive accelerates less hard")
  assert.ok(vectored.top < miner.top, "and tops out lower")
  assert.ok(
    Math.abs(vectored.top / miner.top - vectored.accel / miner.accel) < 1e-9,
    "in the same proportion, since one relationship decides both",
  )

  // And the clamp the ship is flown against is that number, not a constant.
  assert.equal(CONFIG.MAX_SPEED, undefined, "no global top speed is left to disagree with it")
  withEquipment(game, "engine", "minerDrive")
  game.player.vx = 9000
  game.player.vy = 0
  game.advance(1 / 60)
  assert.ok(
    Math.hypot(game.player.vx, game.player.vy) <= game.player.maxSpeed + 1e-9,
    "a hull thrown past its top speed is pulled back to it",
  )
})

// Every polyline a ship draws. A flame is the open three-point one: a rival's hull
// is stroked in the same colour as its plume, so the colour cannot tell them apart
// and the shape has to.
function polysDrawn(entity, game) {
  const polys = []
  const renderer = {
    strokePoly: (points, opts = {}) =>
      polys.push({ points, colour: opts.color, closed: opts.closed }),
    line() {},
    circle() {},
    rect() {},
    point() {},
    text() {},
  }
  entity.draw(renderer, game)
  return polys
}

test("the thruster flame is the engine's, so any hull with one burns", () => {
  const game = liveGame()
  const flameOf = (entity) => {
    // Ten frames, since the flame's length flickers and one frame could be any of
    // them: the longest is what the drive states plus its full flicker.
    let longest = null
    for (let i = 0; i < 10; i++) {
      for (const poly of polysDrawn(entity, game)) {
        if (poly.closed !== false || poly.points.length !== 3) {
          continue
        }
        const reach = Math.max(
          ...poly.points.map((p) => Math.hypot(p.x - entity.x, p.y - entity.y)),
        )
        if (!longest || reach > longest) {
          longest = reach
        }
      }
    }
    return longest
  }

  // The player only burns while the drive is lit.
  game.player.thrusting = false
  assert.equal(flameOf(game.player), null, "an idle drive shows nothing")
  game.player.thrusting = true
  assert.ok(flameOf(game.player) > 0, "a lit one does")

  // And a rival, which was drawing no flame at all: the shape was written into the
  // player's own draw method rather than into the engine both of them mount.
  const rival = new RivalShip(400, 300, "scout", SHIP_TYPES.scout.loadout)
  assert.ok(flameOf(rival) > 0, "a rival's drive burns too")

  // An engine that states no flame draws none, so a drive can show only its plume.
  const flame = ENGINE_TYPES.pulseDrive.flame
  delete ENGINE_TYPES.pulseDrive.flame
  try {
    const dark = new RivalShip(400, 300, "scout", SHIP_TYPES.scout.loadout)
    assert.equal(flameOf(dark), null, "no flame block, no flame")
  } finally {
    ENGINE_TYPES.pulseDrive.flame = flame
  }
})

test("a laden ship handles worse than a bare one", () => {
  // The reason mass is on the equipment at all: a ship fitted with everything the shop
  // sells is carrying it, and carrying it costs acceleration, top speed and turn in
  // the same proportion, since all three divide by mass.
  const game = liveGame()
  const bare = {
    mass: game.player.mass,
    accel: game.player.accel,
    top: game.player.maxSpeed,
    turn: game.player.turnRate,
  }
  assert.equal(bare.mass, 1, "the hull plus what it launches with is the unit of mass")

  withEquipment(game, "shield", "playerShieldMk1")
  assert.ok(game.player.mass > bare.mass, "a shield is something to carry")
  assert.ok(game.player.accel < bare.accel, "so the ship accelerates less hard")
  assert.ok(game.player.maxSpeed < bare.top, "tops out lower")
  assert.ok(game.player.turnRate < bare.turn, "and comes about slower")
  // The same fraction off each, because all three divide by the same mass.
  const cost = 1 - game.player.accel / bare.accel
  assert.ok(Math.abs(1 - game.player.maxSpeed / bare.top - cost) < 1e-9, "top speed pays the same")
  assert.ok(Math.abs(1 - game.player.turnRate / bare.turn - cost) < 1e-9, "and so does the turn")

  // A mark that is a better emitter rather than a bigger one weighs the same, so
  // climbing a ladder is never a handling downgrade.
  const laden = game.player.mass
  withEquipment(game, "shield", "playerShieldMk4")
  assert.equal(game.player.mass, laden, "a better mark of the same thing weighs the same")
})

test("the quicker thrusters more than pay for a full ship's worth of mass", () => {
  // Which is what makes them worth buying rather than a curiosity: a heavy build is
  // exactly the build that wants them.
  const game = liveGame()
  const bare = game.player.turnRate
  for (const [slot, id] of [
    ["shield", "playerShieldMk4"],
    ["turret", "defenseFlak"],
    ["radar", "surveyMk4"],
    ["laser", "playerLaserMk5"],
  ]) {
    withEquipment(game, slot, id)
  }
  const laden = game.player.turnRate
  assert.ok(laden < bare, "a full ship comes about slower than an empty one")
  withEquipment(game, "thruster", "vectorJets")
  const recovered = (game.player.turnRate - laden) / (bare - laden)
  assert.ok(
    recovered > 0.6,
    `the quicker set should win back most of the turn a full kit costs, won back ${(recovered * 100).toFixed(0)}%`,
  )
  // And not all of it: an upgrade that erased the cost of carrying things would make
  // the mass a formality for anyone who bought it.
  assert.ok(recovered < 1, "without cancelling it outright")
})

test("a rival that rolled an extra gun carries the weight of it", () => {
  // A rival works out how it flies from what it turned up with, not from its type, so
  // the arms it rolled are aboard for the arithmetic as well as for the shooting.
  const design = SHIP_TYPES.seeker
  const plain = plainRival(500, 320, "seeker")
  const armed = plainRival(500, 320, "seeker", [...design.loadout, design.arms.gun])
  assert.ok(
    Math.abs(plain.mass - design.laden) < 1e-9,
    "an unrolled one weighs what its design says",
  )
  assert.ok(armed.mass > plain.mass, "and one carrying a gun weighs more")
  assert.ok(armed.accel < plain.accel, "which costs it acceleration")
  assert.ok(armed.turnRate < plain.turnRate, "and turn")
})

test("what brings a hull about is its thrusters, and never its drive", () => {
  // The whole point of the split: a nozzle pointed backwards pushes backwards. A
  // frigate has thrust to spare and no way to use it sideways, so a bigger drive must
  // buy speed and nothing else.
  const base = {
    outline: SHIP_TYPES.scout.outline,
    mass: 1,
    armour: 1,
    hardpoints: [
      { local: [0, 0], role: "core" },
      { local: [-14, 0], role: "engine" },
    ],
  }
  const withParts = (engine, thruster) =>
    deriveShipStats({
      ...base,
      loadout: [
        { hp: 0, core: "prospectorCore", fitted: thruster ? { thruster } : {} },
        { hp: 1, engine },
      ],
    })

  const light = withParts("pulseDrive", "attitudeJets")

  // A drive of the same weight and three times the thrust, so thrust is the only
  // thing that differs: it buys acceleration and not one degree of turn. Fitting a
  // *heavier* drive does slow the turn, but through its mass, which is the whole
  // point of the mass and not a back door for thrust.
  ENGINE_TYPES.testDrive = { ...ENGINE_TYPES.pulseDrive, thrust: 300 }
  try {
    const strong = withParts("testDrive", "attitudeJets")
    assert.ok(strong.accel > light.accel * 2.9, "three times the thrust accelerates it harder")
    assert.equal(strong.turnRate, light.turnRate, "and turns the hull not one bit faster")
  } finally {
    delete ENGINE_TYPES.testDrive
  }

  const quick = withParts("pulseDrive", "gimbalRing")
  assert.ok(quick.turnRate > light.turnRate, "a better set of thrusters is what turns it faster")
  assert.ok(quick.accel < light.accel, "and pays for it in speed, because it weighs something")

  // A hull with none fitted cannot steer at all, which is what makes them equipment
  // rather than a number every hull happens to have.
  assert.equal(withParts("pulseDrive", null).turnRate, 0, "no thrusters, no turn")
})

test("a frigate sweeps where the player pivots", () => {
  const game = liveGame()
  assert.ok(
    SHIP_TYPES.frigate.turnRate < game.player.turnRate,
    `frigate ${SHIP_TYPES.frigate.turnRate.toFixed(2)} vs player ${game.player.turnRate.toFixed(2)}`,
  )
  // Not by a whisker: it has the most torque of any hull in the game and is still the
  // slowest round, because torque works against mass and reach.
  assert.ok(torqueOf(SHIP_TYPES.frigate) > 150, "the frigate carries the heaviest set of thrusters")
  assert.ok(SHIP_TYPES.frigate.turnRate < 0.5, "and comes about in its own time regardless")
})

test("the shop's other set of thrusters is quicker, and swaps back", () => {
  const game = liveGame()
  const stock = game.player.turnRate
  withEquipment(game, "thruster", "vectorJets")
  assert.ok(game.player.turnRate > stock, "the quicker set turns the ship faster")
  // A choice rather than a ladder, so what was bought first is still there to go back
  // to: a twitchier ship is not simply a better one.
  assert.equal(EQUIPMENT.thruster.ladder, undefined, "the two are alternatives, not a climb")
  withEquipment(game, "thruster", "gimbalRing")
  assert.equal(game.player.turnRate, stock, "and the yard's set is still fitted-able")
})

test("stating a setting on a type keeps it, for tuning one ship", () => {
  const design = { ...SHIP_TYPES.scout, armour: 1, drag: 0.123, hull: 99 }
  delete design.accel
  const tuned = deriveShipStats(design)
  assert.equal(tuned.drag, 0.123, "a stated value wins")
  assert.equal(tuned.hull, 99)
  assert.ok(
    Math.abs(tuned.accel - thrustOf(SHIP_TYPES.scout) / ladenMass(design)) < 1e-9,
    "the rest still derives",
  )
  // And a stated one is remembered as stated, since a ship refitted in flight has to
  // recompute what was derived and leave alone what was written down. The others are
  // there too because this design was spread from an already-derived type: a derived
  // field reads back as a stated one, which is what makes re-deriving safe.
  assert.equal(tuned.flightOverrides.drag, 0.123)
})

test("sector plans follow PROGRESSION", () => {
  const game = new Game()
  const early = game.planLevel(1)
  assert.equal(early.rivals, 0, "no rivals in sector 1")
  assert.equal(early.specials, false, "and no specials yet")
  const late = game.planLevel(40)
  assert.equal(late.spawns.length, PROGRESSION.rocks.max, "the rock count is capped")
  assert.equal(late.rivals, PROGRESSION.rivals.max, "as is the rival count")
  assert.equal(late.rivalInterval, PROGRESSION.rivals.intervalMin, "and the arrival gap")
  assert.ok(
    late.spawns.some((s) => Object.keys(s.traits).length > 0),
    "late rocks carry hazards",
  )
})

// The player's nose turret, fitted from the shop.
function withTurret(game) {
  withEquipment(game, "turret", "defenseBlaster")
  const hp = game.player.hardpoints.find(
    (entry) => entry.module && entry.module.kind === "weapon" && entry.role === "aux",
  )
  assert.ok(hp, "the fitting should have mounted a weapon on the aux hardpoint")
  return hp.module
}

test("the defense turret shoots at rivals and leaves rocks alone", () => {
  // A bare rock has no hull to lose and is destroyed by being cut, so a turret
  // spent on one achieves nothing while pointing away from what it could hurt.
  const atRock = liveGame()
  atRock.player.x = 400
  atRock.player.y = 320
  atRock.player.angle = 0
  withTurret(atRock)
  atRock.asteroids = [new Asteroid({ vertices: square(560, 320, 70) })]
  for (let i = 0; i < 240; i++) {
    atRock.player.energy = atRock.player.energyMax
    atRock.advance(1 / 60)
  }
  assert.equal(atRock.projectiles.length, 0, "it must not spend itself on a rock")

  const atRival = liveGame()
  atRival.player.x = 400
  atRival.player.y = 320
  atRival.player.angle = 0
  withTurret(atRival)
  atRival.asteroids = [new Asteroid({ vertices: square(400, -600, 60) })] // keep the sector live
  const rival = plainRival(600, 320, "scout")
  atRival.rivals = [rival]
  let fired = false
  for (let i = 0; i < 240 && !fired; i++) {
    atRival.player.energy = atRival.player.energyMax
    rival.x = 600
    rival.y = 320
    atRival.advance(1 / 60)
    fired = atRival.projectiles.length > 0 || rival.dead
  }
  assert.ok(fired, "a rival in range must draw fire")
})

test("a beam aimed at a target carries past it, so it can cut", () => {
  // The turret used to end its beam `overshoot` past the target's centre, which
  // is inside anything bigger than the overshoot: one crossing, which is a graze
  // and never severs. It cut rocks of radius 30 and none at all of radius 90,
  // and a sector spawns 72 to 100.
  const original = WEAPON_TYPES.defenseBlaster
  WEAPON_TYPES.defenseBlaster = {
    kind: "beam",
    damage: 30,
    energy: 4,
    reload: 0.2,
    range: 340,
    overshoot: 42,
    width: 2.4,
    glow: 14,
    colour: PALETTE.player.turret,
  }
  try {
    const game = liveGame()
    game.player.x = 300
    game.player.y = 320
    game.player.angle = 0
    withTurret(game)
    game.asteroids = [new Asteroid({ vertices: square(300, -600, 60) })] // keep the sector live
    // a big unshielded hull, further across than the overshoot
    const target = plainRival(560, 320, "frigate")
    target.angle = 0
    game.rivals = [target]
    assert.ok(
      target.boundRadius > WEAPON_TYPES.defenseBlaster.overshoot,
      "the target must be wider than the overshoot for this to mean anything",
    )
    for (let i = 0; i < 300 && !target.dead; i++) {
      game.player.energy = game.player.energyMax
      target.x = 560
      target.y = 320
      target.vx = 0
      target.vy = 0
      target.angle = 0
      game.advance(1 / 60)
    }
    assert.ok(target.dead, "a beam that carries past its target must cut it apart")
  } finally {
    WEAPON_TYPES.defenseBlaster = original
  }
})

test("a turret's beam is sent past the player, by the default overshoot", () => {
  // The defense turret's side of this rule is covered above with a declared
  // `overshoot`. This is the other caller, and the fall-through when a weapon
  // names none. Measured on the reach the controller asks for, not on the drawn
  // beam: applyBeam clips what is drawn at the first surface that blocks it, so a
  // shielded player would report the distance to the bubble either way.
  const game = withShield(liveGame()) // a rock turret holds fire once the player has died
  const player = game.player
  player.x = 500
  player.y = 500
  assert.equal(WEAPON_TYPES.minerLaser.overshoot, undefined, "this one names no overshoot")

  const rock = new Asteroid({ vertices: square(500, 320, 60) })
  const gun = new Weapon("minerLaser", "turret")
  rock.hardpoints.push({ x: rock.center.x, y: rock.center.y, module: gun })
  rock.refreshEnergy()
  game.asteroids = [rock, new Asteroid({ vertices: square(500, -900, 60) })]

  let asked = 0,
    from = null
  const realEmit = gun.emitBeam.bind(gun)
  gun.emitBeam = (g, host, ax, ay, angle, length) => {
    asked = length
    from = { x: ax, y: ay }
    realEmit(g, host, ax, ay, angle, length)
  }

  for (let frame = 0; frame < 300 && asked === 0; frame++) {
    player.x = 500
    player.y = 500
    player.vx = 0
    player.vy = 0
    player.energy = player.energyMax
    rock.vx = 0
    rock.vy = 0
    rock.spin = 0
    game.advance(1 / 60)
  }
  assert.ok(asked > 0, "the turret should have fired a beam")
  const farSide = Math.hypot(500 - from.x, 500 - from.y) + player.boundRadius
  assert.ok(
    asked > farSide,
    `it asked for ${asked.toFixed(0)}, not past the far side at ${farSide.toFixed(0)}`,
  )
})

test("cutReach carries past a target's far side, by a default or a declared overshoot", () => {
  const target = { boundRadius: 40 }
  const plain = new Weapon("minerLaser", "turret")
  assert.equal(WEAPON_TYPES.minerLaser.overshoot, undefined)
  const byDefault = plain.cutReach(target, 200)
  assert.ok(byDefault > 240, `${byDefault} must clear the far side at 240`)

  // a type naming its own overshoot is honoured instead of the default
  const original = WEAPON_TYPES.minerLaser.overshoot
  WEAPON_TYPES.minerLaser.overshoot = byDefault - 240 + 100
  try {
    assert.equal(new Weapon("minerLaser", "turret").cutReach(target, 200), byDefault + 100)
  } finally {
    WEAPON_TYPES.minerLaser.overshoot = original
  }
})

test("a rock's turrets are spread around it, not stacked on one bearing", () => {
  // Each used to pick its own vertex to sit under, and independent picks put a
  // pair on the same bearing often enough to read as a cluster.
  const trait = HAZARD_TRAITS.map((h) => h.traits.gun).find(Boolean)
  assert.ok(trait, "some hazard should mount guns")
  const gaps = []
  const insideEvery = []
  seeded(4242, () => {
    for (let i = 0; i < 400; i++) {
      const rock = new Asteroid({
        x: 0,
        y: 0,
        radius: 40 + (i % 60),
        traits: { gun: { ...trait, count: [2, 3] } },
      })
      const guns = rock.hardpoints.filter((hp) => hp.module && hp.module.kind === "weapon")
      insideEvery.push(guns.every((hp) => pointInPolygon(hp, rock.vertices)))
      const bearings = guns.map((hp) => Math.atan2(hp.y - rock.center.y, hp.x - rock.center.x))
      for (let a = 0; a < bearings.length; a++) {
        for (let b = a + 1; b < bearings.length; b++) {
          let d = Math.abs(bearings[a] - bearings[b]) % (Math.PI * 2)
          if (d > Math.PI) {
            d = Math.PI * 2 - d
          }
          gaps.push(d)
        }
      }
    }
  })
  assert.ok(gaps.length > 100, "enough pairs to say anything")
  // three guns share the circle, so the tightest honest gap is a third of it
  // less the jitter either side
  const floor = (Math.PI * 2) / 3 - 2 * trait.jitter
  const worst = Math.min(...gaps)
  assert.ok(
    worst > floor * 0.9,
    `closest pair sat ${worst.toFixed(2)} rad apart, floor ${floor.toFixed(2)}`,
  )
  assert.ok(
    insideEvery.every(Boolean),
    "every turret must stay inside the outline, or a cut loses it",
  )
})

// A rock at the middle of the sector carrying one gun at a known place, so a shot
// can be aimed at the gun or away from it.
function rockWithGunAt(game, local) {
  const trait = HAZARD_TRAITS.map((h) => h.traits.gun).find(Boolean)
  const rock = new Asteroid({
    x: 500,
    y: 340,
    radius: 90,
    traits: { gun: { ...trait, count: [1, 1] } },
  })
  const gun = rock.hardpoints.find((hp) => hp.module && hp.module.kind === "weapon")
  gun.x = rock.center.x + local[0]
  gun.y = rock.center.y + local[1]
  game.asteroids = [rock]
  return { rock, gun }
}

const gunsOn = (game) =>
  game.asteroids.reduce(
    (total, rock) =>
      total + rock.hardpoints.filter((hp) => hp.module && hp.module.kind === "weapon").length,
    0,
  )

// A beam of `length` along +x, passing through (500, y).
const beamAcross = (y, length = 900) => ({
  a: { x: 500 - length / 2, y },
  b: { x: 500 + length / 2, y },
  dir: { x: 1, y: 0 },
})

test("a shot lined up through a rock's turret takes it off", () => {
  const game = liveGame()
  const weapon = game.player.mainWeapon

  // Dead on. This used to cut the rock and leave the gun firing on whichever piece
  // its centre landed in, so a turret on a boulder could only be dealt with by
  // cutting the boulder down to fragments small enough to shatter.
  const { gun } = rockWithGunAt(game, [0, -40])
  assert.equal(gunsOn(game), 1, "the rock starts armed")
  game.applyBeam(beamAcross(gun.y), game.player, weapon)
  assert.equal(gunsOn(game), 0, "a shot through the mount leaves no gun on any piece")

  // Forgiving, but not unlimited: past the hitbox the gun rides on.
  for (const [offset, expected] of [
    [CONFIG.AST_TURRET_HITBOX - 3, 0],
    [CONFIG.AST_TURRET_HITBOX + 12, 1],
  ]) {
    const fresh = liveGame()
    const placed = rockWithGunAt(fresh, [0, -40])
    fresh.applyBeam(beamAcross(placed.gun.y + offset), fresh.player, weapon)
    assert.equal(gunsOn(fresh), expected, `a beam ${offset} off the mount`)
  }
})

test("a turret the cut passes through does not ride on either piece", () => {
  // The hitbox covers a beam that reaches the mount. This is the other way a gun
  // ends up on the edge of a piece: a cut close enough to leave the nub hanging off
  // it, which containment alone was happy to let survive.
  // Both cuts run through the rock's middle, which is a cut it is certain to come
  // apart on; what differs is how far the mount sits from that line.
  const clear = liveGame()
  const wide = rockWithGunAt(clear, [0, -40])
  const parts = wide.rock.splitBy(beamAcross(wide.rock.center.y), clear)
  assert.ok(parts && parts.length >= 2, "the rock came apart")
  clear.asteroids = parts
  assert.equal(gunsOn(clear), 1, "a gun well clear of the cut survives on its own piece")

  const near = liveGame()
  const close = rockWithGunAt(near, [0, -(CONFIG.AST_TURRET_CLEARANCE - 1)])
  near.asteroids = close.rock.splitBy(beamAcross(close.rock.center.y), near)
  assert.ok(near.asteroids.length >= 2, "and so did this one")
  assert.equal(gunsOn(near), 0, "one the cut goes through does not")
})

test("hazard traits are gated by sector", () => {
  const game = new Game()
  for (let trial = 0; trial < 200; trial++) {
    assert.deepEqual(game.rollHazardTraits(2), {}, "nothing is armed before sector 3")
    const early = game.rollHazardTraits(3)
    assert.equal(early.gun, undefined, "guns do not appear at sector 3")
    assert.equal(early.shield, undefined, "nor do shields")
  }
})

test("a gun's barrel count follows its rate of fire", () => {
  const rate = (type) => {
    const reload = Array.isArray(type.reload) ? (type.reload[0] + type.reload[1]) / 2 : type.reload
    return 1 / reload
  }
  for (const [name, type] of Object.entries(WEAPON_TYPES)) {
    const barrels = barrelCount(type)
    assert.ok(Number.isInteger(barrels) && barrels >= 1, `${name} got ${barrels} barrels`)
    if (type.kind !== "projectile") {
      assert.equal(barrels, 1, `${name} is a beam, so it has an emitter and not barrels`)
      continue
    }
    // one barrel per BARREL_CYCLE_RATE rounds a second, rounded up
    assert.equal(
      barrels,
      Math.min(4, Math.ceil(rate(type) / CONFIG.BARREL_CYCLE_RATE)),
      `${name} fires ${rate(type).toFixed(2)}/s`,
    )
  }
  // the fastest gun must actually need more than one, or the rule is decoration
  const fastest = Object.values(WEAPON_TYPES)
    .filter((t) => t.kind === "projectile")
    .sort((a, b) => rate(b) - rate(a))[0]
  assert.ok(barrelCount(fastest) > 1, "the fastest projectile gun should need more than one barrel")
  // and a type may say so itself
  assert.equal(barrelCount({ ...fastest, barrels: 3 }), 3)
})

test("a weapon carries its barrel count, for the view to draw", () => {
  const flak = Object.keys(WEAPON_TYPES).find(
    (name) => barrelCount(WEAPON_TYPES[name]) > 1 && WEAPON_TYPES[name].kind === "projectile",
  )
  assert.ok(flak, "some gun should be fast enough to need two barrels")
  const weapon = new Weapon(flak, "turret")
  assert.equal(weapon.barrels, barrelCount(WEAPON_TYPES[flak]))
  assert.equal(new Weapon("blaster", "turret").barrels, 1)
})

test("a rock can be armed with the fast gun as well as the slow one", () => {
  // A fast gun joins the pool at a later sector than the slow one, so find where
  // one arrives and fly a sector well past it.
  const armed = HAZARD_TRAITS.filter((hazard) => hazard.traits.gun)
  const isFast = (name) => barrelCount(WEAPON_TYPES[name]) > 1
  const pool = armed.flatMap((hazard) => hazard.traits.gun.guns)
  const fastGuns = pool.filter((gun) => isFast(gun.weapon))
  const pooled = [...new Set(pool.map((gun) => gun.weapon))]
  assert.ok(fastGuns.length > 0, `the rock pools ${JSON.stringify(pooled)} should offer a fast gun`)
  const fast = [...new Set(fastGuns.map((gun) => gun.weapon))]
  const sector =
    Math.max(
      ...armed.map((hazard) => hazard.fromSector),
      ...fastGuns.map((gun) => gun.fromSector ?? 0),
    ) + 5

  // and one actually turns up, armed and firing, in a real sector
  let sawFast = false
  let rounds = 0
  seeded(9100, () => {
    const game = new Game()
    game.startNewGame()
    game.startLevel(sector)
    game.phase = "play"
    withShield(game) // and it holds fire again once the player has died
    const player = game.player
    player.warp = 1
    player.warpTarget = 1
    player.warpHold = 0
    player.invincible = 0 // a turret holds fire while the player is invincible
    for (const rock of game.asteroids) {
      for (const hp of rock.hardpoints) {
        if (hp.module && fast.includes(hp.module.typeName)) {
          sawFast = true
        }
      }
    }
    for (let i = 0; i < 600; i++) {
      player.energy = player.energyMax // kept alive, so the rocks keep firing
      game.advance(1 / 60)
      rounds = Math.max(rounds, game.projectiles.length)
      if (game.phase !== "play") {
        break
      }
    }
  })
  assert.ok(sawFast, "a sector should arm some rock with it")
  assert.ok(rounds > 0, "and it should be firing")
})

test("a gun pool always has something to roll, at every sector it is offered", () => {
  const game = new Game()
  for (const hazard of HAZARD_TRAITS.filter((entry) => entry.traits.gun)) {
    for (let sector = hazard.fromSector; sector <= hazard.fromSector + 40; sector++) {
      const guns = game.gunsForSector(hazard.traits.gun, sector)
      assert.ok(guns.length > 0, `an armed rock at sector ${sector} has nothing to mount`)
    }
  }
})

test("a gun joins the pool at its own sector, and the rocks are no more armed for it", () => {
  const game = new Game()
  const pool = HAZARD_TRAITS.find((entry) => entry.traits.gun).traits.gun
  const late = pool.guns.find((gun) => gun.fromSector)
  assert.ok(late, "some gun should arrive later than the rest")
  const namesAt = (sector) => game.gunsForSector(pool, sector).map((gun) => gun.weapon)
  assert.ok(!namesAt(late.fromSector - 1).includes(late.weapon), "not before its sector")
  assert.ok(namesAt(late.fromSector).includes(late.weapon), "and in from it on")

  // the mix widens; the share of rocks carrying any gun at all does not
  const armedShare = (sector) => {
    let armed = 0
    seeded(4700 + sector, () => {
      for (let roll = 0; roll < 4000; roll++) {
        if (game.rollHazardTraits(sector).gun) {
          armed++
        }
      }
    })
    return armed / 4000
  }
  // Either side of the sector it joins, since the trait's own weight grows across a run
  // and measuring further apart would be measuring that instead.
  const before = armedShare(late.fromSector - 1),
    after = armedShare(late.fromSector)
  assert.ok(
    Math.abs(after - before) < 0.05,
    `armed share went ${(before * 100).toFixed(1)}% to ${(after * 100).toFixed(1)}%`,
  )
})

test("a rock rolls each turret from the trait's pool", () => {
  const guns = [
    { weapon: "blaster", controller: "turret" },
    { weapon: "autocannon", controller: "turret" },
  ]
  const loadouts = new Set()
  seeded(31, () => {
    for (let i = 0; i < 200; i++) {
      const rock = new Asteroid({
        x: 0,
        y: 0,
        radius: 85,
        traits: { gun: { guns, count: [3, 3] } },
      })
      const mounted = rock.hardpoints
        .filter((hp) => hp.module && hp.module.kind === "weapon")
        .map((hp) => hp.module.typeName)
      assert.equal(mounted.length, 3)
      for (const name of mounted) {
        assert.ok(
          guns.some((g) => g.weapon === name),
          `${name} is not in the pool`,
        )
      }
      loadouts.add(mounted.slice().sort().join("+"))
    }
  })
  // three turrets from two kinds: all four mixes should turn up
  assert.equal(loadouts.size, 4, `saw ${[...loadouts].join(", ")}`)
})

test("a trait naming one gun is a pool of one", () => {
  // The shorthand has to keep working, or every existing trait and test breaks.
  seeded(7, () => {
    const rock = new Asteroid({
      x: 0,
      y: 0,
      radius: 80,
      traits: { gun: { weapon: "blaster", controller: "turret", count: [2, 2] } },
    })
    const mounted = rock.hardpoints.filter((hp) => hp.module && hp.module.kind === "weapon")
    assert.equal(mounted.length, 2)
    assert.ok(mounted.every((hp) => hp.module.typeName === "blaster"))
  })
})

test("a beam in a turret slot fires as a beam, not as a broken projectile", () => {
  // The controller used to call fireProjectile whatever it was given, and a beam
  // type has no `speed`, so it launched rounds with a velocity of NaN.
  const game = withShield(liveGame()) // a turret holds fire once the player has died
  const player = game.player
  player.x = 500
  player.y = 400
  const rock = new Asteroid({
    vertices: square(500, 320, 70),
    traits: { gun: { weapon: "minerLaser", controller: "turret", count: [1, 1] } },
  })
  // vertices skip hazard mounting, so mount it the way the spawner does
  rock.hardpoints.push({
    x: rock.center.x,
    y: rock.center.y,
    module: new Weapon("minerLaser", "turret"),
  })
  rock.refreshEnergy()
  game.asteroids = [rock, new Asteroid({ vertices: square(500, -600, 60) })]
  let fired = false
  for (let i = 0; i < 300; i++) {
    game.advance(1 / 60)
    for (const shot of game.laserShots) {
      if (shot.color === WEAPON_TYPES.minerLaser.colour) {
        fired = true
      }
    }
    for (const bullet of game.projectiles) {
      assert.ok(
        Number.isFinite(bullet.x) && Number.isFinite(bullet.vx),
        `a round left with x=${bullet.x} vx=${bullet.vx}`,
      )
    }
  }
  assert.ok(fired, "it should have emitted a beam")
})

test("no hazard survives to a late sector only to be crowded out of it", () => {
  // A trait that grows without a cap does not crowd the others out so much as
  // delete them: gun weight rising unchecked took explosive rocks from a fifth
  // of the roll at sector 6 to a thirtieth by sector 30, which is a hazard
  // nobody meets any more.
  const game = new Game()
  const key = (traits) => Object.keys(traits).sort().join("+") || "none"
  for (const sector of [10, 20, 40, 80]) {
    // Whatever is in the roll by then, since a hazard that has not joined yet is absent
    // by design and only one that has can be crowded out.
    const expected = new Set(
      HAZARD_TRAITS.filter((h) => weightAt(h, sector) > 0).map((h) => key(h.traits)),
    )
    const tally = {}
    seeded(1234, () => {
      for (let i = 0; i < 4000; i++) {
        const k = key(game.rollHazardTraits(sector))
        tally[k] = (tally[k] || 0) + 1
      }
    })
    for (const k of expected) {
      const share = (tally[k] || 0) / 4000
      assert.ok(
        share > 0.04,
        `at sector ${sector}, "${k}" is ${(share * 100).toFixed(1)}% of the roll`,
      )
    }
  }
})

test("an armed rock still comes to dominate the roll", () => {
  // The cap must not flatten the progression it is bounding: late sectors should
  // still be mostly armed rocks.
  const game = new Game()
  const armedShare = (sector) => {
    let armed = 0
    seeded(99, () => {
      for (let i = 0; i < 4000; i++) {
        if (game.rollHazardTraits(sector).gun) {
          armed++
        }
      }
    })
    return armed / 4000
  }
  assert.ok(armedShare(12) < armedShare(20), "armed rocks become more common with depth")
  assert.ok(armedShare(40) > 0.5, `late sectors are mostly armed (${armedShare(40).toFixed(2)})`)
})

// ---- the shape of a 40 sector run ------------------------------------------
// A run is paced to reach its ceiling at sector 40. These hold the shape of that curve
// rather than any number in it, so it can be retuned without rewriting them; read
// timeline.html for the curve itself.

const RUN_LENGTH = 40

test("a run introduces its hulls a tier at a time, rivals before aliens", () => {
  const from = (name) => SHIP_TYPES[name].spawn.fromSector
  assert.ok(from("scout") < from("seeker"), "the scout is what a run opens with")
  assert.ok(from("seeker") < from("frigate"), "then the dart, then the slab")
  assert.ok(from("frigate") < from("alienScout"), "and every rival before any alien")
  assert.ok(from("alienScout") < from("alienSeeker"), "the aliens arrive in the same order")
  assert.ok(from("alienSeeker") < from("alienFrigate"))
  assert.ok(from("alienFrigate") <= RUN_LENGTH - 8, "with a run's end left to fight them in")

  // Rare when they join: an alien arriving should be a thing that happened, not the
  // sector's new normal.
  const share = (name, sector) => {
    const weights = Object.keys(SHIP_TYPES).map((n) => weightAt(SHIP_TYPES[n].spawn, sector))
    const total = weights.reduce((a, b) => a + b, 0)
    return weightAt(SHIP_TYPES[name].spawn, sector) / total
  }
  for (const name of ["alienScout", "alienSeeker", "alienFrigate"]) {
    const joins = share(name, from(name))
    assert.ok(joins < 0.1, `${name} is one arrival in ten at most when it joins, got ${joins}`)
    assert.ok(share(name, RUN_LENGTH) > joins * 2, `${name} becomes common by the end`)
  }
})

test("the difficulty curve is still climbing at the end of a run", () => {
  // The point of a 40 sector run is that something changes across all of it. Anything
  // that reaches its ceiling by the middle leaves the second half flat.
  const game = new Game()
  const at = (sector) => {
    const plan = game.planLevel(sector)
    const { hazards } = PROGRESSION
    return {
      rocks: plan.spawns.length,
      rivals: plan.rivals,
      interval: plan.rivalInterval,
      hazard: Math.min(
        Math.max(hazards.base + (sector - hazards.fromSector) * hazards.perSector, 0),
        hazards.max,
      ),
    }
  }
  const early = at(10),
    middle = at(25),
    late = at(RUN_LENGTH)
  assert.ok(early.rocks < middle.rocks && middle.rocks < late.rocks, "the field keeps filling")
  assert.ok(early.hazard < middle.hazard && middle.hazard < late.hazard, "and keeps arming")
  assert.ok(early.rivals < late.rivals, "more of them are alive at once by the end")
  assert.ok(late.interval < early.interval, "and they arrive quicker")
  assert.ok(at(RUN_LENGTH - 5).rocks < late.rocks, "with the last five sectors still moving")
})

test("what a hull carries is rolled up over the run, not switched on at its sector", () => {
  // An arm that reaches its cap five sectors after the hull joins makes the hull's
  // introduction the only step there is.
  for (const [name, type] of Object.entries(SHIP_TYPES)) {
    for (const [armName, arm] of Object.entries(type.arms || {})) {
      const sectorsToCap = arm.chanceCap / arm.chancePerSector
      assert.ok(
        sectorsToCap >= 10,
        `${name}'s ${armName} caps ${sectorsToCap.toFixed(0)} sectors in, which is a step`,
      )
      assert.ok(
        type.spawn.fromSector + sectorsToCap <= RUN_LENGTH + 2,
        `${name}'s ${armName} never reaches its cap within a run`,
      )
    }
  }
})

test("specials are handed out a kind at a time, stealth last", () => {
  const from = (id) => SPECIAL_TYPES[id].fromSector ?? 0
  assert.ok(
    PROGRESSION.specials.fromSector >= 5,
    "nothing drifts in while the player is still learning to fly",
  )
  for (const id of SPECIAL_IDS) {
    assert.ok(from(id) >= PROGRESSION.specials.fromSector, `${id} cannot drop before drops start`)
  }
  const gates = SPECIAL_IDS.map(from)
  assert.equal(new Set(gates).size, gates.length, "each kind arrives on its own sector")
  assert.ok(
    from("stealth") === Math.max(...gates) && from("stealth") >= 25,
    "stealth arrives last, once there is something worth hiding from",
  )
  // The shop only sells what the run has found, so the drop gate is the whole gate.
  const game = liveGame()
  assert.ok(!game.buyableSpecials().includes("stealth"), "and cannot be bought before then")
})

test("rock flak is the rarest gun a rock can carry, and a late one", () => {
  // A flak rock throws a stream: a field of them is a wall. It joins late and stays the
  // thinnest slice of the pool however far a run goes.
  const game = new Game()
  const pool = HAZARD_TRAITS.find((entry) => entry.traits.gun).traits.gun
  const flak = pool.guns.find((gun) => gun.weapon === "flakCannon")
  assert.ok(flak.fromSector >= 20, "not before the run's last half")
  const shareAt = (sector) => {
    const live = game.gunsForSector(pool, sector)
    const total = live.reduce((sum, gun) => sum + gun.weight, 0)
    const mine = live.find((gun) => gun.weapon === "flakCannon")
    return mine ? mine.weight / total : 0
  }
  assert.equal(shareAt(flak.fromSector - 1), 0)
  for (const sector of [flak.fromSector, 30, RUN_LENGTH]) {
    const live = game.gunsForSector(pool, sector)
    const mine = live.find((gun) => gun.weapon === "flakCannon")
    assert.ok(
      live.every((gun) => gun.weapon === "flakCannon" || gun.weight > mine.weight),
      `at sector ${sector} flak must weigh less than every other gun`,
    )
  }
  assert.ok(shareAt(RUN_LENGTH) > shareAt(flak.fromSector), "it does grow, slowly")
  assert.ok(shareAt(RUN_LENGTH) < 0.25, "but is never a quarter of what a rock mounts")
})

// ---- pause menu, settings and the saved run --------------------------------

test("pause opens a menu, and the cursor wraps", () => {
  const game = liveGame()
  assert.equal(game.menuRows(), 0, "nothing to navigate while flying")
  game.toggleOptions()
  const rows = game.pauseMenu().length
  assert.ok(rows > 1)
  assert.equal(game.menuRows(), rows)
  assert.equal(game.pauseSelection, 0)
  game.menuMove(-1)
  assert.equal(game.pauseSelection, rows - 1, "wraps backwards off the top")
  game.menuMove(1)
  assert.equal(game.pauseSelection, 0)
})

test("the pause menu takes precedence over the shop", () => {
  const game = liveGame()
  game.enterShop()
  game.paused = true
  assert.equal(game.menuRows(), game.pauseMenu().length, "paused wins where both could apply")
})

test("exit is only offered where the window can actually be closed", () => {
  const named = (game) => game.pauseMenu().map((row) => row.name)
  const tab = liveGame()
  tab.canExit = false
  assert.ok(!named(tab).includes("EXIT GAME"), "a tab cannot be closed by script, so no row")
  const app = liveGame()
  app.canExit = true
  assert.ok(named(app).includes("EXIT GAME"), "an app window can, so the row is there")
  assert.equal(named(app).length, named(tab).length + 1, "and nothing else changes with it")
})

test("the cursor cannot land on a row that is not offered", () => {
  const game = liveGame()
  game.canExit = false
  game.toggleOptions()
  for (let i = 0; i < game.menuRows() * 2; i++) {
    game.menuMove(1)
    const row = game.pauseMenu()[game.pauseSelection]
    assert.ok(row, "every position holds a row")
    assert.notEqual(row.name, "EXIT GAME")
  }
})

test("volume is adjusted from the menu and reaches the mixer", async () => {
  const { Sound } = await import("../src/audio.js")
  const game = liveGame()
  game.toggleOptions()
  game.pauseSelection = game.pauseMenu().findIndex((row) => row.name === "VOLUME")
  game.setVolume(0.5)
  assert.equal(Sound.volume, 0.5, "the mixer follows the setting")
  game.menuAdjust(1)
  assert.ok(game.settings.volume > 0.5, "right turns it up")
  game.menuAdjust(-1)
  assert.ok(Math.abs(game.settings.volume - 0.5) < 1e-9, "left turns it back down")
  game.setVolume(5)
  assert.equal(game.settings.volume, 1, "and it cannot go past full")
  game.setVolume(-5)
  assert.equal(game.settings.volume, 0, "or below silence")
})

test("a row that asks for confirmation needs two presses", () => {
  const game = liveGame()
  game.canExit = true // exit is only offered where the window can be closed
  game.toggleOptions()
  const index = game.pauseMenu().findIndex((row) => row.name === "EXIT GAME")
  assert.ok(game.pauseMenu()[index].confirm, "this row should want confirming")
  game.pauseSelection = index
  game.menuConfirm()
  assert.equal(game.exitRequested, false, "the first press only asks")
  assert.equal(game.pauseConfirming, "EXIT GAME")
  game.menuConfirm()
  assert.equal(game.exitRequested, true, "the second press does it")
})

test("moving the cursor abandons a pending confirmation", () => {
  const game = liveGame()
  game.canExit = true
  game.toggleOptions()
  game.pauseSelection = game.pauseMenu().findIndex((row) => row.name === "EXIT GAME")
  game.menuConfirm()
  assert.ok(game.pauseConfirming)
  game.menuMove(1)
  assert.equal(game.pauseConfirming, null)
  assert.equal(game.exitRequested, false, "and nothing was done")
})

test("resume closes the menu", () => {
  const game = liveGame()
  game.toggleOptions()
  game.pauseSelection = game.pauseMenu().findIndex((row) => row.name === "RESUME")
  game.menuConfirm()
  assert.equal(game.paused, false)
})

test("the shop records the run, and the title carries on from it", () => {
  const game = liveGame()
  game.upgrades.core = 2
  withEquipment(game, "turret", "defenseBlaster")
  game.oreBalance = 137
  game.score = 9001
  game.lives = 2
  game.enterShop()
  // the shop awards the sector's bonuses before the snapshot, so the recorded score
  // is the one the player actually has, not the one they arrived with
  const banked = game.score
  assert.ok(banked > 9001, "the sector bonus should have been paid")
  const saved = game.savedRun
  assert.ok(saved, "entering the shop should record the run")
  assert.equal(saved.level, game.level)
  assert.equal(saved.oreBalance, 137)
  assert.equal(saved.upgrades.core, 2)

  // a fresh session, told what the last one left behind
  const next = new Game()
  next.savedRun = saved
  next.phase = "title"
  next.menuConfirm()
  assert.equal(next.phase, "shop", "carries on at the shop before that sector")
  assert.equal(next.level, saved.level)
  assert.equal(next.oreBalance, 137)
  assert.equal(next.score, banked)
  assert.equal(next.lives, 2)
  assert.equal(next.upgrades.core, 2)
  assert.ok(next.player, "and there is a ship to fly")
  assert.ok(next.player.aux.module, "with the turret it had been given")
})

// The run is snapshotted at the shop, once its sector is already cleared, so
// resuming must offer the sector after it. It used to offer the cleared one, so
// carrying on replayed a sector that had already been finished.
test("a resumed run carries on into the sector after the one it saved", () => {
  const game = liveGame()
  game.level = 6
  game.enterShop()
  const cleared = game.savedRun.level
  assert.equal(cleared, 6)
  const fresh = game.shopSector

  const next = new Game()
  next.savedRun = game.savedRun
  next.resumeRun()
  assert.equal(next.resumeSector(), cleared + 1, "the run carries on into the next sector")
  assert.equal(next.shopSector, fresh, "and offers the same launch as the shop that saved it")

  next.shopSelection = next.launchRow
  next.doShopAction()
  assert.equal(next.level, cleared + 1, "launching flies the next sector, not the cleared one")
})

// The shop's summary line formats five stats. A resumed run has no sector behind
// it in this session and so has none of them, which rendered as "accuracy NaN%"
// and four "undefined"s until the view read the flag that was already there.
test("a resumed summary is flagged, and a played one carries every stat the shop shows", () => {
  const shown = ["accuracy", "mined", "ore", "damage", "totalBonus"]

  const played = liveGame()
  played.level = 3
  played.stats = { shots: 10, hits: 7, damage: 40, ore: 12, mined: 5 }
  played.enterShop()
  assert.ok(!played.summaryData.resumed, "a sector just played is not a resume")
  for (const field of shown) {
    assert.equal(typeof played.summaryData[field], "number", `${field} must be a number`)
    assert.ok(Number.isFinite(played.summaryData[field]), `${field} must be finite`)
  }

  const next = new Game()
  next.savedRun = played.savedRun
  next.resumeRun()
  assert.equal(next.summaryData.resumed, true, "so the shop knows not to read stats it lacks")
})

test("the title starts a fresh run when there is nothing saved", () => {
  const game = new Game()
  game.savedRun = null
  game.menuConfirm()
  assert.equal(game.phase, "arriving")
  assert.equal(game.level, 1)
})

test("losing the last life throws the saved run away", () => {
  const game = liveGame()
  game.enterShop()
  assert.ok(game.savedRun)
  game.phase = "play"
  game.lives = 1
  game.playerLoseLife()
  assert.equal(game.phase, "over")
  assert.equal(game.savedRun, null, "there is nothing to come back to")
})

test("resetting progress returns to the title with nothing kept", () => {
  const game = liveGame()
  game.enterShop()
  game.toggleOptions()
  game.resetProgress()
  assert.equal(game.savedRun, null)
  assert.equal(game.phase, "title")
  assert.equal(game.paused, false)
  assert.equal(game.player, null)
})

test("settings survive a reset of progress", () => {
  const game = liveGame()
  game.setVolume(0.3)
  game.setCrt(false)
  game.resetProgress()
  assert.equal(game.settings.volume, 0.3, "how loud the game is is not progress")
  assert.equal(game.settings.crt, false)
})

test("adjusting the volume plays a tone at the level just set", async () => {
  const { Sound } = await import("../src/audio.js")
  const game = liveGame()
  // Catch the tone where it is asked for, and record the level the mixer was at,
  // which is the point: a tone at the old level would tell the player nothing.
  const heard = []
  const realPower = Sound.power
  Sound.power = () => heard.push(Sound.volume)
  try {
    game.toggleOptions()
    game.pauseSelection = game.pauseMenu().findIndex((row) => row.name === "VOLUME")
    game.setVolume(0.5)
    assert.deepEqual(heard, [0.5], "setting it makes one tone, at the new level")
    game.menuAdjust(1)
    assert.equal(heard.length, 2, "and every adjustment makes one")
    assert.ok(heard[1] > 0.5, "each at the level it just moved to")
    game.menuAdjust(-1)
    assert.equal(heard.length, 3)
    assert.ok(Math.abs(heard[2] - 0.5) < 1e-9)
  } finally {
    Sound.power = realPower
  }
})

// Working a menu row is silent. The only tones the options menu makes are the ones
// that are themselves the answer: how loud the game is, and whether it is audible.
test("the options menu is silent except where the sound is the setting", async () => {
  const { Sound } = await import("../src/audio.js")
  const heard = []
  const realPower = Sound.power
  Sound.power = () => heard.push(true)
  try {
    const game = liveGame()
    game.toggleOptions()
    const choose = (name) => {
      const rows = game.pauseMenu()
      game.pauseSelection = rows.findIndex((row) => row.name === name)
      heard.length = 0
      game.menuConfirm()
      return heard.length
    }
    const adjust = (name, step) => {
      const rows = game.pauseMenu()
      game.pauseSelection = rows.findIndex((row) => row.name === name)
      heard.length = 0
      game.menuAdjust(step)
      return heard.length
    }

    assert.equal(choose("CRT FILTER"), 0, "toggling the CRT filter is not an audio change")
    assert.equal(adjust("CRT FILTER", 1), 0, "and neither is nudging it")
    assert.equal(choose("CONTROLS"), 0, "opening a sub page is silent")
    assert.equal(choose("BACK"), 0, "and so is leaving one")

    // sound off, then on: only the switch on can be heard, and it is
    game.setSound(true)
    assert.equal(adjust("SOUND", -1), 0, "switching it off cannot announce itself")
    assert.equal(game.settings.sound, false)
    assert.equal(adjust("SOUND", 1), 1, "switching it on plays a tone")
    assert.equal(game.settings.sound, true)
    assert.equal(adjust("SOUND", 1), 0, "and holding right does not blip on every press")
    assert.equal(choose("SOUND"), 0, "toggling it back off is silent")
    assert.equal(choose("SOUND"), 1, "and on again is not")
  } finally {
    Sound.power = realPower
  }
})

test("taking a binding is silent, the label having already said so", async () => {
  const { Sound } = await import("../src/audio.js")
  const heard = []
  const realPower = Sound.power
  Sound.power = () => heard.push(true)
  try {
    const game = liveGame()
    game.toggleOptions()
    game.openPausePage("controls")
    game.beginRebind("keys", "thrust")
    game.captureBinding("keys", "KeyI")
    assert.deepEqual(game.bindings.keys.thrust, ["KeyI"], "the binding was taken")
    assert.equal(heard.length, 0)
  } finally {
    Sound.power = realPower
  }
})

// ---- walking out of a sector ----------------------------------------------

// A sector can be left before it is finished, which is the way out when it is more
// than the ship can handle. It costs the end-of-sector bonuses and the loose ore,
// and sends you back to the same sector rather than on to the next.
function inSector(level = 6) {
  const game = new Game()
  game.startNewGame()
  game.startLevel(level)
  game.phase = "play"
  beSolid(game.player)
  return game
}

test("EXIT SECTOR is the first option in a sector, and is not offered elsewhere", () => {
  const game = inSector()
  game.toggleOptions()
  // First of the rows a player ever sees. A dev build puts DEV TOOLS above it, since on
  // one of those that is what the menu is most often opened for.
  const forPlayers = game.pauseMenu().filter((row) => row.name !== "DEV TOOLS")
  assert.equal(forPlayers[0].name, "EXIT SECTOR", "it is what the cursor lands on")

  // once the last rock is gone the shop is coming anyway, so there is nothing to
  // walk out of and a stray press must not throw the clear away
  for (const phase of ["clearing", "departing"]) {
    game.phase = phase
    assert.equal(game.canExitSector(), false, phase)
    assert.ok(!game.pauseMenu().some((row) => row.name === "EXIT SECTOR"), phase)
  }
  game.phase = "play"
  game.toggleOptions()
  game.enterShop()
  game.toggleOptions()
  assert.ok(!game.pauseMenu().some((row) => row.name === "EXIT SECTOR"), "nor over the shop")
})

test("EXIT SECTOR asks twice, as the other rows that throw something away do", () => {
  const game = inSector()
  game.toggleOptions()
  game.pauseSelection = game.pauseMenu().findIndex((row) => row.name === "EXIT SECTOR")
  game.menuConfirm()
  assert.equal(game.pauseConfirming, "EXIT SECTOR", "one press asks")
  assert.equal(game.phase, "play", "and leaves the sector alone")
  game.menuConfirm()
  assert.equal(game.phase, "shop", "the second press does it")
  assert.equal(game.paused, false, "and closes the menu behind it")
})

test("walking out pays no bonus and leaves the loose ore behind", () => {
  const game = inSector()
  game.stats = { shots: 10, hits: 10, damage: 0, ore: 4, mined: 3 }
  game.oreBalance = 40
  game.spawnOre(0, 0, 0, 0)
  game.spawnOre(0, 0, 0, 0)
  const before = game.score
  game.exitSector()

  assert.equal(game.score - before, 0, "no accuracy, flawless or clear bonus")
  assert.equal(game.summaryData.totalBonus, 0)
  assert.equal(game.summaryData.bailed, true, "so the screen can say so")
  assert.equal(game.oreBalance, 40, "the chunks still on the field are left there")
  assert.equal(game.oreChunks.length, 0)

  // and clearing the same sector properly still pays and sweeps
  const cleared = inSector()
  cleared.stats = { shots: 10, hits: 10, damage: 0, ore: 4, mined: 3 }
  cleared.oreBalance = 40
  cleared.spawnOre(0, 0, 0, 0)
  cleared.spawnOre(0, 0, 0, 0)
  const clearedBefore = cleared.score
  cleared.enterShop()
  assert.ok(cleared.score - clearedBefore > 0, "the bonuses are paid")
  assert.equal(cleared.summaryData.flawlessBonus, CONFIG.FLAWLESS_BONUS)
  assert.equal(cleared.oreBalance, 42, "and the loose ore is swept up")
})

test("walking out sends you back to the same sector, and clearing to the next", () => {
  const bailed = inSector(6)
  bailed.exitSector()
  assert.equal(bailed.shopSector, 6, "the launch offers the sector again")

  const cleared = inSector(6)
  cleared.enterShop()
  assert.equal(cleared.shopSector, 7, "clearing moves on")
})

test("a run resumed after walking out comes back to the sector it left", () => {
  for (const [what, cleared, expected] of [
    ["walked out of 6", false, 6],
    ["cleared 6", true, 7],
  ]) {
    const game = inSector(6)
    if (cleared) {
      game.enterShop()
    } else {
      game.exitSector()
    }
    const next = new Game()
    next.savedRun = game.savedRun
    next.resumeRun()
    assert.equal(next.resumeSector(), expected, what)
    assert.equal(next.shopSector, expected, `${what}: and the launch agrees`)
    assert.equal(next.summaryData.bailed, !cleared, `${what}: the heading knows which it was`)
  }
})

test("a saved run written before this still resumes the way it used to", () => {
  const game = new Game()
  game.savedRun = { level: 4, score: 100, lives: 3, oreBalance: 0, upgrades: {} }
  assert.equal(game.resumeSector(), 5, "no `next` means the sector was cleared")
})
