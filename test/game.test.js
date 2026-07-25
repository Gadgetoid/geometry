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
import {
  Asteroid,
  Projectile,
  RivalShip,
  resolveHullRockContact,
  rockMass,
} from "../src/entities.js"
import {
  ARENA,
  CONFIG,
  PLAYER_TYPE,
  POWERUP_TYPES,
  PROGRESSION,
  SHIP_PLATING,
  SHOP,
  WEAPON_TYPES,
  SHIP_TYPES,
} from "../src/config.js"
import { convexContact, convexPartition, countBeamCrossings, polygonArea } from "../src/math.js"

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

test("a shot through the empty space beside the hull misses", () => {
  const game = liveGame()
  const player = game.player
  player.angle = 0 // nose along +x, so the hull tapers to a point at the tail
  player.x = 400
  player.y = 320
  const tailX = Math.min(...player.worldOutline().map((p) => p.x))
  // Level with the tail but out at the full collision radius: this used to be
  // inside the circle, while the hull there is a single point.
  const bullet = new Projectile(tailX + 1, player.y + player.radius - 1, 0, 0, 100, null)
  game.projectiles = [bullet]
  game.advance(1 / 60)
  assert.equal(game.stats.damage, 0, "empty space beside the hull must not register")

  // ...and a shot on the hull itself still lands.
  const game2 = liveGame()
  game2.player.angle = 0
  game2.player.x = 400
  game2.player.y = 320
  game2.projectiles = [new Projectile(400, 320, 0, 0, 100, null)]
  game2.advance(1 / 60)
  assert.ok(game2.stats.damage > 0, "a shot on the hull must land")
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
  let deepest = 0
  for (let i = 0; i < 180; i++) {
    for (const rock of game.asteroids) {
      rock.vx = 0
      rock.vy = 0
      rock.spin = 0
    }
    player.vx = 200
    player.vy = 200 // keep driving into the corner
    game.advance(1 / 60)
    for (const rock of game.asteroids) {
      deepest = Math.max(deepest, overlapDepth(rock.convexParts(), player.collisionOutline()))
    }
  }
  assert.ok(deepest < 1, `deepest residual penetration ${deepest.toFixed(2)} world units`)
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
  const crossesHull = countBeamCrossings(beam, player.worldOutline()) >= 1
  game.applyBeam(beam, shooter, { type: weaponType })
  return { crossesHull, landed: game.stats.damage > 0 }
}

test("a beam hits an unshielded player where its hull actually is", () => {
  // The widest beam in the game: its old hit circle was ~10x the hull's area.
  for (const offset of [-14, -8, 0, 8, 14, 20, 26]) {
    const r = beamPastPlayer(offset, WEAPON_TYPES.cannonLaser, { shielded: false })
    assert.equal(r.landed, r.crossesHull, `cannonLaser at offset ${offset}`)
  }
  // The narrowest: its old circle stopped short of the nose.
  for (const offset of [-12, 0, 12, 16, 18, 20]) {
    const r = beamPastPlayer(offset, WEAPON_TYPES.minerLaser, { shielded: false })
    assert.equal(r.landed, r.crossesHull, `minerLaser at offset ${offset}`)
  }
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

// ---- progression is data ---------------------------------------------------

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

test("hazard traits are gated by sector", () => {
  const game = new Game()
  for (let trial = 0; trial < 200; trial++) {
    assert.deepEqual(game.rollHazardTraits(2), {}, "nothing is armed before sector 3")
    const early = game.rollHazardTraits(3)
    assert.equal(early.gun, undefined, "guns do not appear at sector 3")
    assert.equal(early.shield, undefined, "nor do shields")
  }
})

// ---- pause menu, settings and the saved run --------------------------------

test("pause opens a menu, and the cursor wraps", () => {
  const game = liveGame()
  assert.equal(game.menuRows(), 0, "nothing to navigate while flying")
  game.togglePause()
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
  game.togglePause()
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
  game.togglePause()
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
  game.togglePause()
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
  game.togglePause()
  game.pauseSelection = game.pauseMenu().findIndex((row) => row.name === "EXIT GAME")
  game.menuConfirm()
  assert.ok(game.pauseConfirming)
  game.menuMove(1)
  assert.equal(game.pauseConfirming, null)
  assert.equal(game.exitRequested, false, "and nothing was done")
})

test("resume closes the menu", () => {
  const game = liveGame()
  game.togglePause()
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
  game.togglePause()
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
