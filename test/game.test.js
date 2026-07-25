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
import { Asteroid, Projectile, RivalShip } from "../src/entities.js"
import { CONFIG, POWERUP_TYPES, PROGRESSION, WEAPON_TYPES, SHIP_TYPES } from "../src/config.js"
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
