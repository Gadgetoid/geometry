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
  convexPartition,
  polygonArea,
  polygonCentroid,
  boundingRadius,
  perpendicular,
  slicePolygon,
  convexContact,
  supportDistance,
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
  AST_SHAPE,
  POWERUP_TYPES,
  SHIELD_SPARK,
} from "./config.js"
import { Sound } from "./audio.js"
import { PALETTE } from "./palette.js"

const SINGLE_BEAM_OFFSETS = [0] // the player's laser without the multi powerup

// Mass a rock's area implies, in the same units as a ship type's `mass`.
export function rockMass(area) {
  return clamp(area / CONFIG.AST_MASS_AREA, CONFIG.AST_MASS_RANGE[0], CONFIG.AST_MASS_RANGE[1])
}

// Contact between two bodies, each given as a list of convex parts that tile its
// real outline. Callers reject on the enclosing circles first. Returns the push
// `b` must take (and `a` resist), or null when they are apart.
//
// The two halves of the answer are measured differently, and both matter:
//
// Whether they touch at all is decided part against part, which is exact for any
// outline. A separating-axis test on a concave outline reports a contact across
// its notch, which is what a plain SAT call on a cut hull would do.
//
// How far to push is then measured over each body as a whole: for a candidate
// axis, how far must b travel along it before it clears every part of a. The
// axis needing least travel wins, so the result is the smallest push that
// separates the bodies completely. Answering with one part pair's own push
// instead is wrong either way round - the shallowest pair stops as soon as it
// alone is clear and leaves the others interpenetrating, while the deepest pair
// names the one axis that is worst to push along.
export function bodyContact(partsA, centreA, partsB, centreB) {
  let touching = false
  for (const a of partsA) {
    for (const b of partsB) {
      if (convexContact(a, b, centreA, centreB)) {
        touching = true
        break
      }
    }
    if (touching) {
      break
    }
  }
  if (!touching) {
    return null
  }
  // Axes are oriented from a toward b up front, so an overlap has one meaning:
  // how far b must travel along it to clear a.
  const toBx = centreB.x - centreA.x,
    toBy = centreB.y - centreA.y
  let bestDepth = Infinity,
    bestX = 0,
    bestY = 0
  for (const parts of [partsA, partsB]) {
    for (const poly of parts) {
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i],
          q = poly[(i + 1) % poly.length]
        let nx = -(q.y - p.y),
          ny = q.x - p.x
        const len = Math.hypot(nx, ny)
        if (len < 1e-9) {
          continue
        }
        nx /= len
        ny /= len
        if (toBx * nx + toBy * ny < 0) {
          nx = -nx
          ny = -ny
        }
        let aMax = -Infinity,
          bMin = Infinity
        for (const part of partsA) {
          for (const v of part) {
            const d = v.x * nx + v.y * ny
            if (d > aMax) {
              aMax = d
            }
          }
        }
        for (const part of partsB) {
          for (const v of part) {
            const d = v.x * nx + v.y * ny
            if (d < bMin) {
              bMin = d
            }
          }
        }
        const depth = aMax - bMin
        if (depth > 0 && depth < bestDepth) {
          bestDepth = depth
          bestX = nx
          bestY = ny
        }
      }
    }
  }
  if (bestDepth === Infinity) {
    return null
  }
  return { nx: bestX, ny: bestY, depth: bestDepth }
}

// Hull against hull. Ships are solid to each other as well as to rocks, so a
// frigate cannot be flown through and two rivals cannot occupy the same space.
// Each is pushed apart in inverse proportion to its mass and the closing speed
// is reflected, so a scout bounces off a frigate and barely moves it. Returns
// the closing speed, or a token positive value when they touch without closing,
// so a caller can tell contact from clear air; 0 means apart.
export function resolveShipPair(a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y
  const reach = a.boundRadius + b.boundRadius
  if (dx * dx + dy * dy >= reach * reach) {
    return 0
  }
  const contact = bodyContact(a.collisionOutline(), a, b.collisionOutline(), b)
  if (!contact) {
    return 0
  }
  const ux = contact.nx,
    uy = contact.ny
  const total = a.mass + b.mass
  const push = Math.max(0, contact.depth - CONFIG.CONTACT_SLOP)
  a.x -= ux * push * (b.mass / total)
  a.y -= uy * push * (b.mass / total)
  b.x += ux * push * (a.mass / total)
  b.y += uy * push * (a.mass / total)
  const vn = (b.vx - a.vx) * ux + (b.vy - a.vy) * uy
  if (vn >= 0) {
    return Number.MIN_VALUE // touching, but already separating
  }
  const j = (-(1 + CONFIG.SHIP_RESTITUTION) * vn) / (1 / a.mass + 1 / b.mass)
  a.vx -= (j * ux) / a.mass
  a.vy -= (j * uy) / a.mass
  b.vx += (j * ux) / b.mass
  b.vy += (j * uy) / b.mass
  return -vn
}

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
    this.cooldown = this.rollReload() * randRange(0.15, 1) // random phase so turrets don't fire in unison
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
    game.applyBeam(beam, host, this, this.type.damage)
    game.laserShots.push({
      beams: [beam],
      age: 0,
      color: this.type.colour,
      width: this.type.width,
      glow: this.type.glow,
      life: this.type.shotLife || 0.4,
    })
    this.cooldown = this.rollReload()
    Sound[this.type.sound || "fire"]()
  }

  update(dt, game, host, world) {
    this.tick(dt)
    if (!this.ready || !game.canFly() || host.leaving) {
      return
    }
    const controller = WEAPON_CONTROLLERS[this.controller]
    if (controller) {
      controller(this, dt, game, host, world)
    }
  }
}

// ---------------------------------------------------------------------------
// WEAPON CONTROLLERS - the firing behaviour behind a loadout's `controller`
// field. Each is called once per frame for a ready weapon as
// (weapon, dt, game, host, world), where `world` is the hardpoint's position,
// and fires through weapon.fireProjectile / weapon.emitBeam. Add a behaviour by
// adding an entry here and naming it in a loadout.
// ---------------------------------------------------------------------------
const MINER_RANGE = 420 // a scout starts mining once a rock is this close
const DEFENSE_BEAM_OVERSHOOT = 42 // beam reaches past the rock it is aimed at
const OFFSCREEN_MARGIN = 40

export const WEAPON_CONTROLLERS = {
  // driven directly by player input, see PlayerShip.fireLaser
  manual() {},

  // leads nothing: fires straight at the player whenever they are visible
  turret(weapon, dt, game, host, world) {
    const player = game.player
    // don't snipe the player from off-screen where they can't see the shooter
    if (!player || player.invincible > 0 || !game.onScreen(host.x, host.y, OFFSCREEN_MARGIN)) {
      return
    }
    const aim = Math.atan2(player.y - world.y, player.x - world.x)
    weapon.fireProjectile(game, world.x, world.y, aim, host)
  },

  // cuts rocks for ore, firing along the host's facing when one is near
  miner(weapon, dt, game, host, world) {
    let nearest = Infinity
    for (const asteroid of game.asteroids) {
      nearest = Math.min(
        nearest,
        Math.hypot(asteroid.center.x - host.x, asteroid.center.y - host.y),
      )
    }
    if (nearest < MINER_RANGE) {
      weapon.emitBeam(game, host, world.x, world.y, host.angle, weapon.rollLength())
    }
  },

  // heavy cannon: winds up with a growing glow (drawn by drawShip) and, once
  // committed, fires even if the player slips away, so the shot is telegraphed
  hunter(weapon, dt, game, host, world) {
    const player = game.player
    if (!player) {
      return
    }
    if (weapon.charging > 0) {
      weapon.charging -= dt
      if (weapon.charging <= 0) {
        weapon.charging = 0
        weapon.emitBeam(game, host, world.x, world.y, host.angle, weapon.type.length)
      }
      return
    }
    const toPlayer = Math.atan2(player.y - host.y, player.x - host.x)
    const arc = ((toPlayer - host.angle + Math.PI * 3) % TAU) - Math.PI
    const dist = Math.hypot(player.x - host.x, player.y - host.y)
    if (
      Math.abs(arc) < weapon.type.arc &&
      dist < weapon.type.length &&
      game.onScreen(host.x, host.y, OFFSCREEN_MARGIN)
    ) {
      weapon.charging = weapon.type.chargeTime || 0.8
      weapon.chargeDuration = weapon.charging
      Sound.charge()
    }
  },

  // the player's nose turret, firing from its hardpoint. Arrow keys aim
  // host.turretAim and fire on demand; with no input it auto-targets the
  // nearest rock in range.
  defense(weapon, dt, game, host, world) {
    if (host.turretManual > 0) {
      if (host.turretFiring) {
        weapon.emitBeam(game, host, world.x, world.y, host.turretAim, weapon.type.range)
      }
      return
    }
    let target = null,
      nearest = weapon.type.range
    for (const asteroid of game.asteroids) {
      const d = Math.hypot(asteroid.center.x - world.x, asteroid.center.y - world.y)
      if (d < nearest) {
        nearest = d
        target = asteroid
      }
    }
    if (target) {
      host.turretAim = Math.atan2(target.center.y - world.y, target.center.x - world.x)
      weapon.emitBeam(
        game,
        host,
        world.x,
        world.y,
        host.turretAim,
        nearest + DEFENSE_BEAM_OVERSHOOT,
      )
    }
  },
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
    return this.type.blocks.includes(channel)
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
        color: PALETTE.shield.flash,
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
    // The player is hit against its outline, as every other ship is: a circle
    // of `radius` is twice the hull's area and still leaves the nose outside it.
    const player = game.player
    if (
      player &&
      this.owner !== player &&
      this.#withinRadius(player.x, player.y, player.boundRadius) &&
      pointInPolygon(this, player.worldOutline())
    ) {
      this.dead = true
      game.burst(this.x, this.y, 8, PALETTE.weapon.bulletImpact, 40, 140, 0.4)
      game.screenShake = Math.max(game.screenShake, 5)
      Sound.hit()
      player.takeDamage(this.damage, game, "projectile", 0, { x: this.x, y: this.y })
      return
    }
    // A bounding-circle reject first: the exact polygon test is only worth its
    // cost (and, for ships, building the world outline) on a near miss.
    for (const rival of game.rivals) {
      if (rival === this.owner || !this.#withinRadius(rival.x, rival.y, rival.boundRadius)) {
        continue
      }
      if (pointInPolygon(this, rival.worldOutline())) {
        this.dead = true
        game.burst(this.x, this.y, 6, PALETTE.rival.hull, 40, 130, 0.4)
        rival.takeDamage(this.damage, game, "projectile", 0, { x: this.x, y: this.y })
        return
      }
    }
    for (const asteroid of game.asteroids) {
      if (
        asteroid === this.owner ||
        !this.#withinRadius(asteroid.center.x, asteroid.center.y, asteroid.boundRadius)
      ) {
        continue
      }
      if (pointInPolygon(this, asteroid.vertices)) {
        this.dead = true
        game.burst(this.x, this.y, 5, PALETTE.rock.impact, 30, 110, 0.3)
        asteroid.takeDamage(this.damage, game, "projectile", 0, { x: this.x, y: this.y })
        return
      }
    }
  }

  #withinRadius(cx, cy, radius) {
    const dx = this.x - cx,
      dy = this.y - cy
    return dx * dx + dy * dy <= radius * radius
  }

  draw(renderer) {
    renderer.line(this.x, this.y, this.x - this.vx * 0.02, this.y - this.vy * 0.02, {
      color: PALETTE.weapon.gun,
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
    this.boundRadius = 0
    this.colour = PALETTE.white
  }

  // Set the hull outline, the bounding circle broadphase tests use, and the
  // convex parts contacts are solved against. Every hull here is concave (the
  // player and the scout are darts with a notched tail, the frigate has a
  // waist), so the outline is partitioned into convex parts that tile it
  // exactly. Contacts then match the hull that is drawn, at any angle.
  setOutline(outlineLocal, size) {
    this.outlineLocal = outlineLocal
    this.size = size
    let furthest = 0
    for (const p of outlineLocal) {
      furthest = Math.max(furthest, Math.hypot(p[0], p[1]))
    }
    this.boundRadius = furthest * size
    this.collisionParts = convexPartition(outlineLocal.map(([x, y]) => ({ x, y })))
  }

  // The hull in world space as convex parts, for bodyContact.
  collisionOutline() {
    const world = this.worldOutline()
    return this.collisionParts.map((part) => part.map((i) => world[i]))
  }

  // Mass for collision response, in the same units as a rock's.
  get mass() {
    return this.type.mass ?? 1
  }

  buildHardpoints(list) {
    this.hardpoints = list.map((hp) => ({ local: hp.local, role: hp.role, module: null }))
  }

  hardpointByRole(role) {
    return this.hardpoints.find((hp) => hp.role === role) || null
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
        renderer.line(
          w.x,
          w.y,
          w.x + Math.cos(this.angle) * reach,
          w.y + Math.sin(this.angle) * reach,
          {
            color: m.type.colour,
            width: 1 + prog * 2.5,
            glow: 12,
            alpha: 0.3 + 0.5 * prog,
          },
        )
      }
      if (m.type.kind === "projectile") {
        renderer.circle(w.x, w.y, 3, { stroke: PALETTE.weapon.gun, width: 1.4, glow: 8 })
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
    this.type = PLAYER_TYPE
    this.radius = PLAYER_TYPE.size
    this.setOutline(PLAYER_TYPE.outline, PLAYER_TYPE.size)
    this.colour = PLAYER_TYPE.colour
    this.buildHardpoints(PLAYER_TYPE.hardpoints)
    this.applyLoadout(PLAYER_TYPE.loadout)
    this.nose = this.hardpointByRole("nose")
    this.aux = this.hardpointByRole("aux") // defense turret slot, filled by an upgrade
    this.mainWeapon = this.nose.module
    this.energyMax = game.maxEnergy()
    this.energy = this.energyMax
    this.regen = 0 // regen handled explicitly (paused while charging/thrusting)
    this.invincible = CONFIG.INVIN_TIME
    this.thrusting = false
    this.reversing = false
    this.items = []
    this.buffs = new Map() // powerup id -> seconds of effect remaining
    this.turretAim = 0
    this.turretManual = 0 // time left under player (arrow-key) control
    this.turretFiring = false
    this.atBoundary = false
    this.impactSfx = 0 // throttles collision / boundary sounds
    this.slamCooldown = 0 // one impact hit per collision, not one per frame
    // Warp presence: 1 is solid, 0 is gone. The ship is intangible below 1, and
    // the view turns this into the ripple and the hull fade.
    this.warp = 1
    this.warpTarget = 1
    this.warpHold = 0 // beat to wait before an arrival starts
  }

  damageResist() {
    return CONFIG.SHIELD_EFFICIENCY[this.game.upgrades.shield]
  }
  // Mid-warp the ship is not really in the sector, so nothing can reach it:
  // not rocks, and not the bullets and blasts that bypass contact entirely.
  takeDamage(amount, game, channel, scoreOnKill, impact) {
    if (!this.solid) {
      return false
    }
    return super.takeDamage(amount, game, channel, scoreOnKill, impact)
  }
  onHull() {
    this.game.playerLoseLife()
  }

  // Dissolve out of the sector, or fade back in after `delay` seconds.
  beginWarpOut() {
    this.warpTarget = 0
    this.warpHold = 0
    Sound.warpOut()
  }
  beginWarpIn(delay = 0) {
    this.warp = 0
    this.warpTarget = 1
    this.warpHold = delay
    if (delay <= 0) {
      Sound.warpIn()
    }
  }
  // True while the ship is mid-warp or waiting to start one.
  get warping() {
    return this.warpHold > 0 || this.warp !== this.warpTarget
  }
  // Solid enough to collide, be hit, and be flown.
  get solid() {
    return this.warp >= 1
  }

  #tickWarp(dt, game) {
    // sparks spiralling in toward the portal, so the arrival point is alive
    if (this.warping || this.warp < 1) {
      const angle = Math.random() * TAU
      const away = this.radius * randRange(3, 7)
      game.emit(
        this.x + Math.cos(angle) * away,
        this.y + Math.sin(angle) * away,
        -Math.cos(angle) * randRange(90, 190),
        -Math.sin(angle) * randRange(90, 190),
        0.28,
        PALETTE.player.exhaustFlame,
      )
    }
    if (this.warpHold > 0) {
      this.warpHold = Math.max(0, this.warpHold - dt)
      if (this.warpHold <= 0) {
        Sound.warpIn() // the hull starts forming now, not when the pause began
      }
      return
    }
    const step = dt / CONFIG.WARP_TIME
    if (this.warp < this.warpTarget) {
      this.warp = Math.min(this.warpTarget, this.warp + step)
    } else if (this.warp > this.warpTarget) {
      this.warp = Math.max(this.warpTarget, this.warp - step)
    }
  }

  // Seconds left on a timed powerup, 0 when it is not active.
  buffTime(id) {
    return this.buffs.get(id) ?? 0
  }

  // The active powerup type declaring `field`, or null. Effects are named in
  // POWERUP_TYPES rather than tested for by id, so the gameplay code below asks
  // "is anything lengthening my beam?" instead of "is BOOSTER running?".
  buffWith(field) {
    for (const id of this.buffs.keys()) {
      if (POWERUP_TYPES[id][field] !== undefined) {
        return POWERUP_TYPES[id]
      }
    }
    return null
  }
  buffField(field, fallback) {
    const type = this.buffWith(field)
    return type ? type[field] : fallback
  }
  grantBuff(id, seconds) {
    this.buffs.set(id, Math.max(this.buffTime(id), seconds))
  }
  #tickBuffs(dt) {
    for (const [id, remaining] of this.buffs) {
      if (remaining - dt <= 0) {
        this.buffs.delete(id)
      } else {
        this.buffs.set(id, remaining - dt)
      }
    }
  }

  installDefenseTurret() {
    const hp = this.aux
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
    const length = w.charge * this.beamLengthMult() + w.type.chargeReach
    const damage = w.type.damage * this.chargeDamageMult()
    const nose = this.mountWorld(this.nose.local)
    const dir = { x: Math.cos(this.angle), y: Math.sin(this.angle) },
      nrm = { x: -dir.y, y: dir.x }
    const offsets = this.buffField("beamOffsets", SINGLE_BEAM_OFFSETS)
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
      if (game.applyBeam(beam, this, w, damage)) {
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

  // Charged-beam reach multiplier, extended by a powerup that declares one.
  beamLengthMult() {
    return this.buffField("beamLengthMult", 1)
  }

  // Damage multiplier for the charge held, running across the usable charge
  // range so a minimum-charge shot is exactly the weapon's base damage.
  chargeDamageMult() {
    const w = this.mainWeapon
    const [low, high] = w.type.chargeDamageMult
    const span = w.type.chargeMax - w.type.chargeMin
    const frac = span > 0 ? clamp((w.charge - w.type.chargeMin) / span, 0, 1) : 0
    return lerp(low, high, frac)
  }

  update(dt, game) {
    this.invincible = Math.max(0, this.invincible - dt)
    this.#tickWarp(dt, game)
    this.#tickBuffs(dt)
    this.impactSfx = Math.max(0, this.impactSfx - dt)
    this.slamCooldown = Math.max(0, this.slamCooldown - dt)
    this.energyMax = game.maxEnergy()

    const keys = game.pressedKeys
    const canControl = game.canFly() && this.solid
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
        this.turretAim -= CONFIG.TURRET_AIM_RATE * dt
        active = true
      }
      if (keys.has("ArrowRight")) {
        this.turretAim += CONFIG.TURRET_AIM_RATE * dt
        active = true
      }
      if (keys.has("ArrowUp")) {
        this.turretFiring = true
        active = true
      }
      if (active) {
        this.turretManual = CONFIG.TURRET_MANUAL_HOLD
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
        PALETTE.player.exhaust,
      )
      // exhaust wash gently shoves rocks caught behind the thruster away
      const bx = Math.cos(back),
        by = Math.sin(back)
      const range = CONFIG.EXHAUST_WASH_RANGE
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
        const push =
          (CONFIG.EXHAUST_WASH_FORCE * (1 - dist / range) * align) /
          clamp(a.area / CONFIG.AST_MASS_AREA, 0.5, 4)
        a.vx += ux * push * dt
        a.vy += uy * push * dt
      }
    }

    this.reversing = canControl && game.upgrades.reverse && !this.thrusting && keys.has("KeyS")
    if (this.reversing) {
      this.vx -= Math.cos(this.angle) * CONFIG.ACCEL * CONFIG.REVERSE_ACCEL_MULT * dt
      this.vy -= Math.sin(this.angle) * CONFIG.ACCEL * CONFIG.REVERSE_ACCEL_MULT * dt
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
          PALETTE.player.exhaustFlame,
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
    this.atBoundary = this.confine(CONFIG.BOUNDARY_RESTITUTION, this.radius)
    if (this.atBoundary && !wasBoundary && this.impactSfx <= 0) {
      Sound.bump() // energy shield glancing the arena wall
      this.impactSfx = 0.15
    }

    // Charge the manual laser off the shared energy cell (its cooldown is
    // ticked by updateWeapons below).
    const w = this.mainWeapon
    const holding = canControl && keys.has("Space")
    const freeShot = this.buffField("freeCharge", false)
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
        this.energy = Math.min(
          this.energyMax,
          this.energy + CONFIG.PLAYER_REGEN[game.upgrades.core] * dt,
        )
      }
    }
    this.energy = clamp(this.energy, 0, this.energyMax)
    this.updateShield(dt)

    // Auto weapons (defense turret) fire via their controllers.
    this.updateWeapons(dt, game)

    // Collect ore (wider grab while vacuuming a cleared sector).
    const grabRadius =
      this.radius + (game.oreVacuum ? CONFIG.ORE_VACUUM_GRAB_RADIUS : CONFIG.ORE_GRAB_RADIUS)
    for (let i = game.oreChunks.length - 1; i >= 0; i--) {
      const chunk = game.oreChunks[i]
      if (Math.hypot(chunk.x - this.x, chunk.y - this.y) < grabRadius) {
        game.oreChunks.splice(i, 1)
        game.score += CONFIG.ORE_SCORE
        game.stats.ore++
        game.oreBalance++
        this.energy = Math.min(this.energyMax, this.energy + CONFIG.ORE_ENERGY)
        game.burst(chunk.x, chunk.y, 5, PALETTE.ore.spark, 20, 70, 0.4)
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
        const spec = POWERUP_TYPES[pickup.type]
        game.burst(pickup.x, pickup.y, 12, spec.colour, 30, 120, 0.6)
        game.showToast(`${spec.label} POWERUP COLLECTED`)
      }
    }

    this.#hitRocks(dt, game)
  }

  // Asteroid collision: reject on the rock's enclosing circle, then solve the
  // hull against the rock's real outline, both as convex parts, so the ship
  // touches what it can see. It is pushed out to the surface and its inward
  // velocity reflected, so it glances off rather than tunnelling through.
  // Momentum transfers to the rock; contact grinds energy.
  //
  // Every touching rock is resolved, and the sweep repeats, so a ship shoved
  // into a corner is separated from both rocks instead of being pushed out of
  // one and back into the other. Damage is charged once per frame however many
  // rocks are touching, so a corner is not doubly punishing.
  #hitRocks(dt, game) {
    if (!this.solid) {
      return // mid-warp the ship is not really here yet
    }
    let worstImpact = null
    let closingSpeed = 0
    let touching = false
    for (let sweep = 0; sweep < CONFIG.CONTACT_ITERATIONS; sweep++) {
      let moved = false
      for (const asteroid of game.asteroids) {
        const dx = this.x - asteroid.center.x,
          dy = this.y - asteroid.center.y
        const reach = asteroid.boundRadius + this.boundRadius
        if (dx * dx + dy * dy >= reach * reach) {
          continue
        }
        const contact = bodyContact(
          asteroid.convexParts(),
          asteroid.center,
          this.collisionOutline(),
          this,
        )
        if (!contact) {
          continue
        }
        touching = true
        moved = true
        const ux = contact.nx,
          uy = contact.ny
        this.x += ux * contact.depth
        this.y += uy * contact.depth

        // The bounce is against the rock's surface as it is actually moving, not
        // against a stationary obstacle: a rock that drifts or spins into a still
        // ship must carry it away. Judging the approach by the ship's own
        // velocity alone left it embedded, grinding its energy away every frame.
        const impact = { x: this.x - ux * this.radius, y: this.y - uy * this.radius }
        const leverX = impact.x - asteroid.center.x,
          leverY = impact.y - asteroid.center.y
        const surfaceVx = asteroid.vx - asteroid.spin * leverY,
          surfaceVy = asteroid.vy + asteroid.spin * leverX
        const vn = (this.vx - surfaceVx) * ux + (this.vy - surfaceVy) * uy
        if (vn < 0) {
          closingSpeed = Math.max(closingSpeed, -vn)
          worstImpact = impact
          const mass = rockMass(asteroid.area)
          // a rock resists a shove off its centre less the further out it lands
          const inertia = 0.5 * mass * Math.max(asteroid.boundRadius, 1) ** 2
          const lever = leverX * uy - leverY * ux
          const share = this.mass + 1 / mass + (lever * lever) / inertia
          const j = (-(1 + CONFIG.ROCK_RESTITUTION) * vn) / share
          this.vx += (j * ux) / this.mass
          this.vy += (j * uy) / this.mass
          asteroid.vx -= (j * ux) / mass
          asteroid.vy -= (j * uy) / mass
          asteroid.spin -= (leverX * j * uy - leverY * j * ux) / inertia
          if (-vn > 45 && this.impactSfx <= 0) {
            Sound.bump() // knock on contact with a rock
            this.impactSfx = 0.15
          }
        } else if (!worstImpact) {
          worstImpact = impact
        }
      }
      if (!moved) {
        break
      }
    }
    if (!touching || this.invincible > 0 || this.buffField("collisionImmune", false)) {
      return
    }
    game.screenShake = Math.max(game.screenShake, 3)
    if (this.fxCooldown <= 0) {
      game.burst(this.x, this.y, 4, PALETTE.player.lowEnergy, 30, 90, 0.35)
    }
    // A steady grind for as long as contact lasts, plus a knock scaled to how
    // hard it landed. Contact is a frame or two now that the bounce works, so
    // without the second term a full-speed ram would cost the same as brushing
    // past.
    const grind = CONFIG.DMG_AST_GUN * dt * CONFIG.ROCK_GRIND_DAMAGE
    let slam = 0
    if (closingSpeed > 0 && this.slamCooldown <= 0) {
      slam = closingSpeed * CONFIG.ROCK_IMPACT_DAMAGE
      this.slamCooldown = CONFIG.ROCK_IMPACT_COOLDOWN
    }
    // flash the shield on the side facing the rock
    this.takeDamage(grind + slam, game, "projectile", 0, worstImpact)
  }

  // Materialising or dissolving: a portal pulses at the arrival point, then the
  // hull swells out of it and fades in, with rings running outward. The
  // screen-space ripple is the view's job; deep space has little to distort, so
  // the portal is what actually reads on screen.
  #drawWarp(renderer, game) {
    const t = this.warp
    const pulse = 0.5 + 0.5 * Math.sin(game.gameTime * 9)
    renderer.circle(this.x, this.y, this.radius * (1.5 + 0.55 * pulse), {
      stroke: PALETTE.player.hull,
      width: 1.5,
      glow: 18,
      alpha: (1 - t) * (0.3 + 0.4 * pulse),
    })
    if (t <= 0) {
      return // nothing has formed yet, just the portal
    }
    const c = Math.cos(this.angle),
      s = Math.sin(this.angle)
    const scale = this.size * (0.3 + 0.7 * t)
    const hull = this.outlineLocal.map((p) => ({
      x: this.x + (p[0] * c - p[1] * s) * scale,
      y: this.y + (p[0] * s + p[1] * c) * scale,
    }))
    renderer.strokePoly(hull, { color: this.colour, width: 1.9, glow: 20, alpha: t })
    for (let i = 0; i < 2; i++) {
      const ring = clamp(t * 1.5 - i * 0.4, 0, 1)
      if (ring <= 0 || ring >= 1) {
        continue
      }
      renderer.circle(this.x, this.y, this.radius * (1 + ring * 5), {
        stroke: PALETTE.player.hull,
        width: 1.6,
        glow: 14,
        alpha: (1 - ring) * 0.8,
      })
    }
  }

  draw(renderer, game) {
    if (this.warping || this.warp < 1) {
      this.#drawWarp(renderer, game)
      return
    }
    if (this.invincible > 0 && Math.floor(game.gameTime * 12) % 2 === 0) {
      return
    } // blink while invincible
    const tint = this.buffWith("tintsShip")
    const colour = tint
      ? tint.colour
      : this.energy < this.energyMax * 0.22
        ? PALETTE.player.lowEnergy
        : this.colour

    if (this.thrusting) {
      const flame = randRange(0.7, 1.3)
      const pts = [
        this.#toWorld(-this.radius * 0.7, -4),
        this.#toWorld(-this.radius * (1.1 + flame), 0),
        this.#toWorld(-this.radius * 0.7, 4),
      ]
      renderer.strokePoly(pts, {
        color: PALETTE.player.exhaustFlame,
        width: 1.4,
        glow: 10,
        closed: false,
      })
    }
    renderer.strokePoly(this.worldOutline(), { color: colour, width: 1.9, glow: 14 })
    if (tint) {
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

    if (game.upgrades.turret && this.aux) {
      const aim = this.turretAim || 0
      const mount = this.mountWorld(this.aux.local)
      renderer.circle(mount.x, mount.y, 3.4, { stroke: PALETTE.player.turret, width: 1.6, glow: 8 })
      renderer.line(mount.x, mount.y, mount.x + Math.cos(aim) * 12, mount.y + Math.sin(aim) * 12, {
        color: PALETTE.player.turret,
        width: 1.6,
        glow: 8,
      })
    }

    const w = this.mainWeapon
    if (w && w.charge > 4) {
      const nose = this.mountWorld(this.nose.local)
      const length = w.charge * this.beamLengthMult() + w.type.chargeReach
      const frac = clamp(w.charge / w.type.chargeMax, 0.3, 1)
      renderer.line(
        nose.x,
        nose.y,
        nose.x + Math.cos(this.angle) * length,
        nose.y + Math.sin(this.angle) * length,
        {
          color: PALETTE.player.charge,
          alpha: frac,
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
    this.setOutline(type.outline, type.size)
    this.colour = type.colour
    this.accel = type.accel
    this.maxSpeed = type.maxSpeed
    this.turnRate = type.turnRate
    this.drag = type.drag
    this.exhaustFactor = type.exhaustFactor
    this.energyMax = type.energyMax
    this.energy = type.energyMax
    this.regen = type.regen
    this.hull = type.hull || 60 // hull HP once the shield is gone; more than one hit
    this.lifeTimer = randRange(type.lifeTime[0], type.lifeTime[1])
    this.leaving = false
    this.buildHardpoints(type.hardpoints)
    const activeLoadout = loadout || type.loadout || []
    this.applyLoadout(activeLoadout)
    this.hunts = activeLoadout.some((e) => e.controller === "hunter")
  }

  // Hull hits chip the hull down rather than destroying outright, so the laser
  // no longer one-shots ships. A surviving hit sparks; zero hull destroys.
  onHull(amount, game, channel, scoreOnKill) {
    this.hull -= amount
    if (this.hull <= 0) {
      this.destroy(game, scoreOnKill)
    } else {
      game.burst(this.x, this.y, 4, PALETTE.rival.hullSpark, 30, 110, 0.35)
    }
  }

  destroy(game, scoreOnKill) {
    const debris = this.type.debris
    this.dead = true
    game.burst(this.x, this.y, debris.particles, PALETTE.rival.hull, 60, debris.speed, 0.9)
    game.ring(this.x, this.y, debris.ring, PALETTE.fx.flash, 180, 0.8)
    for (let k = 0; k < this.type.oreDrop; k++) {
      game.spawnOre(
        this.x + randRange(-18, 18),
        this.y + randRange(-18, 18),
        randRange(-70, 70),
        randRange(-70, 70),
      )
    }
    game.score += scoreOnKill
    game.screenShake = Math.max(game.screenShake, debris.shake)
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
        PALETTE.rival.hull,
      )
    }

    for (let i = game.oreChunks.length - 1; i >= 0; i--) {
      if (Math.hypot(game.oreChunks[i].x - this.x, game.oreChunks[i].y - this.y) < 18) {
        game.oreChunks.splice(i, 1)
        game.rivalScore += CONFIG.ORE_SCORE
        game.burst(this.x, this.y, 4, PALETTE.rival.hull, 30, 80, 0.3)
      }
    }

    this.#bounceOffRocks(game)
    this.updateWeapons(dt, game) // guns + main laser fire via their controllers

    if (this.leaving && Math.hypot(this.x - ARENA.cx, this.y - ARENA.cy) > ARENA.radius + 140) {
      this.dead = true
    }
  }

  // Rivals are solid: they shoulder rocks aside instead of flying through them.
  // Contact is the rock's outline against the ship's, both as convex parts, so
  // a frigate's length and waist are respected.
  #bounceOffRocks(game) {
    for (const asteroid of game.asteroids) {
      const dx = this.x - asteroid.center.x,
        dy = this.y - asteroid.center.y
      const reach = asteroid.boundRadius + this.boundRadius
      if (dx * dx + dy * dy >= reach * reach) {
        continue
      }
      const contact = bodyContact(
        asteroid.convexParts(),
        asteroid.center,
        this.collisionOutline(),
        this,
      )
      if (!contact) {
        continue
      }
      const ux = contact.nx,
        uy = contact.ny
      this.x += ux * contact.depth
      this.y += uy * contact.depth
      // approach measured at the contact against the rock's moving surface,
      // spin included, as for the player
      const impactX = this.x - ux * this.boundRadius - asteroid.center.x,
        impactY = this.y - uy * this.boundRadius - asteroid.center.y
      const surfaceVx = asteroid.vx - asteroid.spin * impactY,
        surfaceVy = asteroid.vy + asteroid.spin * impactX
      const vn = (this.vx - surfaceVx) * ux + (this.vy - surfaceVy) * uy
      if (vn >= 0) {
        continue
      }
      const mass = rockMass(asteroid.area)
      const j = (-(1 + CONFIG.ROCK_RESTITUTION) * vn) / (this.mass + 1 / mass)
      this.vx += (j * ux) / this.mass
      this.vy += (j * uy) / this.mass
      asteroid.vx -= (j * ux) / mass
      asteroid.vy -= (j * uy) / mass
    }
  }

  draw(renderer, game) {
    this.drawShip(renderer, game, this.type.hullWidth)
    renderer.circle(this.x, this.y, 1.6, { fill: PALETTE.rival.core, glow: 8 })
  }
}

// ---------------------------------------------------------------------------
// Asteroid: a convex polygon with hardpoints (guns/shield) that are kept when
// it splits, so an asteroid with two guns becomes two with one gun each.
// ---------------------------------------------------------------------------
// Build an asteroid silhouette: scatter a few overlapping circles ("lobes"),
// sample a ring of jittered points around each, and take the convex hull of the
// lot. One lobe reads as a rounded rock, two as a peanut or a wedge, three as
// something lumpier, so a field has a mix of characters.
//
// The hull is convex by construction, which is what keeps slicing well-behaved,
// and it is then scaled about its centroid to the area a circle of `radius`
// implies. That separates the two concerns: lobe layout decides the shape,
// `radius` decides the size, and a caller always gets the size it asked for.
export function makeAsteroidPolygon(cx, cy, radius) {
  const shape = AST_SHAPE
  const lobes = [{ x: 0, y: 0, r: radius * randRange(shape.firstLobeRadius[0], 1) }]
  const lobeCount = randInt(shape.lobes[0], shape.lobes[1])
  for (let i = 1; i < lobeCount; i++) {
    // hang each further lobe off one already placed, close enough to overlap
    const anchor = lobes[randInt(0, lobes.length - 1)]
    const r = radius * randRange(shape.lobeRadius[0], shape.lobeRadius[1])
    const angle = Math.random() * TAU
    const gap = (anchor.r + r) * randRange(shape.lobeSpread[0], shape.lobeSpread[1])
    lobes.push({
      x: anchor.x + Math.cos(angle) * gap,
      y: anchor.y + Math.sin(angle) * gap,
      r,
    })
  }

  const points = []
  for (const lobe of lobes) {
    const count = randInt(shape.pointsPerLobe[0], shape.pointsPerLobe[1])
    const phase = Math.random() * TAU
    for (let i = 0; i < count; i++) {
      const angle = phase + (i / count) * TAU + randRange(-shape.angleJitter, shape.angleJitter)
      const r = lobe.r * randRange(shape.radiusJitter[0], shape.radiusJitter[1])
      points.push({ x: lobe.x + Math.cos(angle) * r, y: lobe.y + Math.sin(angle) * r })
    }
  }

  const hull = convexHull(points)
  const area = polygonArea(hull)
  if (hull.length < 3 || area <= 0) {
    return hull.map((p) => ({ x: cx + p.x, y: cy + p.y })) // degenerate, leave as is
  }
  const centre = polygonCentroid(hull)
  const scale = Math.sqrt((Math.PI * radius * radius * shape.areaFactor) / area)
  return hull.map((p) => ({
    x: cx + (p.x - centre.x) * scale,
    y: cy + (p.y - centre.y) * scale,
  }))
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
    this.hardpoints = opts.hardpoints || []
    this.tint = opts.tint || null // overrides the rock palette (e.g. frigate debris)
    this.recompute()

    // What this piece is made of. Rock is the default and carries no material;
    // anything else (ship plating today) describes how small a fragment of it
    // can survive and whether a fresh cut face catches fire. It travels with the
    // piece, so a fragment of a fragment is made of the same stuff.
    // `burnFrom` is the cut line that exposed faces on this piece specifically.
    // Faces are held as vertex index pairs, so they follow it as it drifts.
    this.material = opts.material || null
    this.burn = 0
    this.burnFaces = []
    this.burnBacklog = 0
    if (this.burnSpec && opts.burnFrom) {
      this.burnFaces = this.#facesOnLine(opts.burnFrom.point, opts.burnFrom.normal)
      if (this.burnFaces.length) {
        this.burn = this.burnSpec.seconds
      }
    }

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
    // encloses every vertex, so it is the broadphase reject for contacts
    this.boundRadius = boundingRadius(this.vertices, this.center)
    this.x = this.center.x
    this.y = this.center.y
  }

  // Mass for collision response, in the same units as a ship type's.
  get mass() {
    return rockMass(this.area)
  }

  // The outline as convex parts, for bodyContact. A whole rock is a convex hull
  // by construction and needs no splitting, but a piece cut from a ship carries
  // the hull's concavity, and a separating-axis test on a concave shape reports
  // contacts across the notch. The partition is by vertex index, so it survives
  // the piece drifting and spinning and is only rebuilt when a cut makes a new
  // outline.
  convexParts() {
    if (!this.parts) {
      this.parts = convexPartition(this.vertices)
    }
    return this.parts.map((part) => part.map((i) => this.vertices[i]))
  }

  // Edges with both ends sitting on the given line: the faces a cut opened up,
  // as opposed to the piece's share of the original hull.
  #facesOnLine(point, normal) {
    const onLine = (p) =>
      Math.abs((p.x - point.x) * normal.x + (p.y - point.y) * normal.y) < CONFIG.CUT_EDGE_TOLERANCE
    const edges = []
    for (let i = 0; i < this.vertices.length; i++) {
      const j = (i + 1) % this.vertices.length
      if (onLine(this.vertices[i]) && onLine(this.vertices[j])) {
        edges.push([i, j])
      }
    }
    return edges
  }

  // Smallest fragment of this material that survives a cut; below it, ore.
  get minArea() {
    return (this.material && this.material.minArea) || CONFIG.AST_MIN_AREA
  }
  // Non-null when this material burns where it is cut.
  get burnSpec() {
    return (this.material && this.material.burn) || null
  }

  // How hot the cut faces still are, 1 just after the cut down to 0 when out.
  get heat() {
    return this.burnSpec && this.burn > 0 ? this.burn / this.burnSpec.seconds : 0
  }

  // Fire licking off the raw faces, thinning out as the piece burns itself out.
  #burnFaces(dt, game) {
    this.burn = Math.max(0, this.burn - dt)
    const heat = this.heat
    this.burnBacklog += this.burnSpec.rate * heat * dt
    while (this.burnBacklog >= 1) {
      this.burnBacklog -= 1
      const [i, j] = this.burnFaces[randInt(0, this.burnFaces.length - 1)]
      const a = this.vertices[i],
        b = this.vertices[j]
      const along = Math.random()
      const px = a.x + (b.x - a.x) * along,
        py = a.y + (b.y - a.y) * along
      // face outward, away from the body of the piece
      let nx = -(b.y - a.y),
        ny = b.x - a.x
      const len = Math.hypot(nx, ny) || 1
      nx /= len
      ny /= len
      if ((px - this.center.x) * nx + (py - this.center.y) * ny < 0) {
        nx = -nx
        ny = -ny
      }
      const speed = randRange(18, 62) * (0.45 + 0.55 * heat)
      game.emit(
        px,
        py,
        this.vx + nx * speed + randRange(-16, 16),
        this.vy + ny * speed + randRange(-16, 16),
        randRange(0.16, 0.38),
        Math.random() < 0.35 ? PALETTE.fx.ember : PALETTE.fx.fire,
      )
    }
  }

  // Move the whole rock: outline, mounted hardpoints and centre together.
  translate(dx, dy) {
    for (const p of this.vertices) {
      p.x += dx
      p.y += dy
    }
    for (const hp of this.hardpoints) {
      hp.x += dx
      hp.y += dy
    }
    this.center.x += dx
    this.center.y += dy
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
    this.vx *= Math.pow(CONFIG.AST_DRAG, dt)
    this.vy *= Math.pow(CONFIG.AST_DRAG, dt)
    this.spin *= Math.pow(CONFIG.AST_SPIN_DRAG, dt)
    const speed = Math.hypot(this.vx, this.vy)
    if (speed > CONFIG.AST_MAX_SPEED) {
      this.vx *= CONFIG.AST_MAX_SPEED / speed
      this.vy *= CONFIG.AST_MAX_SPEED / speed
    }
    // Cap the rim speed, not the rate: a big rock spinning at the rate that
    // suits a small chunk would sweep its edge faster than anything can fly,
    // and would fling the ship away harder than it can ever travel.
    const maxSpin = CONFIG.AST_MAX_RIM_SPEED / Math.max(this.boundRadius, 1)
    this.spin = clamp(this.spin, -maxSpin, maxSpin)
    this.recompute()

    // Arena confinement: when the rock's body crosses the boundary circle, push
    // it (vertices, hardpoints, centre) back inside and reflect its velocity so
    // it is repelled into the play zone.
    const dcx = this.center.x - ARENA.cx,
      dcy = this.center.y - ARENA.cy
    const cdist = Math.hypot(dcx, dcy)
    if (cdist > 0) {
      const ux = dcx / cdist,
        uy = dcy / cdist
      // the outermost vertex in the outward direction is what must stay inside
      const over = cdist + supportDistance(this.vertices, this.center, ux, uy) - ARENA.radius
      if (over > 0) {
        this.translate(-ux * over, -uy * over)
        const vn = this.vx * ux + this.vy * uy
        if (vn > 0) {
          this.vx -= CONFIG.AST_BOUNDARY_BOUNCE * vn * ux
          this.vy -= CONFIG.AST_BOUNDARY_BOUNCE * vn * uy
        }
      }
    }

    if (this.burn > 0) {
      this.#burnFaces(dt, game)
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
      if (area < this.minArea) {
        const oreCount = clamp(Math.round(area / CONFIG.ORE_PER_FRAGMENT_AREA) + 1, 1, 4)
        for (let k = 0; k < oreCount; k++) {
          game.spawnOre(
            centre.x + randRange(-10, 10),
            centre.y + randRange(-10, 10),
            this.vx + ix * 0.4 + randRange(-30, 30),
            this.vy + iy * 0.4 + randRange(-30, 30),
          )
        }
        game.burst(centre.x, centre.y, randInt(6, 12), PALETTE.ore.body, 30, 110, 0.6)
        Sound.shatter()
        game.stats.mined++
        continue
      }
      // keep the gun/shield hardpoints that fall inside this piece (containment
      // is correct even when a concave cut produces more than two pieces)
      const mine = this.hardpoints.filter((hp) => pointInPolygon(hp, partVerts))
      const frag = new Asteroid({
        vertices: partVerts,
        vx: this.vx + ix,
        vy: this.vy + iy,
        spin: this.spin + randRange(-2, 2),
        hardpoints: mine,
        energy: this.energy,
        tint: this.tint,
        // same stuff as the parent, and this cut opens fresh faces on it
        material: this.material,
        burnFrom: { point: beam.a, normal: cutNormal },
      })
      fragments.push(frag)
    }
    return fragments
  }

  detonate(game) {
    this.dead = true
    game.stats.mined++
    game.burst(this.center.x, this.center.y, randInt(48, 68), PALETTE.fx.fire, 60, 360, 0.95)
    game.burst(this.center.x, this.center.y, randInt(20, 30), PALETTE.fx.ember, 40, 190, 0.8)
    game.ring(this.center.x, this.center.y, 30, PALETTE.fx.flash, 300, 0.85)
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
      return PALETTE.rock.explosive
    }
    const sh = this.shieldModule(),
      shielded = sh && sh.up,
      gun = this.hasGun()
    if (gun && shielded) {
      return PALETTE.rock.gunShielded
    }
    if (gun) {
      return PALETTE.rock.gun
    }
    if (shielded) {
      return PALETTE.rock.shielded
    }
    // hue ramps from the smallest surviving piece to the largest a sector spawns
    const largest = AST_SHAPE.areaFactor * Math.PI * CONFIG.AST_MAX_R * CONFIG.AST_MAX_R
    const t = clamp((this.area - CONFIG.AST_MIN_AREA) / (largest - CONFIG.AST_MIN_AREA), 0, 1)
    return `hsl(${lerp(PALETTE.rock.sizeWarm, PALETTE.rock.sizeCool, t).toFixed(0)} 92% ${lerp(60, 72, t).toFixed(0)}%)`
  }

  draw(renderer, game) {
    renderer.strokePoly(this.vertices, { color: this.colour(), width: 1.7, glow: 11 })
    if (this.burn > 0) {
      // the raw face still glowing, cooling as it burns out
      const heat = this.heat
      for (const [i, j] of this.burnFaces) {
        const a = this.vertices[i],
          b = this.vertices[j]
        renderer.line(a.x, a.y, b.x, b.y, {
          color: PALETTE.fx.fire,
          width: 1.6 + 1.8 * heat,
          glow: 10 + 16 * heat,
          alpha: 0.35 + 0.55 * heat,
        })
      }
    }
    if (this.explosive) {
      const pulse = 0.5 + 0.5 * Math.sin(game.gameTime * 6)
      renderer.circle(this.center.x, this.center.y, 4 + 2 * pulse, {
        fill: PALETTE.rock.explosiveCore,
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
      renderer.circle(hp.x, hp.y, 3.4, { stroke: PALETTE.weapon.gun, width: 1.6, glow: 8 })
      renderer.line(hp.x, hp.y, hp.x + Math.cos(aim) * 10, hp.y + Math.sin(aim) * 10, {
        color: PALETTE.weapon.gun,
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
    this.life = CONFIG.ORE_LIFE
    this.size = randRange(4, 6.5)
  }

  update(dt, game) {
    this.life -= dt
    const player = game.player,
      dist = Math.hypot(this.x - player.x, this.y - player.y)
    // A powerup declaring a `pull` reaches the whole sector; the fitted magnet
    // only works inside its range.
    const buffPull = player.buffField("pull", 0)
    if (game.oreVacuum || buffPull || dist < CONFIG.MAGNET_RANGE[game.upgrades.magnet]) {
      const pull = normalize(subtract(player, this))
      const force = game.oreVacuum ? CONFIG.ORE_VACUUM_PULL : buffPull || CONFIG.ORE_PASSIVE_PULL
      this.vx += pull.x * force * dt
      this.vy += pull.y * force * dt
    }
    this.vx *= Math.pow(0.55, dt)
    this.vy *= Math.pow(0.55, dt)
    this.integrate(dt)
    this.angle += this.spin * dt
    this.confine(0.4, this.size)
    if (this.life <= 0) {
      game.burst(this.x, this.y, randInt(5, 8), PALETTE.ore.body, 40, 150, 0.4)
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
    this.life = CONFIG.POWERUP_LIFE
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
    const spec = POWERUP_TYPES[this.type]
    const colour = spec.colour,
      pts = []
    for (let i = 0; i < 6; i++) {
      const a = this.angle + (i / 6) * TAU
      pts.push({ x: this.x + Math.cos(a) * 12, y: this.y + Math.sin(a) * 12 })
    }
    renderer.strokePoly(pts, { color: colour, width: 1.7, glow: 14 })
    renderer.text(spec.icon, this.x, this.y, {
      size: 12,
      color: colour,
      align: "center",
      baseline: "middle",
      bold: true,
      glow: 14,
    })
  }
}
