// The Game owns all mutable state and orchestrates the simulation: update,
// level flow, the shop, and beam resolution. Painting lives in GameView
// (view.js), which reads this state. Entities receive the game instance and
// read / mutate its public fields; nothing here reaches for module globals.

import {
  VIEW_W,
  VIEW_H,
  ARENA,
  TAU,
  CONFIG,
  SHIP_TYPES,
  SHOP,
  POWERUP_TYPES,
  POWERUP_IDS,
  SHIELD_SPARK,
  freshUpgrades,
} from "./config.js"
import {
  randRange,
  randInt,
  pick,
  clamp,
  subtract,
  normalize,
  dot,
  perpendicular,
  slicePolygon,
  polygonCentroid,
  polygonArea,
  pointInPolygon,
  countBeamCrossings,
  convexContact,
} from "./math.js"
import { Sound } from "./audio.js"
import { PALETTE } from "./palette.js"
import { Backdrop } from "./background.js"
import { loadBest, saveBest } from "./persistence.js"
import { Asteroid, Ore, Powerup, PlayerShip, RivalShip } from "./entities.js"

const PARTICLE_LIFE = 5 // global lifetime multiplier
const PARTICLE_DRAG = 0.4 // velocity retained per second
const MAX_PARTICLES = 1200
const SLOT_KEYS = {
  Digit1: 0,
  Digit2: 1,
  Digit3: 2,
  Digit4: 3,
  Numpad1: 0,
  Numpad2: 1,
  Numpad3: 2,
  Numpad4: 3,
}

// The first sector any rival appears in: the earliest spawn gate across the
// ship types.
// Phases where a sector is live and the simulation runs. Around them sit
// title, shop and over. `arriving` and `departing` are the warp bookends: the
// world keeps moving but the ship is not under control and not solid.
//   title -> arriving -> play -> clearing -> departing -> shop -> arriving ...
// Losing a life drops back to `arriving` in place, so the pause and warp-in are
// the same code as the start of a sector.
const SECTOR_PHASES = new Set(["arriving", "play", "clearing", "departing"])

const RIVALS_FROM_SECTOR = Math.min(
  ...Object.values(SHIP_TYPES).map((type) => type.spawn.fromSector),
)

export class Game {
  constructor() {
    this.phase = "title" // see SECTOR_PHASES for the in-sector run
    this.asteroids = []
    this.oreChunks = []
    this.projectiles = []
    this.powerupPickups = []
    this.rivals = []
    this.particles = []
    this.laserShots = []
    this.player = null

    this.score = 0
    this.lives = CONFIG.START_LIVES
    this.rivalScore = 0
    this.level = 1
    this.plan = null
    this.oreBalance = 0
    this.upgrades = freshUpgrades()
    this.stats = this.blankStats()
    this.summaryData = null
    this.best = { score: 0, sector: 1 }

    this.shopSelection = 0
    this.shopSector = 1
    this.toast = null
    this.devMode = false
    this.paused = false
    this.gameTime = 0
    this.screenShake = 0
    this.oreVacuum = false
    this.powerupTimer = 0
    this.rivalTimer = 0
    this.clearTimer = 0
    this.pressedKeys = new Set()
    this.viewCenter = { x: ARENA.cx, y: ARENA.cy } // world point the camera follows

    this.backdrop = new Backdrop()
    loadBest().then((value) => {
      if (value) {
        this.best = value
      }
    })
  }

  // Is a sector live? Weapons, control and scoring still key off `play` alone.
  inSector() {
    return SECTOR_PHASES.has(this.phase)
  }

  blankStats() {
    return { shots: 0, hits: 0, damage: 0, ore: 0, mined: 0 }
  }
  maxEnergy() {
    return CONFIG.CORE_MAX[this.upgrades.core]
  }
  showToast(text) {
    this.toast = { text, life: CONFIG.TOAST_TIME }
  }

  // Is a world point within the visible viewport (centred on viewCenter)?
  // Used to stop off-screen enemies firing on the player.
  onScreen(x, y, margin = 0) {
    return (
      Math.abs(x - this.viewCenter.x) <= VIEW_W / 2 + margin &&
      Math.abs(y - this.viewCenter.y) <= VIEW_H / 2 + margin
    )
  }

  // ---- particles -------------------------------------------------------
  // Emitters only push; the cap is applied once per frame from update(), so a
  // burst-heavy frame doesn't shift the whole array on every call.
  emit(x, y, vx, vy, baseLife, color) {
    const life = baseLife * PARTICLE_LIFE
    this.particles.push({ x, y, vx, vy, life, maxLife: life, color })
  }

  burst(x, y, count, color, minSpeed, maxSpeed, baseLife) {
    const life = baseLife * PARTICLE_LIFE
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * TAU,
        speed = randRange(minSpeed, maxSpeed)
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: randRange(life * 0.6, life),
        maxLife: life,
        color,
      })
    }
  }

  ring(x, y, count, color, speed, baseLife) {
    const life = baseLife * PARTICLE_LIFE
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * TAU
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life,
        maxLife: life,
        color,
      })
    }
  }

  // ---- spawning --------------------------------------------------------
  spawnOre(x, y, vx, vy) {
    this.oreChunks.push(new Ore(x, y, vx, vy))
  }

  spawnPowerup() {
    const type = pick(POWERUP_IDS)
    // just beyond a screen edge near the camera, drifting in toward the player
    const c = this.viewCenter
    const angle = randRange(0, TAU)
    const x = c.x + Math.cos(angle) * (VIEW_W / 2 + 30)
    const y = c.y + Math.sin(angle) * (VIEW_H / 2 + 30)
    const dir = normalize(subtract(c, { x, y }))
    this.powerupPickups.push(
      new Powerup(x, y, dir.x * randRange(30, 50), dir.y * randRange(30, 50), type),
    )
  }

  countRivals(typeName) {
    let n = 0
    for (const rival of this.rivals) {
      if (rival.typeName === typeName) {
        n++
      }
    }
    return n
  }

  // Optional modules a ship type can turn up with. Each arm's chance ramps with
  // how far past the type's spawn sector this one is, up to the arm's cap.
  rollLoadout(type) {
    const loadout = (type.loadout || []).slice()
    const ramp = Math.max(0, this.level - type.spawn.fromSector)
    for (const arm of Object.values(type.arms || {})) {
      if (Math.random() < clamp(ramp * arm.chancePerSector, 0, arm.chanceCap)) {
        loadout.push(arm)
      }
    }
    return loadout
  }

  spawnRival() {
    // enter from the arena boundary at a random bearing
    const edgeAngle = randRange(0, TAU),
      x = ARENA.cx + Math.cos(edgeAngle) * (ARENA.radius - 20),
      y = ARENA.cy + Math.sin(edgeAngle) * (ARENA.radius - 20)
    // roll each gated ship type in turn, then fall back to the basic rival
    let fallbackName = null
    for (const [name, type] of Object.entries(SHIP_TYPES)) {
      if (type.spawn.fallback) {
        fallbackName = name
        continue
      }
      if (
        this.level >= type.spawn.fromSector &&
        this.countRivals(name) < type.spawn.maxConcurrent &&
        Math.random() < type.spawn.chance
      ) {
        this.rivals.push(new RivalShip(x, y, name))
        return
      }
    }
    const fallback = SHIP_TYPES[fallbackName]
    this.rivals.push(new RivalShip(x, y, fallbackName, this.rollLoadout(fallback)))
  }

  shatterToOre(asteroid) {
    const count = clamp(Math.round(asteroid.area / CONFIG.ORE_PER_ROCK_AREA) + 2, 2, 6)
    for (let k = 0; k < count; k++) {
      this.spawnOre(
        asteroid.center.x + randRange(-asteroid.boundRadius * 0.5, asteroid.boundRadius * 0.5),
        asteroid.center.y + randRange(-asteroid.boundRadius * 0.5, asteroid.boundRadius * 0.5),
        asteroid.vx + randRange(-70, 70),
        asteroid.vy + randRange(-70, 70),
      )
    }
    this.burst(asteroid.center.x, asteroid.center.y, randInt(8, 16), PALETTE.ore.body, 40, 170, 0.7)
    Sound.shatter()
    this.stats.mined++
  }

  // ---- beam resolution -------------------------------------------------
  // A single beam from `attacker` (via `weapon`). Cuts unshielded rocks,
  // drains energy from anything with a laser-blocking shield, damages ships
  // within the beam's width, and never harms the attacker. Returns didHit.
  applyBeam(beam, attacker, weapon) {
    let didHit = false
    const damage = weapon.type.damage
    const width = weapon.type.width || 2.4

    // The beam stops at the first ship it strikes: find the nearest ship whose
    // body the beam enters, remember it so we can damage exactly that one, and
    // truncate the beam to its near surface so it can't cut rocks beyond it.
    const fullLen = Math.hypot(beam.b.x - beam.a.x, beam.b.y - beam.a.y)
    let blockDist = fullLen
    let blockShip = null
    const considerShip = (e, radius) => {
      const reach = width * 0.6 + radius
      const t = (e.x - beam.a.x) * beam.dir.x + (e.y - beam.a.y) * beam.dir.y
      if (t < 0) {
        return
      }
      const cx = beam.a.x + beam.dir.x * t,
        cy = beam.a.y + beam.dir.y * t
      const perp = Math.hypot(e.x - cx, e.y - cy)
      if (perp >= reach) {
        return
      }
      // near surface facing the shooter: beam ends here and the shield flashes here
      const tEntry = t - Math.sqrt(reach * reach - perp * perp)
      if (tEntry < blockDist) {
        blockDist = Math.max(0, tEntry)
        blockShip = e
      }
    }
    for (const rival of this.rivals) {
      if (rival !== attacker && !rival.dead) {
        considerShip(rival, rival.size)
      }
    }
    if (this.player && attacker !== this.player) {
      considerShip(this.player, this.player.radius)
    }
    // An unshielded frigate is sliced in two like a rock (see below) rather than
    // blocking the beam, so it is not truncated against.
    const blockShielded = blockShip && blockShip.shieldModule() && blockShip.shieldModule().up
    const cuttable = blockShip && blockShip.type.sliceable && !blockShielded
    if (blockShip && !cuttable) {
      beam.b.x = beam.a.x + beam.dir.x * blockDist
      beam.b.y = beam.a.y + beam.dir.y * blockDist
    }

    const survivors = []
    for (const asteroid of this.asteroids) {
      if (asteroid === attacker) {
        survivors.push(asteroid)
        continue
      }
      if (countBeamCrossings(beam, asteroid.vertices) < 2) {
        survivors.push(asteroid)
        continue
      }
      const shield = asteroid.shieldModule()
      if (shield && shield.up && shield.blocks("laser") && asteroid.energy > 0) {
        asteroid.energy = Math.max(0, asteroid.energy - damage)
        // flash the side facing the shooter and spark there
        const toShooter = Math.atan2(beam.a.y - asteroid.center.y, beam.a.x - asteroid.center.x)
        shield.hitAt(toShooter)
        const ex = asteroid.center.x + Math.cos(toShooter) * asteroid.boundRadius,
          ey = asteroid.center.y + Math.sin(toShooter) * asteroid.boundRadius
        this.ring(ex, ey, 8, SHIELD_SPARK, 120, 0.35)
        this.burst(ex, ey, 4, SHIELD_SPARK, 30, 120, 0.3)
        if (shield.checkOverload(asteroid)) {
          this.burst(asteroid.center.x, asteroid.center.y, 16, SHIELD_SPARK, 50, 210, 0.6)
        }
        didHit = true
        survivors.push(asteroid)
        continue
      }
      if (asteroid.explosive) {
        if (asteroid.fuse == null) {
          asteroid.fuse = 0.04
        }
        didHit = true
        survivors.push(asteroid)
        continue
      }
      if (
        attacker === this.player &&
        Math.random() < CONFIG.LASER_INSTA_CHANCE[this.upgrades.laser]
      ) {
        this.shatterToOre(asteroid)
        didHit = true
        this.score += CONFIG.SLICE_SCORE
        // the effect beam follows the laser trajectory, ending level with the
        // rock (projected onto the beam) rather than veering to its centre
        const reach =
          (asteroid.center.x - beam.a.x) * beam.dir.x + (asteroid.center.y - beam.a.y) * beam.dir.y
        this.laserShots.push({
          beams: [
            {
              a: { x: beam.a.x, y: beam.a.y },
              b: { x: beam.a.x + beam.dir.x * reach, y: beam.a.y + beam.dir.y * reach },
              dir: beam.dir,
            },
          ],
          age: 0,
          color: PALETTE.ore.shatterBeam,
          width: 5.5,
          glow: 26,
          life: 0.5,
        })
        this.burst(
          asteroid.center.x,
          asteroid.center.y,
          randInt(14, 22),
          PALETTE.ore.shatterBeam,
          60,
          240,
          0.7,
        )
        this.ring(asteroid.center.x, asteroid.center.y, 16, PALETTE.ore.flash, 220, 0.5)
        Sound.fire()
        continue
      }
      const frags = asteroid.splitBy(beam, this)
      if (!frags) {
        survivors.push(asteroid)
        continue
      }
      didHit = true
      for (const f of frags) {
        survivors.push(f)
      }
      this.burst(
        asteroid.center.x,
        asteroid.center.y,
        randInt(16, 26),
        PALETTE.rock.cut,
        50,
        210,
        0.45,
      )
      if (attacker === this.player) {
        this.score += CONFIG.SLICE_SCORE
      }
    }
    this.asteroids = survivors
    if (didHit) {
      Sound.slice()
      this.screenShake = Math.max(this.screenShake, 4)
    }

    // Slice an unshielded frigate into drifting gun-rocks; otherwise damage the
    // struck ship on its shooter-facing side.
    if (blockShip) {
      if (cuttable && this.sliceFrigate(blockShip, beam, attacker === this.player)) {
        didHit = true
      } else {
        if (cuttable) {
          // grazing cut that didn't split cleanly: truncate and damage instead
          beam.b.x = beam.a.x + beam.dir.x * blockDist
          beam.b.y = beam.a.y + beam.dir.y * blockDist
        }
        const hit = { x: beam.b.x, y: beam.b.y }
        const fromPlayer = attacker === this.player
        const scoreOnKill = fromPlayer && blockShip !== this.player ? blockShip.type.killScore : 0
        blockShip.takeDamage(damage, this, "laser", scoreOnKill, hit)
        this.burst(hit.x, hit.y, randInt(3, 6), weapon.type.colour, 30, 130, 0.35)
        didHit = true
      }
    }
    return didHit
  }

  // Slice an unshielded frigate along the beam into two Asteroid fragments that
  // carry its surviving turrets, so the pieces drift apart, keep firing, and can
  // be cut again with normal rock handling. Returns false if the beam only
  // grazes it (no clean two-way split).
  sliceFrigate(ship, beam, fromPlayer) {
    const cutNormal = perpendicular(beam.dir)
    // slice the real (concave) hull outline; the slicer handles it directly and
    // may return more than two pieces
    const parts = slicePolygon(ship.worldOutline(), beam.a, cutNormal)
    if (parts.length < 2) {
      return false
    }
    // the frigate's autocannon turrets, in world space, to hand to the pieces
    const guns = []
    for (const hp of ship.hardpoints) {
      const m = hp.module
      if (m && m.kind === "weapon" && m.controller === "turret") {
        const w = ship.mountWorld(hp.local)
        guns.push({ x: w.x, y: w.y, module: m })
      }
    }
    for (const partVerts of parts) {
      const centre = polygonCentroid(partVerts)
      const area = polygonArea(partVerts)
      const side = dot(subtract(centre, beam.a), cutNormal) > 0 ? 1 : -1
      const ix = cutNormal.x * side * CONFIG.SPLIT_IMPULSE,
        iy = cutNormal.y * side * CONFIG.SPLIT_IMPULSE
      // assign turrets to the piece that actually contains them (side-of-line
      // is ambiguous once a concave cut yields more than two pieces)
      const mine = guns.filter((g) => pointInPolygon(g, partVerts))
      // burning debris at the cut end
      this.burst(centre.x, centre.y, randInt(10, 16), PALETTE.fx.fire, 40, 190, 0.75)
      this.burst(centre.x, centre.y, randInt(6, 10), PALETTE.fx.ember, 30, 130, 0.5)
      // a gunless sliver just becomes ore; a piece with turrets survives as a
      // gun-rock so it can keep firing, even if small
      if (area < CONFIG.SHIP_DEBRIS_MIN_AREA && mine.length === 0) {
        for (let k = 0; k < 3; k++) {
          this.spawnOre(
            centre.x + randRange(-12, 12),
            centre.y + randRange(-12, 12),
            ship.vx + ix,
            ship.vy + iy,
          )
        }
        continue
      }
      this.asteroids.push(
        new Asteroid({
          vertices: partVerts,
          vx: ship.vx + ix,
          vy: ship.vy + iy,
          spin: randRange(-1.2, 1.2),
          hardpoints: mine,
          tint: ship.colour, // keep the frigate's colour on the debris
        }),
      )
    }
    this.ring(ship.x, ship.y, 16, PALETTE.fx.flash, 190, 0.6)
    this.screenShake = Math.max(this.screenShake, 9)
    Sound.explode()
    if (fromPlayer) {
      this.score += ship.type.blastScore
    }
    ship.dead = true
    return true
  }

  // ---- level / sector flow --------------------------------------------
  rollHazardTraits(sector) {
    const pool = ["explosive"]
    if (sector >= 4) {
      pool.push("shield")
    }
    if (sector >= 5) {
      const guns = 1 + Math.max(0, sector - 5)
      for (let i = 0; i < guns; i++) {
        pool.push("gun")
      }
    }
    if (sector >= 6) {
      pool.push("gunshield")
    }
    switch (pick(pool)) {
      case "shield":
        return { shield: true }
      case "gun":
        return { gun: true }
      case "gunshield":
        return { gun: true, shield: true }
      default:
        return { explosive: true }
    }
  }

  planLevel(sector) {
    const count = Math.min(1 + Math.ceil(sector * 0.9), 11)
    const hazardChance = sector < 3 ? 0 : clamp(0.14 + (sector - 3) * 0.07, 0, 0.6)
    const spawns = []
    for (let i = 0; i < count; i++) {
      spawns.push({
        traits: sector >= 3 && Math.random() < hazardChance ? this.rollHazardTraits(sector) : {},
        radius: randRange(CONFIG.AST_MAX_R * 0.72, CONFIG.AST_MAX_R),
      })
    }
    return {
      spawns,
      powerups: sector >= 3,
      rivals:
        sector < RIVALS_FROM_SECTOR
          ? 0
          : Math.min(1 + Math.floor((sector - RIVALS_FROM_SECTOR) / 3), 3),
      rivalInterval: clamp(28 - sector * 1.4, 9, 28),
    }
  }

  startLevel(sector) {
    this.level = sector
    this.plan = this.planLevel(sector)
    this.backdrop.regenSector(sector) // seeded backdrop for this sector's vibe
    this.asteroids = []
    this.oreChunks = []
    this.projectiles = []
    this.powerupPickups = []
    this.rivals = []
    this.laserShots = []
    this.particles = []
    this.stats = this.blankStats()
    this.summaryData = null
    this.oreVacuum = false

    for (const spawn of this.plan.spawns) {
      // scatter across the arena disc, clear of the ship spawn at the centre
      let x,
        y,
        tries = 0
      do {
        const a = randRange(0, TAU),
          rr = Math.sqrt(Math.random()) * (ARENA.radius - 120)
        x = ARENA.cx + Math.cos(a) * rr
        y = ARENA.cy + Math.sin(a) * rr
        tries++
      } while (Math.hypot(x - ARENA.cx, y - ARENA.cy) < 220 && tries < 50)
      const angle = randRange(0, TAU),
        speed = randRange(30, 74)
      this.asteroids.push(
        new Asteroid({
          x,
          y,
          radius: spawn.radius,
          traits: spawn.traits,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          spin: randRange(-0.6, 0.6),
        }),
      )
    }

    this.powerupTimer = randRange(6, 10)
    this.rivalTimer = this.plan.rivalInterval * 0.6
    this.clearTimer = 0
    const p = this.player
    p.x = ARENA.cx
    p.y = ARENA.cy
    p.vx = 0
    p.vy = 0
    p.invincible = CONFIG.INVIN_TIME
    p.energyMax = this.maxEnergy()
    p.energy = p.energyMax
    // a new sector has nowhere to pan from, so place the camera outright
    this.viewCenter.x = p.x
    this.viewCenter.y = p.y
    this.clearInput() // drop keys held over from the shop so the laser starts uncharged
    p.beginWarpIn(CONFIG.WARP_ARRIVE_PAUSE)
    this.phase = "arriving"
    Sound.level()
  }

  startNewGame() {
    this.score = 0
    this.rivalScore = 0
    this.lives = CONFIG.START_LIVES
    this.oreBalance = 0
    this.upgrades = freshUpgrades()
    this.player = new PlayerShip(this)
    this.startLevel(1)
  }

  enterShop() {
    this.oreVacuum = false
    // sweep up any ore still on the field
    const remaining = this.oreChunks.length
    this.score += remaining * CONFIG.ORE_SCORE
    this.stats.ore += remaining
    this.oreBalance += remaining
    this.oreChunks.length = 0

    const accuracy = this.stats.shots ? this.stats.hits / this.stats.shots : 1
    const accuracyBonus = Math.round(accuracy * CONFIG.ACCURACY_BONUS)
    const flawlessBonus = this.stats.damage < 1 ? CONFIG.FLAWLESS_BONUS : 0
    const clearBonus = this.level * CONFIG.CLEAR_BONUS_PER_SECTOR
    const totalBonus = accuracyBonus + flawlessBonus + clearBonus
    this.score += totalBonus
    this.summaryData = {
      level: this.level,
      accuracy,
      mined: this.stats.mined,
      ore: this.stats.ore,
      damage: Math.round(this.stats.damage),
      accuracyBonus,
      flawlessBonus,
      clearBonus,
      totalBonus,
    }
    this.recordBest()
    this.shopSelection = 0
    this.shopSector = this.level + 1
    this.phase = "shop"
  }

  doShopAction() {
    if (this.shopSelection === SHOP.length) {
      this.startLevel(this.shopSector)
      return
    }
    const item = SHOP[this.shopSelection]
    if (item.maxed(this)) {
      return
    }
    const cost = item.cost(this)
    if (!this.devMode) {
      if (this.oreBalance < cost) {
        Sound.hit()
        return
      }
      this.oreBalance -= cost
    }
    item.apply(this)
    Sound.power()
  }

  recordBest() {
    let changed = false
    if (this.score > this.best.score) {
      this.best.score = this.score
      changed = true
    }
    if (this.level > this.best.sector) {
      this.best.sector = this.level
      changed = true
    }
    if (changed) {
      saveBest(this.best)
    }
  }

  playerLoseLife() {
    this.lives--
    Sound.explode()
    this.burst(this.player.x, this.player.y, 40, PALETTE.player.hull, 60, 260, 1.0)
    this.ring(this.player.x, this.player.y, 20, PALETTE.text.bright, 200, 0.8)
    this.screenShake = 14
    // count this hit as damage for the summary
    this.stats.damage += 1
    if (this.lives <= 0) {
      this.recordBest()
      this.phase = "over"
      Sound.setThruster(false)
      return
    }
    // Move to the spawn point straight away but stay warped out for a beat, so
    // there is a moment to take stock. The camera is deliberately not moved
    // with it: it pans across from wherever the wreck was.
    const p = this.player
    p.x = ARENA.cx
    p.y = ARENA.cy
    p.vx = 0
    p.vy = 0
    p.energy = this.maxEnergy() * 0.6
    p.invincible = CONFIG.INVIN_TIME
    p.mainWeapon.charge = 0
    p.beginWarpIn(CONFIG.RESPAWN_PAUSE)
    this.phase = "arriving"
    this.clearInput()
  }

  usePowerupSlot(index) {
    const player = this.player,
      id = player.items[index]
    if (id === undefined) {
      return
    }
    const type = POWERUP_TYPES[id]
    player.items.splice(index, 1)
    Sound.power()
    this.showToast(`${type.label} ACTIVATED`)
    if (type.seconds) {
      player.grantBuff(id, type.seconds)
    }
    if (type.apply) {
      type.apply(this, player, type)
    }
  }

  // ---- per-frame update ------------------------------------------------
  update(dt) {
    if (this.screenShake > 0) {
      this.screenShake = Math.max(0, this.screenShake - dt * 22)
    }
    if (this.toast) {
      this.toast.life -= dt
      if (this.toast.life <= 0) {
        this.toast = null
      }
    }

    if (this.phase === "play") {
      if (this.plan.powerups) {
        this.powerupTimer -= dt
        if (this.powerupTimer <= 0 && this.powerupPickups.length < 2) {
          this.spawnPowerup()
          this.powerupTimer = randRange(12, 20)
        }
      }
      if (this.plan.rivals > 0) {
        this.rivalTimer -= dt
        if (this.rivalTimer <= 0 && this.rivals.length < this.plan.rivals) {
          this.spawnRival()
          this.rivalTimer = this.plan.rivalInterval
        }
      }
    }

    this.player.update(dt, this)
    // camera eases toward the ship, clamped so it never scrolls far past the
    // arena edge (a band of the out-of-bounds zone stays visible, no more)
    const followRate = this.player.warping ? CONFIG.CAMERA_WARP_FOLLOW : CONFIG.CAMERA_FOLLOW
    const follow = Math.min(1, dt * followRate)
    let panX = (this.player.x - this.viewCenter.x) * follow
    let panY = (this.player.y - this.viewCenter.y) * follow
    // An exponential ease moves fastest on its first frame, which over the
    // distance from a wreck to the spawn point lurches before it glides. Cap
    // the speed so a long pan travels evenly and still settles softly.
    const panStep = Math.hypot(panX, panY)
    const panLimit = CONFIG.CAMERA_MAX_PAN * dt
    if (panStep > panLimit) {
      panX *= panLimit / panStep
      panY *= panLimit / panStep
    }
    this.viewCenter.x += panX
    this.viewCenter.y += panY
    const dcx = this.viewCenter.x - ARENA.cx,
      dcy = this.viewCenter.y - ARENA.cy
    const camDist = Math.hypot(dcx, dcy)
    const maxCamDist = ARENA.radius - CONFIG.CAMERA_MARGIN
    if (camDist > maxCamDist) {
      this.viewCenter.x = ARENA.cx + (dcx / camDist) * maxCamDist
      this.viewCenter.y = ARENA.cy + (dcy / camDist) * maxCamDist
    }
    for (const asteroid of this.asteroids) {
      asteroid.update(dt, this)
    }
    this.resolveAsteroidCollisions()
    this.asteroids = this.asteroids.filter((a) => !a.dead)
    for (const projectile of this.projectiles) {
      projectile.update(dt, this)
    }
    this.projectiles = this.projectiles.filter((p) => !p.dead)
    for (const chunk of this.oreChunks) {
      chunk.update(dt, this)
    }
    this.oreChunks = this.oreChunks.filter((o) => !o.dead)
    for (const pickup of this.powerupPickups) {
      pickup.update(dt, this)
    }
    this.powerupPickups = this.powerupPickups.filter((p) => !p.dead)
    for (const rival of this.rivals) {
      rival.update(dt, this)
    }
    this.rivals = this.rivals.filter((r) => !r.dead)
    this.updateParticles(dt)
    for (let i = this.laserShots.length - 1; i >= 0; i--) {
      this.laserShots[i].age += dt
      if (this.laserShots[i].age > (this.laserShots[i].life || 0.4)) {
        this.laserShots.splice(i, 1)
      }
    }

    if (this.phase === "arriving") {
      if (!this.player.warping) {
        this.phase = "play"
      }
    } else if (this.phase === "play" && this.asteroids.length === 0) {
      this.phase = "clearing"
      this.clearTimer = CONFIG.CLEAR_DELAY
      this.oreVacuum = true
    } else if (this.phase === "clearing") {
      // hold here until the vacuum has actually swept every chunk in; the timer
      // is only a failsafe for ore that somehow cannot reach the ship
      this.clearTimer -= dt
      if (this.oreChunks.length === 0 || this.clearTimer <= 0) {
        this.phase = "departing"
        this.player.beginWarpOut()
      }
    } else if (this.phase === "departing" && !this.player.warping) {
      this.enterShop()
    }
  }

  // Age every particle and compact the survivors down in place, then drop the
  // oldest if the frame's emitters overshot the budget.
  updateParticles(dt) {
    const list = this.particles
    const drag = Math.pow(PARTICLE_DRAG, dt)
    let write = 0
    for (let read = 0; read < list.length; read++) {
      const q = list[read]
      q.life -= dt
      if (q.life <= 0) {
        continue
      }
      q.x += q.vx * dt
      q.y += q.vy * dt
      q.vx *= drag
      q.vy *= drag
      list[write++] = q
    }
    list.length = write
    if (list.length > MAX_PARTICLES) {
      list.splice(0, list.length - MAX_PARTICLES)
    }
  }

  // Rock against rock: reject on the enclosing circles, then solve the real
  // outlines. Overlap is eased out over a few frames rather than corrected in
  // one step, so a contact settles instead of flicking apart, and a small slop
  // is tolerated so resting rocks do not jitter against each other.
  resolveAsteroidCollisions() {
    const list = this.asteroids
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i],
          b = list[j]
        const dx = b.center.x - a.center.x,
          dy = b.center.y - a.center.y
        const reach = a.boundRadius + b.boundRadius
        if (dx * dx + dy * dy >= reach * reach) {
          continue
        }
        const contact = convexContact(a.vertices, b.vertices, a.center, b.center)
        if (!contact) {
          continue
        }
        const ux = contact.nx,
          uy = contact.ny
        const push = Math.max(0, contact.depth - CONFIG.CONTACT_SLOP) * CONFIG.CONTACT_BIAS * 0.5
        if (push > 0) {
          a.translate(-ux * push, -uy * push)
          b.translate(ux * push, uy * push)
        }
        const relativeNormalVel = (b.vx - a.vx) * ux + (b.vy - a.vy) * uy
        if (relativeNormalVel < 0) {
          a.vx += ux * relativeNormalVel
          a.vy += uy * relativeNormalVel
          b.vx -= ux * relativeNormalVel
          b.vy -= uy * relativeNormalVel
          if (Math.abs(relativeNormalVel) > 60) {
            this.burst(
              (a.center.x + b.center.x) / 2,
              (a.center.y + b.center.y) / 2,
              3,
              PALETTE.rock.impact,
              30,
              90,
              0.3,
            )
          }
        }
      }
    }
  }

  // ---- input -----------------------------------------------------------
  onKeyDown(e) {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) {
      e.preventDefault()
    }

    const left = e.code === "ArrowLeft" || e.code === "KeyA"
    const right = e.code === "ArrowRight" || e.code === "KeyD"
    if (this.phase === "shop" && this.devMode && (left || right)) {
      const step = this.pressedKeys.has("ShiftLeft") || this.pressedKeys.has("ShiftRight") ? 10 : 1
      this.shopSector = Math.max(1, this.shopSector + (right ? step : -step))
      this.pressedKeys.add(e.code)
      return
    }
    if (e.repeat) {
      this.pressedKeys.add(e.code)
      return
    }

    if (this.phase === "shop") {
      const count = SHOP.length + 1
      if (e.code === "ArrowUp" || e.code === "KeyW") {
        this.shopSelection = (this.shopSelection - 1 + count) % count
      } else if (e.code === "ArrowDown" || e.code === "KeyS") {
        this.shopSelection = (this.shopSelection + 1) % count
      } else if (e.code === "Enter") {
        this.doShopAction()
      }
    } else if (e.code === "Enter" && (this.phase === "title" || this.phase === "over")) {
      this.startNewGame()
    }

    if (e.code === "KeyP" && this.inSector()) {
      this.paused = !this.paused
      if (this.paused) {
        Sound.setThruster(false)
      }
    }
    if (this.phase === "play" && !this.paused) {
      const slot = SLOT_KEYS[e.code]
      if (slot !== undefined) {
        this.usePowerupSlot(slot)
      }
    }
    this.pressedKeys.add(e.code)
  }

  onKeyUp(e) {
    this.pressedKeys.delete(e.code)
    if (e.code === "Space" && this.player) {
      if (this.phase === "play" && !this.paused) {
        this.player.fireLaser(this)
      }
      this.player.mainWeapon.charge = 0
    }
  }

  onBlur() {
    this.clearInput()
  }

  // Drop held keys and any accumulated laser charge. Used on focus loss and at
  // the start of a level so input never carries across a phase transition.
  clearInput() {
    this.pressedKeys.clear()
    Sound.setThruster(false)
    if (this.player) {
      this.player.mainWeapon.charge = 0
    }
  }

  enterDevShop() {
    if (!this.player || this.phase === "title" || this.phase === "over") {
      this.startNewGame()
    }
    this.devMode = true
    this.enterShop()
  }

  // Advance the simulation one step. Rendering is the view's job; main.js
  // paints via GameView after this returns.
  advance(dt) {
    this.gameTime += dt
    // the backdrop only parallaxes against a ship that is actually flying
    const flying = this.player && this.phase === "play"
    this.backdrop.update(dt, flying ? this.player.vx : 0, flying ? this.player.vy : 0)
    if (this.phase === "title") {
      this.backdrop.updateMenu(dt)
    } else if (this.inSector() && !this.paused) {
      this.update(dt)
    }
  }
}
