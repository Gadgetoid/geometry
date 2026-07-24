// The Game owns all mutable state and orchestrates the simulation: update,
// level flow, the shop, and beam resolution. Painting lives in GameView
// (view.js), which reads this state. Entities receive the game instance and
// read / mutate its public fields; nothing here reaches for module globals.

import {
  VIEW_W,
  VIEW_H,
  TAU,
  CONFIG,
  SHIP_TYPES,
  SHOP,
  POWERUP_TYPES,
  POWERUP_LABEL,
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
  countBeamCrossings,
  distanceToSegment,
} from "./math.js"
import { Sound } from "./audio.js"
import { loadBest, saveBest } from "./persistence.js"
import { Asteroid, Ore, Powerup, PlayerShip, RivalShip, makeAsteroidPolygon } from "./entities.js"

const PARTICLE_LIFE = 5 // global lifetime multiplier
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

export class Game {
  constructor() {
    this.phase = "title" // title | play | clearing | shop | over
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

    this.initBackground()
    loadBest().then((value) => {
      if (value) {
        this.best = value
      }
    })
  }

  blankStats() {
    return { shots: 0, hits: 0, damage: 0, ore: 0, mined: 0 }
  }
  maxEnergy() {
    return CONFIG.CORE_MAX[this.upgrades.core]
  }
  showToast(text) {
    this.toast = { text, life: 2.6 }
  }

  // ---- particles -------------------------------------------------------
  emit(x, y, vx, vy, baseLife, color) {
    const life = baseLife * PARTICLE_LIFE
    this.particles.push({ x, y, vx, vy, life, maxLife: life, color })
    if (this.particles.length > MAX_PARTICLES) {
      this.particles.splice(0, this.particles.length - MAX_PARTICLES)
    }
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
    if (this.particles.length > MAX_PARTICLES) {
      this.particles.splice(0, this.particles.length - MAX_PARTICLES)
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
    if (this.particles.length > MAX_PARTICLES) {
      this.particles.splice(0, this.particles.length - MAX_PARTICLES)
    }
  }

  // ---- spawning --------------------------------------------------------
  spawnOre(x, y, vx, vy) {
    this.oreChunks.push(new Ore(x, y, vx, vy))
  }

  spawnPowerup() {
    const type = pick(POWERUP_TYPES)
    const side = randInt(0, 3)
    let x, y
    if (side === 0) {
      x = randRange(0, VIEW_W)
      y = -20
    } else if (side === 1) {
      x = VIEW_W + 20
      y = randRange(0, VIEW_H)
    } else if (side === 2) {
      x = randRange(0, VIEW_W)
      y = VIEW_H + 20
    } else {
      x = -20
      y = randRange(0, VIEW_H)
    }
    const dir = normalize(subtract({ x: VIEW_W / 2, y: VIEW_H / 2 }, { x, y }))
    this.powerupPickups.push(
      new Powerup(x, y, dir.x * randRange(24, 40), dir.y * randRange(24, 40), type),
    )
  }

  spawnRival() {
    const side = randInt(0, 1),
      x = side ? -50 : VIEW_W + 50,
      y = randRange(90, VIEW_H - 90)
    const asFrigate =
      this.level >= CONFIG.FRIGATE_FROM_SECTOR &&
      Math.random() < 0.3 &&
      !this.rivals.some((r) => r.typeName === "frigate")
    if (asFrigate) {
      this.rivals.push(new RivalShip(x, y, "frigate"))
      return
    }
    // A scout always has its mining laser and rolls a gun and/or a shield.
    const scout = SHIP_TYPES.scout
    const ramp = Math.max(0, this.level - CONFIG.RIVAL_FROM_SECTOR)
    const loadout = scout.loadout.slice()
    if (Math.random() < clamp(ramp * CONFIG.RIVAL_GUN_CHANCE, 0, CONFIG.RIVAL_GUN_CHANCE_CAP)) {
      loadout.push({
        hp: scout.arms.gun.hp,
        weapon: scout.arms.gun.weapon,
        controller: scout.arms.gun.controller,
      })
    }
    if (
      Math.random() < clamp(ramp * CONFIG.RIVAL_SHIELD_CHANCE, 0, CONFIG.RIVAL_SHIELD_CHANCE_CAP)
    ) {
      loadout.push({ hp: scout.arms.shield.hp, shield: scout.arms.shield.shield })
    }
    this.rivals.push(new RivalShip(x, y, "scout", loadout))
  }

  shatterToOre(asteroid) {
    const count = clamp(Math.round(asteroid.area / 900) + 2, 2, 6)
    for (let k = 0; k < count; k++) {
      this.spawnOre(
        asteroid.center.x + randRange(-asteroid.boundRadius * 0.5, asteroid.boundRadius * 0.5),
        asteroid.center.y + randRange(-asteroid.boundRadius * 0.5, asteroid.boundRadius * 0.5),
        asteroid.vx + randRange(-70, 70),
        asteroid.vy + randRange(-70, 70),
      )
    }
    this.burst(asteroid.center.x, asteroid.center.y, randInt(8, 16), "#ff8ae6", 40, 170, 0.7)
    this.stats.mined++
  }

  // ---- beam resolution -------------------------------------------------
  // A single beam from `attacker` (via `weapon`). Cuts unshielded rocks,
  // drains energy from anything with a laser-blocking shield, damages ships
  // within the beam's width, and never harms the attacker. Returns didHit.
  applyBeam(beam, attacker, weapon) {
    let didHit = false
    const damage = weapon.type.damage
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
        this.ring(asteroid.center.x, asteroid.center.y, 10, SHIELD_SPARK, 120, 0.4)
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
        this.laserShots.push({
          beams: [
            {
              a: { x: beam.a.x, y: beam.a.y },
              b: { x: asteroid.center.x, y: asteroid.center.y },
              dir: beam.dir,
            },
          ],
          age: 0,
          color: "#ff8af0",
          width: 5.5,
          glow: 26,
          life: 0.5,
        })
        this.burst(asteroid.center.x, asteroid.center.y, randInt(14, 22), "#ff8af0", 60, 240, 0.7)
        this.ring(asteroid.center.x, asteroid.center.y, 16, "#ffffff", 220, 0.5)
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
      this.burst(asteroid.center.x, asteroid.center.y, randInt(16, 26), "#dbeeff", 50, 210, 0.45)
      if (attacker === this.player) {
        this.score += CONFIG.SLICE_SCORE
      }
    }
    this.asteroids = survivors
    if (didHit) {
      Sound.slice()
      this.screenShake = Math.max(this.screenShake, 4)
    }

    // Ships caught within the beam's width take laser damage (energy or hull).
    const width = weapon.type.width || 2.4
    const fromPlayer = attacker === this.player
    for (const rival of this.rivals) {
      if (rival === attacker || rival.dead) {
        continue
      }
      if (
        distanceToSegment(rival.x, rival.y, beam.a.x, beam.a.y, beam.b.x, beam.b.y) <
        width * 0.6 + rival.size
      ) {
        rival.takeDamage(damage, this, "laser", fromPlayer ? rival.type.killScore : 0)
        didHit = true
      }
    }
    const p = this.player
    if (
      p &&
      attacker !== p &&
      distanceToSegment(p.x, p.y, beam.a.x, beam.a.y, beam.b.x, beam.b.y) < width * 0.6 + p.radius
    ) {
      p.takeDamage(damage, this, "laser")
      didHit = true
    }
    return didHit
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
        sector < CONFIG.RIVAL_FROM_SECTOR
          ? 0
          : Math.min(1 + Math.floor((sector - CONFIG.RIVAL_FROM_SECTOR) / 3), 3),
      rivalInterval: clamp(28 - sector * 1.4, 9, 28),
    }
  }

  startLevel(sector) {
    this.level = sector
    this.plan = this.planLevel(sector)
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
      let x,
        y,
        tries = 0
      do {
        x = randRange(90, VIEW_W - 90)
        y = randRange(90, VIEW_H - 90)
        tries++
      } while (Math.hypot(x - VIEW_W / 2, y - VIEW_H / 2) < 180 && tries < 50) // keep clear of the ship spawn
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
    p.x = VIEW_W / 2
    p.y = VIEW_H / 2
    p.vx = 0
    p.vy = 0
    p.invincible = CONFIG.INVIN_TIME
    p.energyMax = this.maxEnergy()
    p.energy = p.energyMax
    this.clearInput() // drop keys held over from the shop so the laser starts uncharged
    this.phase = "play"
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
    for (const chunk of this.oreChunks) {
      this.score += CONFIG.ORE_SCORE
      this.stats.ore++
      this.oreBalance++
    }
    this.oreChunks.length = 0

    const accuracy = this.stats.shots ? this.stats.hits / this.stats.shots : 1
    const accuracyBonus = Math.round(accuracy * 500)
    const flawlessBonus = this.stats.damage < 1 ? 800 : 0
    const clearBonus = this.level * 150
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
    this.burst(this.player.x, this.player.y, 40, "#5fd7ff", 60, 260, 1.0)
    this.ring(this.player.x, this.player.y, 20, "#eaf4ff", 200, 0.8)
    this.screenShake = 14
    // count this hit as damage for the summary
    this.stats.damage += 1
    if (this.lives <= 0) {
      this.recordBest()
      this.phase = "over"
      return
    }
    const p = this.player
    p.x = VIEW_W / 2
    p.y = VIEW_H / 2
    p.vx = 0
    p.vy = 0
    p.energy = this.maxEnergy() * 0.6
    p.invincible = CONFIG.INVIN_TIME
    p.mainWeapon.charge = 0
  }

  usePowerupSlot(index) {
    const p = this.player,
      type = p.items[index]
    if (type === undefined) {
      return
    }
    p.items.splice(index, 1)
    Sound.power()
    this.showToast(`${POWERUP_LABEL[type]} ACTIVATED`)
    if (type === "repel") {
      for (const asteroid of this.asteroids) {
        const d = normalize(subtract(asteroid.center, p))
        asteroid.vx += d.x * 300
        asteroid.vy += d.y * 300
        asteroid.spin += randRange(-3, 3)
      }
      for (const bullet of this.projectiles) {
        const d = normalize(subtract(bullet, p))
        const s = Math.max(CONFIG.BULLET_SPEED, Math.hypot(bullet.vx, bullet.vy))
        bullet.vx = d.x * s
        bullet.vy = d.y * s
      }
      this.ring(p.x, p.y, 40, "#ff6bd0", 260, 0.7)
      this.screenShake = 9
    } else if (type === "refuel") {
      p.energy = this.maxEnergy()
      this.ring(p.x, p.y, 24, "#57e39a", 150, 0.6)
    } else if (type === "booster") {
      p.boosterTime = 6.5
      this.burst(p.x, p.y, 20, "#ffcf5c", 40, 140, 0.6)
    } else if (type === "multi") {
      p.multiTime = 9
    } else if (type === "magnet") {
      p.magnetTime = 6.5
    }
  }

  // ---- background ------------------------------------------------------
  initBackground() {
    this.stars = []
    for (let i = 0; i < 170; i++) {
      const depth = Math.pow(Math.random(), 1.6) * 0.88 + 0.12
      this.stars.push({
        x: Math.random() * VIEW_W,
        y: Math.random() * VIEW_H,
        depth,
        twinkle: Math.random() * TAU,
        vx: randRange(-2, 2),
        vy: randRange(-1.4, 1.4),
      })
    }
    // Distant procedural planets. Muted palettes; each carries a seed and a
    // light direction for the renderer's sphere shader. They sit on the far
    // parallax layer (low depth) and drift slowly.
    const palettes = [
      { base: "#2f3d54", hi: "#5b6f88", atmo: "#7aa3c8" }, // slate blue
      { base: "#2b423f", hi: "#4f6f68", atmo: "#79b6a8" }, // muted teal
      { base: "#4a3540", hi: "#6f5560", atmo: "#b98a9a" }, // dusty rose
      { base: "#453a2c", hi: "#6e5f45", atmo: "#c8a06a" }, // ochre sand
      { base: "#3a3550", hi: "#5f5878", atmo: "#9a8fc8" }, // violet grey
    ]
    this.planets = []
    for (let i = 0; i < 5; i++) {
      const pal = palettes[i % palettes.length]
      this.planets.push({
        x: randRange(-220, VIEW_W + 220),
        y: randRange(-160, VIEW_H + 160),
        r: randRange(46, 120),
        depth: randRange(0.05, 0.2), // far: barely parallaxes
        seed: randRange(0, 20),
        light: randRange(-Math.PI, Math.PI),
        drift: randRange(2, 6),
        ...pal,
      })
    }
    this.menuAsteroids = []
    for (let i = 0; i < 7; i++) {
      const x = randRange(90, VIEW_W - 90),
        y = randRange(90, VIEW_H - 90)
      this.menuAsteroids.push({
        vertices: makeAsteroidPolygon(x, y, randRange(24, 50)),
        center: { x, y },
        spin: randRange(-0.4, 0.4),
        vx: randRange(-16, 16),
        vy: randRange(-12, 12),
        hue: randInt(0, 359),
      })
    }
  }

  updateBackground(dt) {
    const pvx = this.player && this.phase === "play" ? this.player.vx : 0
    const pvy = this.player && this.phase === "play" ? this.player.vy : 0
    for (const star of this.stars) {
      star.x += (star.vx - pvx * star.depth * 0.06) * dt
      star.y += (star.vy - pvy * star.depth * 0.06) * dt
      if (star.x < 0) {
        star.x += VIEW_W
      } else if (star.x > VIEW_W) {
        star.x -= VIEW_W
      }
      if (star.y < 0) {
        star.y += VIEW_H
      } else if (star.y > VIEW_H) {
        star.y -= VIEW_H
      }
    }
    const marginX = 260,
      marginY = 200
    for (const planet of this.planets) {
      planet.x += (planet.drift * planet.depth - pvx * planet.depth * 0.04) * dt
      planet.y += -pvy * planet.depth * 0.04 * dt
      if (planet.x < -marginX) {
        planet.x += VIEW_W + marginX * 2
      } else if (planet.x > VIEW_W + marginX) {
        planet.x -= VIEW_W + marginX * 2
      }
      if (planet.y < -marginY) {
        planet.y += VIEW_H + marginY * 2
      } else if (planet.y > VIEW_H + marginY) {
        planet.y -= VIEW_H + marginY * 2
      }
    }
  }

  updateMenu(dt) {
    const wrapRock = (rock, dx, dy) => {
      for (const p of rock.vertices) {
        p.x += dx
        p.y += dy
      }
      rock.center.x += dx
      rock.center.y += dy
    }
    for (const rock of this.menuAsteroids) {
      const cosA = Math.cos(rock.spin * dt),
        sinA = Math.sin(rock.spin * dt)
      for (const p of rock.vertices) {
        const dx = p.x - rock.center.x,
          dy = p.y - rock.center.y
        p.x = rock.center.x + dx * cosA - dy * sinA + rock.vx * dt
        p.y = rock.center.y + dx * sinA + dy * cosA + rock.vy * dt
      }
      rock.center.x += rock.vx * dt
      rock.center.y += rock.vy * dt
      if (rock.center.x < -70) {
        wrapRock(rock, VIEW_W + 140, 0)
      } else if (rock.center.x > VIEW_W + 70) {
        wrapRock(rock, -(VIEW_W + 140), 0)
      }
      if (rock.center.y < -70) {
        wrapRock(rock, 0, VIEW_H + 140)
      } else if (rock.center.y > VIEW_H + 70) {
        wrapRock(rock, 0, -(VIEW_H + 140))
      }
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

    if (this.phase === "play" && this.asteroids.length === 0) {
      this.phase = "clearing"
      this.clearTimer = 2.4
      this.oreVacuum = true
    } else if (this.phase === "clearing") {
      this.clearTimer -= dt
      if (this.oreChunks.length === 0 || this.clearTimer <= 0) {
        this.enterShop()
      }
    }
  }

  updateParticles(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const q = this.particles[i]
      q.life -= dt
      q.x += q.vx * dt
      q.y += q.vy * dt
      q.vx *= Math.pow(0.4, dt)
      q.vy *= Math.pow(0.4, dt)
      if (q.life <= 0) {
        this.particles.splice(i, 1)
      }
    }
  }

  resolveAsteroidCollisions() {
    const list = this.asteroids
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i],
          b = list[j]
        if (
          (a.noCollideTimer && a.noCollideTimer > 0) ||
          (b.noCollideTimer && b.noCollideTimer > 0)
        ) {
          continue
        }
        const nx = b.center.x - a.center.x,
          ny = b.center.y - a.center.y
        const dist = Math.hypot(nx, ny),
          minDist = a.collideRadius + b.collideRadius
        if (dist > 1e-3 && dist < minDist) {
          const ux = nx / dist,
            uy = ny / dist,
            overlap = minDist - dist
          for (const p of a.vertices) {
            p.x -= (ux * overlap) / 2
            p.y -= (uy * overlap) / 2
          }
          a.center.x -= (ux * overlap) / 2
          a.center.y -= (uy * overlap) / 2
          for (const p of b.vertices) {
            p.x += (ux * overlap) / 2
            p.y += (uy * overlap) / 2
          }
          b.center.x += (ux * overlap) / 2
          b.center.y += (uy * overlap) / 2
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
                "#9fc0ff",
                30,
                90,
                0.3,
              )
            }
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

    if (e.code === "KeyP" && (this.phase === "play" || this.phase === "clearing")) {
      this.paused = !this.paused
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
    this.updateBackground(dt)
    if (this.phase === "title") {
      this.updateMenu(dt)
    } else if ((this.phase === "play" || this.phase === "clearing") && !this.paused) {
      this.update(dt)
    }
  }
}
