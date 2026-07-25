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

import { Game } from "../src/game.js"
import { PALETTE } from "../src/palette.js"
import {
  Asteroid,
  Projectile,
  RivalShip,
  Shield,
  Weapon,
  oreFromFragment,
  shapeContact,
  resolveHullRockContact,
  rockMass,
} from "../src/entities.js"
import {
  ARENA,
  BINDABLE_CONTROLS,
  BINDING_DEVICES,
  CONFIG,
  HAZARD_TRAITS,
  PLAYER_TYPE,
  POWERUP_TYPES,
  PROGRESSION,
  SHIELD_TYPES,
  SHIP_PLATING,
  SHIP_SCALARS,
  SHOP,
  WEAPON_TYPES,
  SHIP_TYPES,
  deriveShipStats,
} from "../src/config.js"
import {
  convexContact,
  convexPartition,
  countBeamCrossings,
  mulberry32,
  pointInPolygon,
  polygonArea,
} from "../src/math.js"

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

const playerWeapon = { type: WEAPON_TYPES.playerLaser }

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
// raised the bubble is the surface instead, which the next test covers. The
// shield is left overloaded rather than merely down: at full energy it recovers
// within the same frame, and the pose would be gone before the shot arrived.
function bareHullGame() {
  const game = liveGame()
  const player = game.player
  player.angle = 0 // nose along +x, so the hull tapers to a point at the tail
  player.x = 400
  player.y = 320
  const shield = player.shieldModule()
  shield.up = false
  shield.downTimer = 10
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
  const bubble = PLAYER_TYPE.size * PLAYER_TYPE.shieldScale
  const shootFrom = (offset) => {
    const game = liveGame()
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
    const ship = typeName === "player" ? game.player : new RivalShip(0, 0, typeName, [])
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
  const scout = new RivalShip(500, 320, "scout", [])
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
  const frigate = new RivalShip(400, 320, "frigate", [])
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
  const rival = new RivalShip(ARENA.cx + distance, ARENA.cy, typeName, [])
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

  // ...and once it reaches the field, it does fire
  rival.x = ARENA.cx
  rival.y = ARENA.cy
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
  const rival = new RivalShip(ARENA.cx - 700, ARENA.cy, "scout", [])
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
  assert.equal(new RivalShip(0, 0, "frigate", []).hunts, true, "with no loadout at all")
  assert.equal(new RivalShip(0, 0, "frigate", SHIP_TYPES.frigate.loadout).hunts, true)
  assert.equal(new RivalShip(0, 0, "scout", SHIP_TYPES.scout.loadout).hunts, false)
  assert.equal(!!SHIP_TYPES.frigate.hunts, true, "and it is the type that says so")
})

test("two rivals cannot occupy the same space", () => {
  const game = liveGame()
  game.player.x = -5000 // keep the player out of it
  const a = new RivalShip(600, 320, "frigate", [])
  const b = new RivalShip(611, 325, "frigate", [])
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
  const frigate = new RivalShip(600, 320, "frigate", [])
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
  const frigate = new RivalShip(600, 320, "frigate", [])
  frigate.angle = 0
  // nose just inside the frigate's tail face, closing along +x: a shallow
  // contact, as one caught on the frame it forms would be
  const tailX = Math.min(...frigate.worldOutline().map((p) => p.x))
  const scout = new RivalShip(tailX - 12, 320, "scout", [])
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
  const frigate = new RivalShip(600, 320, "frigate", [])
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
  if (!shielded) {
    player.shieldModule().up = false
  }
  const shooter = new RivalShip(400 + offset, 320 - 300, "scout", [])
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
  const laser = WEAPON_TYPES.playerLaser
  const game = liveGame()
  const scout = new RivalShip(500, 320, "scout", []) // unarmed, unshielded
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
  const bubble = PLAYER_TYPE.size * PLAYER_TYPE.shieldScale
  for (const offset of [0, 8, 14, 18, 22, 24, 26, 34]) {
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
    const scout = new RivalShip(500, 320, "scout", [])
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
  const bare = SHIP_TYPES.frigate.loadout.filter((entry) => !entry.shield)
  const frigate = new RivalShip(600, 320, "frigate", bare)
  frigate.angle = 0
  game.rivals = [frigate]
  assert.equal(frigate.shieldUp(), false)
  const { closest } = ramTarget(
    game,
    () => frigate,
    () => 0,
    () => {
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
    const scout = new RivalShip(400 + i * 90, 320, "scout", []) // unarmed, unshielded
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
  const general =
    SHIELD_TYPES[Object.keys(SHIELD_TYPES).find((k) => SHIELD_TYPES[k].blocks.length > 1)]
  const specialist =
    SHIELD_TYPES[Object.keys(SHIELD_TYPES).find((k) => SHIELD_TYPES[k].blocks.length === 1)]
  assert.ok(specialist, "some shield should cover one channel only")
  assert.ok(
    specialist.efficiency < general.efficiency,
    `it should drain less per point (${specialist.efficiency} vs ${general.efficiency})`,
  )
  assert.ok(specialist.dropAt < general.dropAt, "and hold on further down the cell")
  assert.ok(specialist.recoverAt <= general.recoverAt, "and come back sooner")
  assert.ok(specialist.recoverDelay <= general.recoverDelay, "after a shorter wait")
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
  const behind = new RivalShip(700, 320, "scout", [])
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

test("the same graze on a frigate takes a piece off and leaves the rest", () => {
  const game = liveGame()
  const player = game.player
  player.angle = 0
  player.x = 100
  player.y = 320
  const frigate = new RivalShip(500, 320, "frigate", [])
  frigate.angle = 0
  game.rivals = [frigate]
  // along the frigate's flank, inside its half-height so it passes through
  const offset = SHIP_TYPES.frigate.size * 0.4
  const beam = {
    a: { x: 100, y: 320 + offset },
    dir: { x: 1, y: 0 },
    b: { x: 1100, y: 320 + offset },
  }
  assert.ok(countBeamCrossings(beam, frigate.worldOutline()) >= 2, "the shot must pass through")
  game.applyBeam(beam, player, playerWeapon)
  assert.equal(frigate.dead, true)
  assert.ok(
    game.asteroids.length >= 1,
    "a frigate is big enough that a graze leaves wreckage behind",
  )
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
  player.energy = 0 // no shield to hide behind
  player.shieldModule().up = false
  const shooter = new RivalShip(100, 320, "scout", [])
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

    player.mainWeapon.charge = WEAPON_TYPES.playerLaser.chargeMax
    player.mainWeapon.cooldown = 0
    player.fireLaser(game)

    assert.ok(rival.energy < rival.energyMax, `${typeName} must take the hit on its shield`)
    assert.equal(shield.up, true, `${typeName}'s shield must survive one full-charge shot`)
    assert.equal(rival.dead, false, `${typeName} must survive it`)
    assert.equal(game.asteroids.length, 0, "and must not be cut while shielded")
  }
})

test("charge buys reach, and damage follows it more gently", () => {
  const weapon = WEAPON_TYPES.playerLaser
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
  const game = liveGame()
  const player = game.player
  const shield = player.shieldModule()
  assert.ok(shield && shield.up, "the shield should start up")
  player.takeDamage(50, game, "projectile", 0, { x: player.x + 5, y: player.y })
  assert.ok(player.energy < player.energyMax, "the shield drained")
  assert.equal(game.lives, CONFIG.START_LIVES, "no life was lost")
  assert.equal(game.stats.damage, 50, "the hit is still counted")
})

test("buying a fitting mounts what the registry declares for it", () => {
  const game = liveGame()
  const aux = game.player.hardpointByRole("aux")
  assert.equal(aux.module, null, "the slot starts empty")
  const turret = SHOP.find((item) => item.id === "turret")
  turret.apply(game)
  assert.equal(game.upgrades.turret, true)
  assert.equal(aux.module.typeName, PLAYER_TYPE.fittings.turret.weapon)
  // buying it again must not swap in a fresh module mid-reload
  const mounted = aux.module
  turret.apply(game)
  assert.equal(aux.module, mounted)
})

test("a resumed run re-mounts the fittings it had already bought", () => {
  const game = liveGame()
  game.upgrades.turret = true
  game.level = 5
  game.enterShop()
  const resumed = new Game()
  resumed.savedRun = game.savedRun
  resumed.resumeRun()
  assert.equal(resumed.upgrades.turret, true)
  assert.ok(resumed.player.hardpointByRole("aux").module, "the turret must come back with the run")
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
    const shooter = new RivalShip(150, 320, "scout", [])
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
  const rival = new RivalShip(ARENA.cx + ARENA.radius + 20, ARENA.cy, "scout", [])
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

// ---- powerups are declared, not special-cased ------------------------------

test("a powerup's ongoing effect is read from its registry entry", () => {
  const game = liveGame()
  const player = game.player
  assert.equal(player.buffField("beamLengthMult", 1), 1)
  // grant whichever powerup declares the effect, rather than naming one here
  const id = Object.keys(POWERUP_TYPES).find((key) => POWERUP_TYPES[key].beamLengthMult)
  player.grantBuff(id, 5)
  assert.equal(player.beamLengthMult(), POWERUP_TYPES[id].beamLengthMult)
})

test("a powerup declaring collisionImmune stops rock contact damage", () => {
  const id = Object.keys(POWERUP_TYPES).find((key) => POWERUP_TYPES[key].collisionImmune)
  assert.ok(id, "some powerup should declare collision immunity")
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
  assert.equal(ram(true), 0, "unless a powerup says otherwise")
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
  const ship = new RivalShip(rockFace - SHIP_TYPES[typeName].size * 2 - 40, 320, typeName, [])
  ship.angle = 0
  game.rivals = [ship]
  game.asteroids = [new Asteroid({ vertices: square(rockFace + 80, 320, 80), vx: 0, vy: 0 })]
  for (let i = 0; i < 240; i++) {
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

test("a rock costs a rival hull, as it costs the player energy", () => {
  for (const typeName of Object.keys(SHIP_TYPES)) {
    assert.ok(ramARock(typeName) > 0, `a ${typeName} driving into a rock must be worn down by it`)
  }
})

test("what rock contact costs a hull is the type's business, not the code's", () => {
  // Same contact, same code path: only the registry entry differs.
  const cost = (scale) => {
    const original = SHIP_TYPES.scout.rockContact
    SHIP_TYPES.scout.rockContact = scale
    try {
      return ramARock("scout")
    } finally {
      SHIP_TYPES.scout.rockContact = original
    }
  }
  assert.equal(cost(0), 0, "a type that declares no susceptibility takes nothing")
  assert.ok(cost(0.2) > 0, "and one that does is worn down")
  assert.ok(cost(0.1) < cost(0.2), "proportionally to what it declares")
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
  game.player.mainWeapon.charge = WEAPON_TYPES.playerLaser.chargeMax
  game.player.mainWeapon.cooldown = 0
  const shots = game.stats.shots
  game.onKeyUp({ code: "KeyJ" })
  assert.equal(game.stats.shots, shots + 1, "release on the bound key shoots")
})

test("a rebound slot key uses that slot", () => {
  const game = liveGame()
  game.upgrades.slots = 2
  game.player.items = ["refuel", "repel"]
  game.bindings.keys.slot2 = ["KeyN"]
  game.onKeyDown({ code: "KeyN", preventDefault() {} })
  assert.deepEqual(game.player.items, ["refuel"], "the second slot was the one used")
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

// ---- a ship is a shape and three numbers ----------------------------------

test("every ship type states only its shape and its three stats", () => {
  // The derived settings must not be written down as well, or the relationships
  // stop being the thing that decides them and quietly become decoration.
  const derived = [
    "accel",
    "maxSpeed",
    "turnRate",
    "drag",
    "hull",
    "shieldScale",
    "hullWidth",
    "rockContact",
  ]
  for (const [name, type] of Object.entries(SHIP_TYPES)) {
    for (const field of ["size", "mass", "power", "armour"]) {
      assert.equal(typeof type[field], "number", `${name} must state ${field}`)
    }
    for (const field of derived) {
      assert.equal(typeof type[field], "number", `${name} must end up with ${field}`)
      assert.ok(Number.isFinite(type[field]), `${name}.${field} is ${type[field]}`)
    }
  }
})

test("the ship stats follow from the shape and the three numbers", () => {
  const k = SHIP_SCALARS
  const reach = (outline) => Math.max(...outline.map(([x, y]) => Math.hypot(x, y)))
  for (const [name, t] of Object.entries(SHIP_TYPES)) {
    const thrust = t.power * k.thrustPerPower
    assert.ok(Math.abs(t.accel - thrust / t.mass) < 1e-9, `${name} accel`)
    assert.ok(Math.abs(t.maxSpeed - t.accel * k.speedPerAccel) < 1e-9, `${name} maxSpeed`)
    assert.ok(
      Math.abs(t.turnRate - (thrust * k.turnPerThrust) / (t.mass * t.size)) < 1e-9,
      `${name} turnRate`,
    )
    assert.ok(Math.abs(t.drag - (1 - k.dragPerMass / t.mass)) < 1e-9, `${name} drag`)
    assert.ok(
      Math.abs(t.shieldScale - reach(t.outline) * k.shieldClearance) < 1e-9,
      `${name} shieldScale`,
    )
    // the bubble has to clear the hull it is drawn around, whatever the shape
    assert.ok(t.shieldScale > reach(t.outline), `${name} bubble must stand clear of the outline`)
  }
})

test("a new ship needs a shape and three numbers, and nothing else", () => {
  // Same machinery the shipped types go through, so this cannot pass by way of
  // a value written down somewhere.
  const design = {
    outline: [
      [1.5, 0],
      [-1, -0.8],
      [-0.6, 0],
      [-1, 0.8],
    ],
    colour: PALETTE.rival.hull,
    size: 20,
    mass: 2,
    power: 1.5,
    armour: 0.8,
    hardpoints: [{ local: [0, 0], role: "core" }],
    loadout: [],
    spawn: { fromSector: 5, chance: 0.5, maxConcurrent: 1 },
    lifeTime: [20, 30],
    energyMax: 120,
    regen: 25,
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
    const ship = new RivalShip(300, 320, "corvette", [])
    game.rivals = [ship]
    for (const field of ["accel", "maxSpeed", "turnRate", "drag", "hull"]) {
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

test("stating a setting on a type keeps it, for tuning one ship", () => {
  const design = { ...SHIP_TYPES.scout, mass: 0.7, power: 1, armour: 1, drag: 0.123, hull: 99 }
  delete design.accel
  const tuned = deriveShipStats(design)
  assert.equal(tuned.drag, 0.123, "a stated value wins")
  assert.equal(tuned.hull, 99)
  assert.ok(
    Math.abs(tuned.accel - (1 * SHIP_SCALARS.thrustPerPower) / 0.7) < 1e-9,
    "the rest still derives",
  )
})

test("sector plans follow PROGRESSION", () => {
  const game = new Game()
  const early = game.planLevel(1)
  assert.equal(early.rivals, 0, "no rivals in sector 1")
  assert.equal(early.powerups, false, "and no powerups yet")
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
  game.upgrades.turret = true
  game.player.fit("turret")
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
  const rival = new RivalShip(600, 320, "scout", [])
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
    const target = new RivalShip(560, 320, "frigate", [])
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

test("hazard traits are gated by sector", () => {
  const game = new Game()
  for (let trial = 0; trial < 200; trial++) {
    assert.deepEqual(game.rollHazardTraits(2), {}, "nothing is armed before sector 3")
    const early = game.rollHazardTraits(3)
    assert.equal(early.gun, undefined, "guns do not appear at sector 3")
    assert.equal(early.shield, undefined, "nor do shields")
  }
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
  const game = liveGame()
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
  const expected = new Set(HAZARD_TRAITS.map((h) => key(h.traits)))
  for (const sector of [10, 20, 40, 80]) {
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
  assert.ok(armedShare(6) < armedShare(12), "armed rocks become more common with depth")
  assert.ok(armedShare(20) > 0.6, `late sectors are mostly armed (${armedShare(20).toFixed(2)})`)
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
  game.upgrades.turret = true
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

  next.shopSelection = SHOP.length // the LAUNCH row
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
  assert.equal(game.pauseMenu()[0].name, "EXIT SECTOR", "it is what the cursor lands on")

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
  game.pauseSelection = 0
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
