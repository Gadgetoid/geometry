// Entity classes and the shared combat model.
//
// Every host (player, rival, asteroid) is an Entity with an ENERGY pool and a
// set of HARDPOINTS. A hardpoint may hold a module:
//   * Weapon - a gun (projectile) or laser (beam) with a CONTROLLER that
//     decides when it fires. Firing spends the host's energy.
//   * Shield - turns incoming damage of the channels it blocks into energy
//     drain until the host's energy hits zero (then the hull takes it).
// takeDamage(amount, game, channel) is uniform for everyone.

import {
  randRange,
  randInt,
  clamp,
  lerp,
  subtract,
  normalize,
  magnitude,
  dot,
  pointInPolygon,
  convexHull,
  polygonArea,
  polygonCentroid,
  boundingRadius,
  perpendicular,
  slicePolygon,
} from "./math.js"
import {
  TAU,
  VIEW_W,
  VIEW_H,
  ARENA,
  CONFIG,
  WEAPON_TYPES,
  SHIELD_TYPES,
  SHIP_TYPES,
  PLAYER_TYPE,
  POWERUP_COLOUR,
  POWERUP_LABEL,
  SHIELD_SPARK,
} from "./config.js"
import { Sound } from "./audio.js"

// ---------------------------------------------------------------------------
// Base entity: position, velocity, energy pool, hardpoints, uniform damage.
// ---------------------------------------------------------------------------
export class Entity {
  constructor(x = 0, y = 0) {
    this.x = x
    this.y = y
    this.vx = 0
    this.vy = 0
    this.angle = 0
    this.dead = false
    this.energy = 0
    this.energyMax = 0
    this.regen = 0
    this.hardpoints = []
    this.fxCooldown = 0 // throttles repeated hit particles (e.g. asteroid grind)
  }

  integrate(dt) {
    this.x += this.vx * dt
    this.y += this.vy * dt
  }
  // Keep a point entity inside the circular arena: push it back to the boundary
  // and reflect any outward velocity. `margin` insets the limit (e.g. the ship's
  // radius). Returns true if it was on the boundary this frame.
  confine(restitution = 0.6, margin = 0) {
    const dx = this.x - ARENA.cx,
      dy = this.y - ARENA.cy
    const dist = Math.hypot(dx, dy)
    const limit = ARENA.radius - margin
    if (dist > limit && dist > 0) {
      const ux = dx / dist,
        uy = dy / dist
      this.x = ARENA.cx + ux * limit
      this.y = ARENA.cy + uy * limit
      const vn = this.vx * ux + this.vy * uy
      if (vn > 0) {
        this.vx -= (1 + restitution) * vn * ux
        this.vy -= (1 + restitution) * vn * uy
      }
      return true
    }
    return false
  }

  regenEnergy(dt) {
    if (this.regen && this.energyMax) {
      this.energy = Math.min(this.energyMax, this.energy + this.regen * dt)
    }
  }
  spendEnergy(amount) {
    if (this.energy >= amount) {
      this.energy -= amount
      return true
    }
    return false
  }
  damageResist() {
    return 1
  } // player shield plating overrides this

  shieldModule() {
    for (const hp of this.hardpoints) {
      if (hp.module && hp.module.kind === "shield") {
        return hp.module
      }
    }
    return null
  }

  // World position of a hardpoint. Ships store a local offset; asteroids store
  // a world point that is rotated with the rock.
  hardpointWorld(hp) {
    return hp.local ? this.mountWorld(hp.local) : { x: hp.x, y: hp.y }
  }

  updateWeapons(dt, game) {
    for (const hp of this.hardpoints) {
      const m = hp.module
      if (m && m.kind === "weapon") {
        m.update(dt, game, this, this.hardpointWorld(hp))
      }
    }
  }

  // Uniform damage entry point. A raised shield converts the hit into energy
  // drain; if that pushes energy to the overload threshold the shield collapses
  // (but still absorbs this hit). A down or absent shield lets it reach the hull.
  takeDamage(amount, game, channel, scoreOnKill = 0, impact = null) {
    const shield = this.shieldModule()
    if (shield && shield.up && shield.blocks(channel) && this.energy > 0) {
      this.energy = Math.max(0, this.energy - amount * shield.type.efficiency * this.damageResist())
      const hx = impact ? impact.x : this.x,
        hy = impact ? impact.y : this.y
      if (impact) {
        shield.hitAt(Math.atan2(impact.y - this.y, impact.x - this.x))
      }
      if (this.fxCooldown <= 0) {
        game.ring(hx, hy, 8, SHIELD_SPARK, 120, 0.35)
        this.fxCooldown = 0.12
      }
      if (shield.checkOverload(this)) {
        game.burst(this.x, this.y, 16, SHIELD_SPARK, 50, 210, 0.6)
      }
      return true
    }
    this.onHull(amount, game, channel, scoreOnKill)
    return false
  }

  updateShield(dt) {
    if (this.fxCooldown > 0) {
      this.fxCooldown -= dt
    }
    const shield = this.shieldModule()
    if (shield) {
      shield.tick(dt, this)
    }
  }

  onHull() {
    /* subclasses decide what losing the hull means */
  }
}

// ---------------------------------------------------------------------------
// Weapon module. `kind` projectile or beam; `controller` decides firing.
// ---------------------------------------------------------------------------
export class Weapon {
  constructor(typeName, controller) {
    this.kind = "weapon"
    this.typeName = typeName
    this.type = WEAPON_TYPES[typeName]
    this.controller = controller
    this.cooldown = this.rollReload() * 0.5
    this.charge = 0
    this.charging = 0 // wind-up time left before a charged beam fires
    this.chargeDuration = 0
  }

  rollReload() {
    const r = this.type.reload
    return Array.isArray(r) ? randRange(r[0], r[1]) : r
  }
  rollLength() {
    const l = this.type.length
    return Array.isArray(l) ? randRange(l[0], l[1]) : l
  }
  get ready() {
    return this.cooldown <= 0
  }
  tick(dt) {
    if (this.cooldown > 0) {
      this.cooldown -= dt
    }
  }

  fireProjectile(game, x, y, aim, host) {
    if (!host.spendEnergy(this.type.energy)) {
      this.cooldown = 0.35
      return
    }
    game.projectiles.push(
      new Projectile(
        x,
        y,
        Math.cos(aim) * this.type.speed,
        Math.sin(aim) * this.type.speed,
        this.type.damage,
        host,
      ),
    )
    game.burst(x, y, 4, this.type.colour, 40, 120, 0.3)
    this.cooldown = this.rollReload()
    Sound.turret()
  }

  emitBeam(game, host, ax, ay, angle, length) {
    if (!host.spendEnergy(this.type.energy)) {
      this.cooldown = 0.4
      return
    }
    const dir = { x: Math.cos(angle), y: Math.sin(angle) }
    const beam = { a: { x: ax, y: ay }, b: { x: ax + dir.x * length, y: ay + dir.y * length }, dir }
    game.applyBeam(beam, host, this)
    game.laserShots.push({
      beams: [beam],
      age: 0,
      color: this.type.colour,
      width: this.type.width,
      glow: this.type.glow,
      life: this.type.width > 10 ? 0.55 : 0.4,
    })
    this.cooldown = this.rollReload()
    // wide beams are the frigate's heavy cannon: a bigger report
    if (this.type.width > 10) {
      Sound.bigLaser()
    } else {
      Sound.fire()
    }
  }

  update(dt, game, host, world) {
    this.tick(dt)
    if (!this.ready || game.phase !== "play" || host.leaving) {
      return
    }
    const player = game.player
    if (this.controller === "turret") {
      // don't snipe the player from off-screen where they can't see the shooter
      if (!player || player.invincible > 0 || !game.onScreen(host.x, host.y, 40)) {
        return
      }
      this.fireProjectile(
        game,
        world.x,
        world.y,
        Math.atan2(player.y - world.y, player.x - world.x),
        host,
      )
    } else if (this.controller === "miner") {
      let nearest = 1e9
      for (const a of game.asteroids) {
        nearest = Math.min(nearest, Math.hypot(a.center.x - host.x, a.center.y - host.y))
      }
      if (nearest < 420) {
        this.emitBeam(game, host, world.x, world.y, host.angle, this.rollLength())
      }
    } else if (this.controller === "hunter") {
      if (!player) {
        return
      }
      // wind up with a growing glow, then fire (see drawShip); once committed
      // it fires even if the player slips away, telegraphing the big shot
      if (this.charging > 0) {
        this.charging -= dt
        if (this.charging <= 0) {
          this.charging = 0
          this.emitBeam(game, host, world.x, world.y, host.angle, this.type.length)
        }
        return
      }
      const toPlayer = Math.atan2(player.y - host.y, player.x - host.x)
      const arc = ((toPlayer - host.angle + Math.PI * 3) % TAU) - Math.PI
      const dist = Math.hypot(player.x - host.x, player.y - host.y)
      if (Math.abs(arc) < this.type.arc && dist < this.type.length && game.onScreen(host.x, host.y, 40)) {
        this.charging = this.type.chargeTime || 0.8
        this.chargeDuration = this.charging
        Sound.charge()
      }
    } else if (this.controller === "defense") {
      // player nose turret. Manual (arrow keys) aims host.turretAim and fires
      // on demand; otherwise it auto-targets the nearest rock in range.
      if (host.turretManual > 0) {
        if (host.turretFiring) {
          this.emitBeam(game, host, host.x, host.y, host.turretAim, this.type.range)
        }
      } else {
        let target = null,
          nearest = this.type.range
        for (const a of game.asteroids) {
          const d = Math.hypot(a.center.x - host.x, a.center.y - host.y)
          if (d < nearest) {
            nearest = d
            target = a
          }
        }
        if (target) {
          host.turretAim = Math.atan2(target.center.y - host.y, target.center.x - host.x)
          this.emitBeam(game, host, host.x, host.y, host.turretAim, nearest + 42)
        }
      }
    }
    // 'manual' is driven by the player directly.
  }
}

// ---------------------------------------------------------------------------
// Shield module: converts blocked damage into energy drain (handled in
// Entity.takeDamage). Draws a pulsing regular polygon whose alpha tracks the
// host's remaining energy.
// ---------------------------------------------------------------------------
export class Shield {
  constructor(typeName) {
    this.kind = "shield"
    this.typeName = typeName
    this.type = SHIELD_TYPES[typeName]
    this.up = true
    this.downTimer = 0
    this.flash = 0 // brief bright flash on the struck side
    this.flashAngle = 0
  }

  blocks(channel) {
    return channel === "laser" ? this.type.blocksLaser : this.type.blocksProjectile
  }

  // Flash the side facing `angle` (world direction from the host centre).
  hitAt(angle) {
    this.flash = 0.25
    this.flashAngle = angle
  }

  // Overload the shield if the host's energy has dropped to the threshold.
  // Returns true if it just collapsed (so callers can flash it).
  checkOverload(host) {
    if (this.up && host.energy <= this.type.dropAt * host.energyMax) {
      this.up = false
      this.downTimer = this.type.recoverDelay
      return true
    }
    return false
  }

  // Recover once the cooldown has elapsed and energy has recharged enough.
  tick(dt, host) {
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt)
    }
    if (this.up) {
      return
    }
    this.downTimer = Math.max(0, this.downTimer - dt)
    if (
      this.downTimer <= 0 &&
      host.energyMax > 0 &&
      host.energy >= this.type.recoverAt * host.energyMax
    ) {
      this.up = true
    }
  }

  draw(renderer, cx, cy, radius, fraction, time) {
    // gentle pulse that never fades to invisible; brightness tracks energy
    const pulse = 0.88 + 0.12 * Math.sin(time * 1.8)
    const alpha = clamp((0.24 + 0.4 * fraction) * pulse, 0.2, 0.75)
    const rotation = time * 0.3,
      sides = this.type.sides,
      points = []
    for (let i = 0; i < sides; i++) {
      const a = rotation + (i / sides) * TAU
      points.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius })
    }
    renderer.strokePoly(points, { color: this.type.colour, width: 1.7, glow: 12, alpha })
    // struck side flashes brightly for a moment
    if (this.flash > 0) {
      const f = this.flash / 0.25
      const arc = []
      for (let i = -2; i <= 2; i++) {
        const a = this.flashAngle + i * 0.32
        arc.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius })
      }
      renderer.strokePoly(arc, {
        color: "#ffffff",
        width: 2 + 1.5 * f,
        glow: 16,
        alpha: clamp(0.9 * f, 0, 1),
        closed: false,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Projectile: damages every entity except its owner (friendly fire).
// ---------------------------------------------------------------------------
export class Projectile extends Entity {
  constructor(x, y, vx, vy, damage, owner) {
    super(x, y)
    this.vx = vx
    this.vy = vy
    this.damage = damage
    this.owner = owner
    this.life = 4
  }

  update(dt, game) {
    this.life -= dt
    this.integrate(dt)
    if (this.life <= 0 || Math.hypot(this.x - ARENA.cx, this.y - ARENA.cy) > ARENA.radius + 30) {
      this.dead = true
      return
    }
    const player = game.player
    if (
      player &&
      this.owner !== player &&
      Math.hypot(this.x - player.x, this.y - player.y) < player.radius + 3
    ) {
      this.dead = true
      game.burst(this.x, this.y, 8, "#ff8a5a", 40, 140, 0.4)
      game.screenShake = Math.max(game.screenShake, 5)
      Sound.hit()
      player.takeDamage(this.damage, game, "projectile", 0, { x: this.x, y: this.y })
      return
    }
    for (const rival of game.rivals) {
      if (rival === this.owner) {
        continue
      }
      if (pointInPolygon(this, rival.worldOutline())) {
        this.dead = true
        game.burst(this.x, this.y, 6, "#ff9a3c", 40, 130, 0.4)
        rival.takeDamage(this.damage, game, "projectile", 0, { x: this.x, y: this.y })
        return
      }
    }
    for (const asteroid of game.asteroids) {
      if (asteroid === this.owner) {
        continue
      }
      if (pointInPolygon(this, asteroid.vertices)) {
        this.dead = true
        game.burst(this.x, this.y, 5, "#9fc0ff", 30, 110, 0.3)
        asteroid.takeDamage(this.damage, game, "projectile", 0, { x: this.x, y: this.y })
        return
      }
    }
  }

  draw(renderer) {
    renderer.line(this.x, this.y, this.x - this.vx * 0.02, this.y - this.vy * 0.02, {
      color: "#ffb14b",
      width: 2,
      glow: 10,
      cap: "round",
    })
  }
}

// ---------------------------------------------------------------------------
// Ship base: an oriented hull outline hosting hardpoint modules.
// ---------------------------------------------------------------------------
export class Ship extends Entity {
  constructor(x, y) {
    super(x, y)
    this.size = 12
    this.outlineLocal = []
    this.colour = "#ffffff"
  }

  buildHardpoints(list) {
    this.hardpoints = list.map((hp) => ({ local: hp.local, role: hp.role, module: null }))
  }

  applyLoadout(loadout) {
    for (const entry of loadout) {
      const hp = this.hardpoints[entry.hp]
      if (!hp) {
        continue
      }
      if (entry.weapon) {
        hp.module = new Weapon(entry.weapon, entry.controller)
      } else if (entry.shield) {
        hp.module = new Shield(entry.shield)
      }
    }
  }

  worldOutline() {
    const c = Math.cos(this.angle),
      s = Math.sin(this.angle)
    return this.outlineLocal.map((p) => ({
      x: this.x + (p[0] * c - p[1] * s) * this.size,
      y: this.y + (p[0] * s + p[1] * c) * this.size,
    }))
  }

  mountWorld(local) {
    const c = Math.cos(this.angle),
      s = Math.sin(this.angle)
    return {
      x: this.x + (local[0] * c - local[1] * s) * this.size,
      y: this.y + (local[0] * s + local[1] * c) * this.size,
    }
  }

  // Draw hull, shield, weapon nubs, and any beam emitter.
  drawShip(renderer, game, hullWidth) {
    renderer.strokePoly(this.worldOutline(), { color: this.colour, width: hullWidth, glow: 12 })
    const shield = this.shieldModule()
    if (shield && shield.up) {
      shield.draw(
        renderer,
        this.x,
        this.y,
        this.size * (this.size > 16 ? 2.3 : 1.9),
        this.energy / this.energyMax,
        game.gameTime,
      )
    }
    for (const hp of this.hardpoints) {
      const m = hp.module
      if (!m || m.kind !== "weapon") {
        continue
      }
      const w = this.mountWorld(hp.local)
      // charging beam: a glow at the emitter that grows as the shot winds up
      if (m.charging > 0 && m.chargeDuration > 0) {
        const prog = 1 - m.charging / m.chargeDuration
        renderer.circle(w.x, w.y, 2 + prog * 9, {
          fill: m.type.colour,
          glow: 10 + prog * 24,
          alpha: 0.35 + 0.55 * prog,
        })
        const reach = 24 + prog * 40
        renderer.line(w.x, w.y, w.x + Math.cos(this.angle) * reach, w.y + Math.sin(this.angle) * reach, {
          color: m.type.colour,
          width: 1 + prog * 2.5,
          glow: 12,
          alpha: 0.3 + 0.5 * prog,
        })
      }
      if (m.type.kind === "projectile") {
        renderer.circle(w.x, w.y, 3, { stroke: "#ffb14b", width: 1.4, glow: 8 })
      } else if (hp.role === "nose") {
        renderer.line(w.x, w.y, w.x + Math.cos(this.angle) * 8, w.y + Math.sin(this.angle) * 8, {
          color: m.type.colour,
          width: 1.8,
          glow: 10,
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Player ship. Its main laser is a `manual` weapon it charges from input; its
// shield is just its energy pool (shown as the HUD bar). Shield plating reduces
// how much energy each hit drains.
// ---------------------------------------------------------------------------
export class PlayerShip extends Ship {
  constructor(game) {
    super(VIEW_W / 2, VIEW_H / 2)
    this.game = game
    this.angle = -Math.PI / 2
    this.radius = PLAYER_TYPE.size
    this.size = PLAYER_TYPE.size
    this.outlineLocal = PLAYER_TYPE.outline
    this.colour = PLAYER_TYPE.colour
    this.buildHardpoints(PLAYER_TYPE.hardpoints)
    this.applyLoadout(PLAYER_TYPE.loadout)
    this.mainWeapon = this.hardpoints[0].module
    this.energyMax = game.maxEnergy()
    this.energy = this.energyMax
    this.regen = 0 // regen handled explicitly (paused while charging/thrusting)
    this.invincible = CONFIG.INVIN_TIME
    this.thrusting = false
    this.reversing = false
    this.items = []
    this.boosterTime = 0
    this.multiTime = 0
    this.magnetTime = 0
    this.turretAim = 0
    this.turretManual = 0 // time left under player (arrow-key) control
    this.turretFiring = false
    this.atBoundary = false
    this.impactSfx = 0 // throttles collision / boundary sounds
  }

  damageResist() {
    return CONFIG.SHIELD_EFFICIENCY[this.game.upgrades.shield]
  }
  onHull() {
    this.game.playerLoseLife()
  }

  installDefenseTurret() {
    const hp = this.hardpoints.find((h) => h.role === "aux")
    if (hp && !hp.module) {
      hp.module = new Weapon("defenseLaser", "defense")
    }
  }

  #toWorld(lx, ly) {
    const c = Math.cos(this.angle),
      s = Math.sin(this.angle)
    return { x: this.x + lx * c - ly * s, y: this.y + lx * s + ly * c }
  }

  fireLaser(game) {
    const w = this.mainWeapon
    if (!w || w.cooldown > 0 || w.charge < w.type.chargeMin) {
      return
    }
    const chargeFrac = clamp(w.charge / w.type.chargeMax, 0, 1)
    const length = w.charge * (this.boosterTime > 0 ? 1.6 : 1) + 40
    const nose = this.mountWorld(this.hardpoints[0].local)
    const dir = { x: Math.cos(this.angle), y: Math.sin(this.angle) },
      nrm = { x: -dir.y, y: dir.x }
    const offsets = this.multiTime > 0 ? [-28, 0, 28] : [0]
    game.stats.shots++
    let hit = false
    for (const o of offsets) {
      const ax = nose.x + nrm.x * o,
        ay = nose.y + nrm.y * o
      const beam = {
        a: { x: ax, y: ay },
        b: { x: ax + dir.x * length, y: ay + dir.y * length },
        dir,
      }
      game.laserShots.push({
        beams: [beam],
        age: 0,
        color: w.type.colour,
        width: w.type.width,
        glow: w.type.glow,
      })
      if (game.applyBeam(beam, this, w)) {
        hit = true
      }
    }
    if (hit) {
      game.stats.hits++
    }
    w.cooldown = w.type.reload
    w.charge = 0
    Sound.fire(0.9 + 0.35 * chargeFrac) // pitch rises slightly with charge
  }

  update(dt, game) {
    this.invincible = Math.max(0, this.invincible - dt)
    this.boosterTime = Math.max(0, this.boosterTime - dt)
    this.multiTime = Math.max(0, this.multiTime - dt)
    this.magnetTime = Math.max(0, this.magnetTime - dt)
    this.impactSfx = Math.max(0, this.impactSfx - dt)
    this.energyMax = game.maxEnergy()

    const keys = game.pressedKeys
    const canControl = game.phase === "play"
    // WASD flies the ship; the arrow keys aim the defense turret (below)
    if (canControl) {
      if (keys.has("KeyA")) {
        this.angle -= CONFIG.ROT * dt
      }
      if (keys.has("KeyD")) {
        this.angle += CONFIG.ROT * dt
      }
      this.thrusting = keys.has("KeyW")
    } else {
      this.thrusting = false
    }

    // Arrow keys take manual control of the defense turret: LEFT/RIGHT swing the
    // aim, UP fires. Any input holds manual mode; after a short cooldown with no
    // input it reverts to auto-targeting.
    this.turretManual = Math.max(0, this.turretManual - dt)
    this.turretFiring = false
    if (canControl && game.upgrades.turret) {
      let active = false
      if (keys.has("ArrowLeft")) {
        this.turretAim -= 3.0 * dt
        active = true
      }
      if (keys.has("ArrowRight")) {
        this.turretAim += 3.0 * dt
        active = true
      }
      if (keys.has("ArrowUp")) {
        this.turretFiring = true
        active = true
      }
      if (active) {
        this.turretManual = 1.5
      }
    }

    if (this.thrusting) {
      this.vx += Math.cos(this.angle) * CONFIG.ACCEL * dt
      this.vy += Math.sin(this.angle) * CONFIG.ACCEL * dt
      if (this.energy > 0) {
        this.energy -= CONFIG.THRUST_COST * dt
      }
      const back = this.angle + Math.PI
      game.emit(
        this.x + Math.cos(back) * this.radius,
        this.y + Math.sin(back) * this.radius,
        Math.cos(back) * randRange(60, 140) + randRange(-30, 30),
        Math.sin(back) * randRange(60, 140) + randRange(-30, 30),
        0.35,
        "#7fd8ff",
      )
      // exhaust wash gently shoves rocks caught behind the thruster away
      const bx = Math.cos(back),
        by = Math.sin(back)
      const range = 150
      for (const a of game.asteroids) {
        const dx = a.center.x - this.x,
          dy = a.center.y - this.y
        const dist = Math.hypot(dx, dy)
        if (dist < 1 || dist > range) {
          continue
        }
        const ux = dx / dist,
          uy = dy / dist
        const align = ux * bx + uy * by // 1 = directly behind the ship
        if (align < 0.25) {
          continue
        }
        const push = (160 * (1 - dist / range) * align) / clamp(a.area / 3200, 0.5, 4)
        a.vx += ux * push * dt
        a.vy += uy * push * dt
      }
    }

    this.reversing =
      canControl && game.upgrades.reverse && !this.thrusting && keys.has("KeyS")
    if (this.reversing) {
      this.vx -= Math.cos(this.angle) * CONFIG.ACCEL * 0.6 * dt
      this.vy -= Math.sin(this.angle) * CONFIG.ACCEL * 0.6 * dt
      if (this.energy > 0) {
        this.energy -= CONFIG.THRUST_COST * dt
      }
      for (let i = 0; i < 2; i++) {
        game.emit(
          this.x + Math.cos(this.angle) * this.radius,
          this.y + Math.sin(this.angle) * this.radius,
          Math.cos(this.angle) * randRange(50, 110) + randRange(-25, 25),
          Math.sin(this.angle) * randRange(50, 110) + randRange(-25, 25),
          0.3,
          "#aee6ff",
        )
      }
    }
    Sound.setThruster(this.thrusting || this.reversing)

    const speed = Math.hypot(this.vx, this.vy)
    if (speed > CONFIG.MAX_SPEED) {
      this.vx *= CONFIG.MAX_SPEED / speed
      this.vy *= CONFIG.MAX_SPEED / speed
    }
    this.vx *= Math.pow(CONFIG.SPEED_DRAG, dt)
    this.vy *= Math.pow(CONFIG.SPEED_DRAG, dt)
    this.integrate(dt)
    const wasBoundary = this.atBoundary
    this.atBoundary = this.confine(0.35, this.radius)
    if (this.atBoundary && !wasBoundary && this.impactSfx <= 0) {
      Sound.bump() // energy shield glancing the arena wall
      this.impactSfx = 0.15
    }

    // Charge the manual laser off the shared energy cell (its cooldown is
    // ticked by updateWeapons below).
    const w = this.mainWeapon
    const holding = canControl && keys.has("Space")
    const freeShot = this.boosterTime > 0
    if (holding) {
      const rate = w.type.chargeRate * CONFIG.LASER_RATE_MULT[game.upgrades.laser]
      const cost = w.type.chargeCost * CONFIG.LASER_COST_MULT[game.upgrades.laser]
      if (this.energy > 4 || freeShot) {
        w.charge = Math.min(w.type.chargeMax, w.charge + rate * dt)
        if (!freeShot) {
          this.energy -= cost * dt
        }
      }
    } else {
      if (w.charge > 0) {
        w.charge = 0
      }
      if (!this.thrusting) {
        this.energy = Math.min(this.energyMax, this.energy + CONFIG.PLAYER_REGEN[game.upgrades.core] * dt)
      }
    }
    this.energy = clamp(this.energy, 0, this.energyMax)
    this.updateShield(dt)

    // Auto weapons (defense turret) fire via their controllers.
    this.updateWeapons(dt, game)

    // Collect ore (wider grab while vacuuming a cleared sector).
    const grabRadius = game.oreVacuum ? this.radius + 42 : this.radius + 8
    for (let i = game.oreChunks.length - 1; i >= 0; i--) {
      const chunk = game.oreChunks[i]
      if (Math.hypot(chunk.x - this.x, chunk.y - this.y) < grabRadius) {
        game.oreChunks.splice(i, 1)
        game.score += CONFIG.ORE_SCORE
        game.stats.ore++
        game.oreBalance++
        this.energy = Math.min(this.energyMax, this.energy + CONFIG.ORE_ENERGY)
        game.burst(chunk.x, chunk.y, 5, "#ffbdee", 20, 70, 0.4)
        Sound.collect()
      }
    }

    // Pick up powerups into a free inventory slot.
    for (let i = game.powerupPickups.length - 1; i >= 0; i--) {
      const pickup = game.powerupPickups[i]
      if (
        Math.hypot(pickup.x - this.x, pickup.y - this.y) < this.radius + 14 &&
        this.items.length < game.upgrades.slots
      ) {
        this.items.push(pickup.type)
        game.powerupPickups.splice(i, 1)
        Sound.power()
        game.burst(pickup.x, pickup.y, 12, POWERUP_COLOUR[pickup.type], 30, 120, 0.6)
        game.showToast(`${POWERUP_LABEL[pickup.type]} POWERUP COLLECTED`)
      }
    }

    // Asteroid collision: treat the rock as a circle, push the ship back out to
    // the surface, and reflect its inward velocity so it glances off rather than
    // tunnelling through. Momentum transfers to the rock; contact grinds energy.
    for (const asteroid of game.asteroids) {
      const nx = this.x - asteroid.center.x,
        ny = this.y - asteroid.center.y
      const dist = Math.hypot(nx, ny) || 1
      const minDist = asteroid.collideRadius + this.radius
      if (dist >= minDist) {
        continue
      }
      const ux = nx / dist,
        uy = ny / dist
      // separate: pop the ship onto the surface
      const overlap = minDist - dist
      this.x += ux * overlap
      this.y += uy * overlap
      // reflect the inward component of velocity (a glancing bounce)
      const vn = this.vx * ux + this.vy * uy
      if (vn < 0) {
        const restitution = 0.5
        this.vx -= (1 + restitution) * vn * ux
        this.vy -= (1 + restitution) * vn * uy
        const massFactor = clamp(asteroid.area / 3200, 0.4, 4)
        asteroid.vx += (vn * ux * 0.5) / massFactor
        asteroid.vy += (vn * uy * 0.5) / massFactor
        asteroid.spin += randRange(-1.5, 1.5)
        if (-vn > 45 && this.impactSfx <= 0) {
          Sound.bump() // knock on contact with a rock
          this.impactSfx = 0.15
        }
      }
      if (this.invincible <= 0 && this.boosterTime <= 0) {
        game.screenShake = Math.max(game.screenShake, 3)
        if (this.fxCooldown <= 0) {
          game.burst(this.x, this.y, 4, "#ff6b6b", 30, 90, 0.35)
        }
        // flash the shield on the side facing the rock
        const contact = { x: this.x - ux * this.radius, y: this.y - uy * this.radius }
        this.takeDamage(CONFIG.DMG_AST_GUN * dt * 3.6, game, "projectile", 0, contact)
      }
      break
    }
  }

  draw(renderer, game) {
    if (this.invincible > 0 && Math.floor(game.gameTime * 12) % 2 === 0) {
      return
    } // blink while invincible
    const boosted = this.boosterTime > 0
    const colour = boosted
      ? "#ffcf5c"
      : this.energy < this.energyMax * 0.22
        ? "#ff6b6b"
        : this.colour

    if (this.thrusting) {
      const flame = randRange(0.7, 1.3)
      const pts = [
        this.#toWorld(-this.radius * 0.7, -4),
        this.#toWorld(-this.radius * (1.1 + flame), 0),
        this.#toWorld(-this.radius * 0.7, 4),
      ]
      renderer.strokePoly(pts, { color: "#aee6ff", width: 1.4, glow: 10, closed: false })
    }
    renderer.strokePoly(this.worldOutline(), { color: colour, width: 1.9, glow: 14 })
    if (boosted) {
      renderer.circle(this.x, this.y, this.radius * 1.7, { stroke: colour, width: 1.9, alpha: 0.5 })
    }

    // Shield bubble around the ship (fades with the energy cell; gone when overloaded).
    const shield = this.shieldModule()
    if (shield && shield.up) {
      shield.draw(
        renderer,
        this.x,
        this.y,
        this.radius * 1.9,
        this.energy / this.energyMax,
        game.gameTime,
      )
    }

    if (game.upgrades.turret) {
      const aim = this.turretAim || 0
      renderer.circle(this.x, this.y, 3.4, { stroke: "#9ff5c8", width: 1.6, glow: 8 })
      renderer.line(this.x, this.y, this.x + Math.cos(aim) * 12, this.y + Math.sin(aim) * 12, {
        color: "#9ff5c8",
        width: 1.6,
        glow: 8,
      })
    }

    const w = this.mainWeapon
    if (w && w.charge > 4) {
      const nose = this.mountWorld(this.hardpoints[0].local)
      const length = w.charge * (boosted ? 1.6 : 1) + 40
      const frac = clamp(w.charge / w.type.chargeMax, 0.3, 1)
      renderer.line(
        nose.x,
        nose.y,
        nose.x + Math.cos(this.angle) * length,
        nose.y + Math.sin(this.angle) * length,
        {
          color: `rgba(87,227,154,${frac})`,
          width: 1.5 + 2.5 * (w.charge / w.type.chargeMax),
          glow: 14,
        },
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Rival ship, built from a SHIP_TYPES entry plus an optional rolled loadout.
// ---------------------------------------------------------------------------
export class RivalShip extends Ship {
  constructor(x, y, typeName, loadout) {
    super(x, y)
    const type = SHIP_TYPES[typeName]
    this.type = type
    this.typeName = typeName
    this.size = type.size
    this.outlineLocal = type.outline
    this.colour = type.colour
    this.accel = type.accel
    this.maxSpeed = type.maxSpeed
    this.turnRate = type.turnRate
    this.drag = type.drag
    this.exhaustFactor = type.exhaustFactor
    this.energyMax = type.energyMax
    this.energy = type.energyMax
    this.regen = type.regen
    this.lifeTimer = randRange(type.lifeTime[0], type.lifeTime[1])
    this.leaving = false
    this.buildHardpoints(type.hardpoints)
    const activeLoadout = loadout || type.loadout || []
    this.applyLoadout(activeLoadout)
    this.hunts = activeLoadout.some((e) => e.controller === "hunter")
  }

  onHull(amount, game, channel, scoreOnKill) {
    this.destroy(game, scoreOnKill)
  }

  destroy(game, scoreOnKill) {
    const big = this.typeName === "frigate"
    this.dead = true
    game.burst(this.x, this.y, big ? 40 : 26, "#ff9a3c", 60, big ? 300 : 240, 0.9)
    game.ring(this.x, this.y, big ? 26 : 18, "#ffcf5c", 180, 0.8)
    for (let k = 0; k < this.type.oreDrop; k++) {
      game.spawnOre(
        this.x + randRange(-18, 18),
        this.y + randRange(-18, 18),
        randRange(-70, 70),
        randRange(-70, 70),
      )
    }
    game.score += scoreOnKill
    game.screenShake = Math.max(game.screenShake, big ? 14 : 10)
    Sound.explode()
  }

  update(dt, game) {
    const player = game.player
    this.regenEnergy(dt)
    this.updateShield(dt)
    this.lifeTimer -= dt

    let target = null,
      nearest = 1e9
    for (const chunk of game.oreChunks) {
      const d = Math.hypot(chunk.x - this.x, chunk.y - this.y)
      if (d < nearest) {
        nearest = d
        target = chunk
      }
    }
    const wantsOre = target && nearest < 340
    if (!wantsOre) {
      target = null
      nearest = 1e9
      for (const asteroid of game.asteroids) {
        const d = Math.hypot(asteroid.center.x - this.x, asteroid.center.y - this.y)
        if (d < nearest) {
          nearest = d
          target = asteroid.center
        }
      }
    }
    if (this.lifeTimer <= 0) {
      this.leaving = true
    }

    const outAngle = Math.atan2(this.y - ARENA.cy, this.x - ARENA.cx)
    const goal = this.leaving
      ? {
          x: ARENA.cx + Math.cos(outAngle) * (ARENA.radius + 200),
          y: ARENA.cy + Math.sin(outAngle) * (ARENA.radius + 200),
        }
      : this.hunts
        ? { x: player.x, y: player.y }
        : target || { x: ARENA.cx, y: ARENA.cy }
    const wantAngle = Math.atan2(goal.y - this.y, goal.x - this.x)
    const angleDelta = ((wantAngle - this.angle + Math.PI * 3) % TAU) - Math.PI
    this.angle += clamp(angleDelta, -this.turnRate * dt, this.turnRate * dt)
    this.vx += Math.cos(this.angle) * this.accel * dt
    this.vy += Math.sin(this.angle) * this.accel * dt
    const speed = Math.hypot(this.vx, this.vy)
    if (speed > this.maxSpeed) {
      this.vx *= this.maxSpeed / speed
      this.vy *= this.maxSpeed / speed
    }
    this.vx *= Math.pow(this.drag, dt)
    this.vy *= Math.pow(this.drag, dt)
    this.integrate(dt)

    const back = this.size * this.exhaustFactor
    if (Math.random() < 0.4) {
      game.emit(
        this.x - Math.cos(this.angle) * back,
        this.y - Math.sin(this.angle) * back,
        -Math.cos(this.angle) * 40 + randRange(-20, 20),
        -Math.sin(this.angle) * 40 + randRange(-20, 20),
        0.4,
        "#ff9a3c",
      )
    }

    for (let i = game.oreChunks.length - 1; i >= 0; i--) {
      if (Math.hypot(game.oreChunks[i].x - this.x, game.oreChunks[i].y - this.y) < 18) {
        game.oreChunks.splice(i, 1)
        game.rivalScore += CONFIG.ORE_SCORE
        game.burst(this.x, this.y, 4, "#ff9a3c", 30, 80, 0.3)
      }
    }

    this.updateWeapons(dt, game) // guns + main laser fire via their controllers

    if (this.leaving && Math.hypot(this.x - ARENA.cx, this.y - ARENA.cy) > ARENA.radius + 140) {
      this.dead = true
    }
  }

  draw(renderer, game) {
    this.drawShip(renderer, game, this.typeName === "frigate" ? 2 : 1.8)
    renderer.circle(this.x, this.y, 1.6, { fill: "#ffcf5c", glow: 8 })
  }
}

// ---------------------------------------------------------------------------
// Asteroid: a convex polygon with hardpoints (guns/shield) that are kept when
// it splits, so an asteroid with two guns becomes two with one gun each.
// ---------------------------------------------------------------------------
export function makeAsteroidPolygon(cx, cy, radius) {
  const pointCount = randInt(7, 11),
    points = []
  for (let i = 0; i < pointCount; i++) {
    const angle = Math.random() * TAU,
      r = radius * randRange(0.68, 1.12)
    points.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r })
  }
  return convexHull(points).map((p) => ({ x: cx + p.x, y: cy + p.y }))
}

export class Asteroid extends Entity {
  constructor(opts) {
    super()
    this.vertices = opts.vertices ? opts.vertices : makeAsteroidPolygon(opts.x, opts.y, opts.radius)
    this.vx = opts.vx || 0
    this.vy = opts.vy || 0
    this.spin = opts.spin || 0
    this.explosive = opts.vertices ? !!opts.explosive : !!(opts.traits && opts.traits.explosive)
    this.fuse = null
    this.noCollideTimer = opts.fragment ? 0.55 : 0
    this.hardpoints = opts.hardpoints || []
    this.tint = opts.tint || null // overrides the rock palette (e.g. frigate debris)
    this.recompute()

    if (!opts.vertices) {
      // Fresh rock: mount modules on hardpoints. Gun rocks get 1-3 turrets; a
      // shield takes the centre. Turret points are placed by lerping from the
      // centroid toward a random vertex, so they stay inside the convex hull.
      const traits = opts.traits || {}
      if (traits.gun) {
        const count = randInt(1, 3)
        for (let k = 0; k < count; k++) {
          const v = this.vertices[randInt(0, this.vertices.length - 1)]
          const t = randRange(0.2, 0.6)
          this.hardpoints.push({
            x: this.center.x + (v.x - this.center.x) * t,
            y: this.center.y + (v.y - this.center.y) * t,
            module: new Weapon("blaster", "turret"),
          })
        }
      }
      if (traits.shield) {
        this.hardpoints.push({ x: this.center.x, y: this.center.y, module: new Shield("standard") })
      }
    }
    this.refreshEnergy(opts.energy)
  }

  refreshEnergy(inherited) {
    let max = 0
    for (const hp of this.hardpoints) {
      if (hp.module && hp.module.kind === "shield") {
        max += CONFIG.AST_ENERGY_SHIELD
      }
      if (hp.module && hp.module.kind === "weapon") {
        max += CONFIG.AST_ENERGY_GUN
      }
    }
    this.energyMax = max
    this.regen = max > 0 ? CONFIG.AST_REGEN : 0
    this.energy = inherited != null ? Math.min(inherited, max) : max
  }

  onHull() {
    /* bare rock ignores bullets; it is destroyed by cutting */
  }

  recompute() {
    this.center = polygonCentroid(this.vertices)
    this.area = polygonArea(this.vertices)
    this.boundRadius = boundingRadius(this.vertices, this.center)
    this.collideRadius = Math.sqrt(Math.max(this.area, 1) / Math.PI)
    this.x = this.center.x
    this.y = this.center.y
  }

  update(dt, game) {
    this.regenEnergy(dt)
    this.updateShield(dt)
    const centre = this.center
    const cosA = Math.cos(this.spin * dt),
      sinA = Math.sin(this.spin * dt)
    const rotate = (p) => {
      const dx = p.x - centre.x,
        dy = p.y - centre.y
      p.x = centre.x + dx * cosA - dy * sinA + this.vx * dt
      p.y = centre.y + dx * sinA + dy * cosA + this.vy * dt
    }
    for (const p of this.vertices) {
      rotate(p)
    }
    for (const hp of this.hardpoints) {
      rotate(hp)
    } // hardpoints rotate/translate with the rock
    this.vx *= Math.pow(0.985, dt)
    this.vy *= Math.pow(0.985, dt)
    this.spin *= Math.pow(0.82, dt)
    if (this.noCollideTimer) {
      this.noCollideTimer = Math.max(0, this.noCollideTimer - dt)
    }
    const speed = Math.hypot(this.vx, this.vy)
    if (speed > CONFIG.AST_MAX_SPEED) {
      this.vx *= CONFIG.AST_MAX_SPEED / speed
      this.vy *= CONFIG.AST_MAX_SPEED / speed
    }
    this.recompute()

    // Arena confinement: when the rock's body crosses the boundary circle, push
    // it (vertices, hardpoints, centre) back inside and reflect its velocity so
    // it is repelled into the play zone.
    const dcx = this.center.x - ARENA.cx,
      dcy = this.center.y - ARENA.cy
    const cdist = Math.hypot(dcx, dcy)
    const limit = ARENA.radius - this.collideRadius
    if (cdist > limit && cdist > 0) {
      const ux = dcx / cdist,
        uy = dcy / cdist
      const over = cdist - limit
      for (const p of this.vertices) {
        p.x -= ux * over
        p.y -= uy * over
      }
      for (const hp of this.hardpoints) {
        hp.x -= ux * over
        hp.y -= uy * over
      }
      this.center.x -= ux * over
      this.center.y -= uy * over
      this.x = this.center.x
      this.y = this.center.y
      const vn = this.vx * ux + this.vy * uy
      if (vn > 0) {
        this.vx -= 1.9 * vn * ux
        this.vy -= 1.9 * vn * uy
      }
    }

    this.updateWeapons(dt, game) // gun emplacements fire via their turret controller
    if (this.fuse != null) {
      this.fuse -= dt
      if (this.fuse <= 0) {
        this.detonate(game)
      }
    }
  }

  // Split by a beam, distributing hardpoints to whichever piece they fall on.
  // A concave fragment can yield more than two pieces; all are handled.
  splitBy(beam, game) {
    const cutNormal = perpendicular(beam.dir)
    const parts = slicePolygon(this.vertices, beam.a, cutNormal)
    if (parts.length < 2) {
      return null
    }
    const fragments = []
    for (const partVerts of parts) {
      const centre = polygonCentroid(partVerts),
        area = polygonArea(partVerts)
      const side = dot(subtract(centre, beam.a), cutNormal) > 0 ? 1 : -1
      const impulse = { x: cutNormal.x, y: cutNormal.y }
      const mag = Math.hypot(impulse.x, impulse.y) || 1
      const ix = (impulse.x / mag) * side * CONFIG.SPLIT_IMPULSE,
        iy = (impulse.y / mag) * side * CONFIG.SPLIT_IMPULSE
      if (area < CONFIG.AST_MIN_AREA) {
        const oreCount = clamp(Math.round(area / 620) + 1, 1, 4)
        for (let k = 0; k < oreCount; k++) {
          game.spawnOre(
            centre.x + randRange(-10, 10),
            centre.y + randRange(-10, 10),
            this.vx + ix * 0.4 + randRange(-30, 30),
            this.vy + iy * 0.4 + randRange(-30, 30),
          )
        }
        game.burst(centre.x, centre.y, randInt(6, 12), "#ff8ae6", 30, 110, 0.6)
        Sound.shatter()
        game.stats.mined++
        continue
      }
      const mine = this.hardpoints.filter(
        (hp) => (dot(subtract(hp, beam.a), cutNormal) > 0 ? 1 : -1) === side,
      )
      const frag = new Asteroid({
        vertices: partVerts,
        vx: this.vx + ix,
        vy: this.vy + iy,
        spin: this.spin + randRange(-2, 2),
        fragment: true,
        hardpoints: mine,
        energy: this.energy,
        tint: this.tint,
      })
      fragments.push(frag)
    }
    return fragments
  }

  detonate(game) {
    this.dead = true
    game.stats.mined++
    game.burst(this.center.x, this.center.y, randInt(48, 68), "#ff7a4a", 60, 360, 0.95)
    game.burst(this.center.x, this.center.y, randInt(20, 30), "#ffd36a", 40, 190, 0.8)
    game.ring(this.center.x, this.center.y, 30, "#ffcf5c", 300, 0.85)
    game.screenShake = Math.max(game.screenShake, 12)
    Sound.explode()
    for (let k = 0; k < randInt(2, 4); k++) {
      game.spawnOre(
        this.center.x + randRange(-14, 14),
        this.center.y + randRange(-14, 14),
        randRange(-90, 90),
        randRange(-90, 90),
      )
    }

    const killRadius = CONFIG.BLAST_R * 0.66
    for (const other of game.asteroids) {
      if (other === this || other.dead) {
        continue
      }
      const offset = subtract(other.center, this.center),
        dist = magnitude(offset)
      if (dist > CONFIG.BLAST_R) {
        continue
      }
      if (other.explosive) {
        if (other.fuse == null) {
          other.fuse = randRange(0.05, 0.18)
        }
        continue
      }
      if (dist < killRadius) {
        game.shatterToOre(other)
        other.dead = true
        continue
      }
      const falloff = 1 - dist / CONFIG.BLAST_R,
        dir = normalize(offset)
      other.vx += dir.x * CONFIG.BLAST_IMPULSE * falloff
      other.vy += dir.y * CONFIG.BLAST_IMPULSE * falloff
      other.spin += randRange(-2, 2) * falloff
    }

    const player = game.player,
      playerDist = Math.hypot(player.x - this.center.x, player.y - this.center.y)
    if (playerDist < CONFIG.BLAST_R) {
      const falloff = 1 - playerDist / CONFIG.BLAST_R,
        dir = normalize(subtract(player, this.center))
      player.vx += dir.x * 300 * falloff
      player.vy += dir.y * 300 * falloff
      player.takeDamage(CONFIG.BLAST_DAMAGE * falloff, game, "projectile")
    }
    for (let i = game.rivals.length - 1; i >= 0; i--) {
      const rival = game.rivals[i],
        dist = Math.hypot(rival.x - this.center.x, rival.y - this.center.y)
      if (dist >= CONFIG.BLAST_R) {
        continue
      }
      const falloff = 1 - dist / CONFIG.BLAST_R,
        dir = normalize(subtract(rival, this.center))
      rival.vx += dir.x * 220 * falloff
      rival.vy += dir.y * 220 * falloff
      rival.takeDamage(CONFIG.BLAST_DAMAGE * falloff, game, "projectile", rival.type.blastScore)
    }
    for (const bullet of game.projectiles) {
      const dx = bullet.x - this.center.x,
        dy = bullet.y - this.center.y,
        dist = Math.hypot(dx, dy) || 1
      if (dist < CONFIG.BLAST_R) {
        const s = Math.max(CONFIG.BULLET_SPEED, Math.hypot(bullet.vx, bullet.vy))
        bullet.vx = (dx / dist) * s
        bullet.vy = (dy / dist) * s
      }
    }
  }

  hasGun() {
    return this.hardpoints.some((hp) => hp.module && hp.module.kind === "weapon")
  }

  colour() {
    if (this.tint) {
      return this.tint
    }
    if (this.explosive) {
      return "#ff6b52"
    }
    const sh = this.shieldModule(),
      shielded = sh && sh.up,
      gun = this.hasGun()
    if (gun && shielded) {
      return "#c9a0ff"
    }
    if (gun) {
      return "#9fd8ff"
    }
    if (shielded) {
      return "#ffd36a"
    }
    const t = clamp(
      (this.area - CONFIG.AST_MIN_AREA) /
        (3.14 * CONFIG.AST_MAX_R * CONFIG.AST_MAX_R - CONFIG.AST_MIN_AREA),
      0,
      1,
    )
    return `hsl(${lerp(40, 196, t).toFixed(0)} 92% ${lerp(60, 72, t).toFixed(0)}%)`
  }

  draw(renderer, game) {
    renderer.strokePoly(this.vertices, { color: this.colour(), width: 1.7, glow: 11 })
    if (this.explosive) {
      const pulse = 0.5 + 0.5 * Math.sin(game.gameTime * 6)
      renderer.circle(this.center.x, this.center.y, 4 + 2 * pulse, {
        fill: "#ff5b3b",
        glow: 12 + 8 * pulse,
        alpha: 0.35 + 0.4 * pulse,
      })
    }
    const shield = this.shieldModule()
    if (shield && shield.up) {
      shield.draw(
        renderer,
        this.center.x,
        this.center.y,
        this.boundRadius + 10,
        this.energy / this.energyMax,
        game.gameTime,
      )
    }
    for (const hp of this.hardpoints) {
      if (!hp.module || hp.module.kind !== "weapon" || !game.player) {
        continue
      }
      const aim = Math.atan2(game.player.y - hp.y, game.player.x - hp.x)
      renderer.circle(hp.x, hp.y, 3.4, { stroke: "#ffb14b", width: 1.6, glow: 8 })
      renderer.line(hp.x, hp.y, hp.x + Math.cos(aim) * 10, hp.y + Math.sin(aim) * 10, {
        color: "#ffb14b",
        width: 1.6,
        glow: 8,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Ore chunk and powerup pickup (simple drifting collectables).
// ---------------------------------------------------------------------------
export class Ore extends Entity {
  constructor(x, y, vx, vy) {
    super(x, y)
    this.vx = vx
    this.vy = vy
    this.spin = randRange(-3, 3)
    this.angle = Math.random() * TAU
    this.life = 24
    this.size = randRange(4, 6.5)
  }

  update(dt, game) {
    this.life -= dt
    const player = game.player,
      dist = Math.hypot(this.x - player.x, this.y - player.y)
    if (
      game.oreVacuum ||
      player.magnetTime > 0 ||
      dist < CONFIG.MAGNET_RANGE[game.upgrades.magnet]
    ) {
      const pull = normalize(subtract(player, this))
      const force = game.oreVacuum ? 560 : player.magnetTime > 0 ? 260 : 120
      this.vx += pull.x * force * dt
      this.vy += pull.y * force * dt
    }
    this.vx *= Math.pow(0.55, dt)
    this.vy *= Math.pow(0.55, dt)
    this.integrate(dt)
    this.angle += this.spin * dt
    this.confine(0.4, this.size)
    if (this.life <= 0) {
      game.burst(this.x, this.y, randInt(5, 8), "#ff8ae6", 40, 150, 0.4)
      this.dead = true
    }
  }

  draw(renderer, game) {
    const urgency = this.life < 6 ? clamp(1 - this.life / 6, 0, 1) : 0
    const flash = urgency * (0.5 + 0.5 * Math.sin(game.gameTime * (7 + urgency * 36)))
    const g = lerp(126, 255, flash) | 0,
      b = lerp(224, 255, flash) | 0,
      pts = []
    for (let i = 0; i < 4; i++) {
      const a = this.angle + (i / 4) * TAU,
        r = i % 2 ? this.size * 0.6 : this.size
      pts.push({ x: this.x + Math.cos(a) * r, y: this.y + Math.sin(a) * r })
    }
    renderer.strokePoly(pts, {
      color: `rgb(255,${g},${b})`,
      width: 1.6 + 0.8 * flash,
      glow: 14 + 12 * flash,
    })
  }
}

export class Powerup extends Entity {
  constructor(x, y, vx, vy, type) {
    super(x, y)
    this.vx = vx
    this.vy = vy
    this.type = type
    this.angle = 0
    this.life = 26
  }

  update(dt) {
    this.life -= dt
    this.angle += dt * 1.4
    this.integrate(dt)
    if (Math.hypot(this.x - ARENA.cx, this.y - ARENA.cy) > ARENA.radius + 60 || this.life <= 0) {
      this.dead = true
    }
  }

  draw(renderer) {
    const colour = POWERUP_COLOUR[this.type],
      pts = []
    for (let i = 0; i < 6; i++) {
      const a = this.angle + (i / 6) * TAU
      pts.push({ x: this.x + Math.cos(a) * 12, y: this.y + Math.sin(a) * 12 })
    }
    renderer.strokePoly(pts, { color: colour, width: 1.7, glow: 14 })
    renderer.text(this.type[0].toUpperCase(), this.x, this.y, {
      size: 12,
      color: colour,
      align: "center",
      baseline: "middle",
      bold: true,
      glow: 14,
    })
  }
}
