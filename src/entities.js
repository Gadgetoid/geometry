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
  weightedPick,
  clamp,
  lerp,
  subtract,
  normalize,
  dot,
  pointInPolygon,
  convexHull,
  convexPartition,
  polygonArea,
  polygonCentroid,
  boundingRadius,
  boundaryDistance,
  perpendicular,
  slicePolygon,
  segmentCircleEntry,
  distanceToPolygon,
  convexContact,
  supportDistance,
  bearingTo,
  shortestTurn,
} from "./math.js"
import {
  TAU,
  VIEW_W,
  VIEW_H,
  ARENA,
  CONFIG,
  WEAPON_TYPES,
  SHIELD_TYPES,
  ENGINE_TYPES,
  RADAR_TYPES,
  THRUSTER_TYPES,
  CORE_TYPES,
  SHIP_TYPES,
  PLAYER_TYPE,
  EQUIPMENT,
  AST_SHAPE,
  SPECIAL_TYPES,
  MAX_SLOTS,
  SHIELD_SPARK,
  flightStats,
  barrelCount,
} from "./config.js"
import { Sound } from "./audio.js"
import { PALETTE, mixColour } from "./palette.js"

const SINGLE_BEAM_OFFSETS = [0] // the player's laser without the multi special

// Mass a rock's area implies, in the same units as a ship type's `mass`.
export function rockMass(area) {
  return clamp(area / CONFIG.AST_MASS_AREA, CONFIG.AST_MASS_RANGE[0], CONFIG.AST_MASS_RANGE[1])
}

// What a piece too small to survive a cut is worth: one chunk per
// ORE_PER_FRAGMENT_AREA of it, so a piece just under the threshold yields a
// handful and a splinter yields one. Shared, so a sliver cut off a hull and a
// rock fragment of the same size are worth the same.
export function oreFromFragment(area) {
  return clamp(Math.round(area / CONFIG.ORE_PER_FRAGMENT_AREA) + 1, 1, 4)
}

// ---------------------------------------------------------------------------
// A raw face left by a cut, and the fire off it. Shared, because a piece cut off a hull
// and the hull it was cut from both have a face along the same line, and both burn if
// what they are made of does.
// ---------------------------------------------------------------------------
// Which edges of a world outline lie along a cut, as index pairs so they follow the
// outline as it drifts and turns.
export function facesOnLine(vertices, point, normal) {
  const onLine = (p) =>
    Math.abs((p.x - point.x) * normal.x + (p.y - point.y) * normal.y) < CONFIG.CUT_EDGE_TOLERANCE
  const edges = []
  for (let i = 0; i < vertices.length; i++) {
    const j = (i + 1) % vertices.length
    if (onLine(vertices[i]) && onLine(vertices[j])) {
      edges.push([i, j])
    }
  }
  return edges
}

// Fire for a body whose material states no colour of its own: rock, which does not burn
// where it is cut but still throws flame when something bolted to it comes apart.
export const DEFAULT_BURN = {
  colour: PALETTE.fx.fire,
  ember: PALETTE.fx.ember,
  smoke: PALETTE.fx.smoke,
}

// How smoke leaves a burning face. It is given only a fraction of the body's own motion,
// so a piece that is still moving strings its smoke out behind it: the trail is the
// smoke being left where it was made, not a drawn effect.
const SMOKE_CARRY = 0.2
const SMOKE_SPEED = [7, 26]
const SMOKE_LIFE = [0.5, 1.05] // against fire's 0.16 to 0.38, so it hangs long after the flame

// Fire licking off those faces and smoke coming off with it, thinning out as the heat
// goes. `carry` holds the fractional particle of each between frames, and the new pair
// is returned.
export function emitBurn(game, body, vertices, faces, spec, heat, carry, dt) {
  const centre = body.center || body
  // Somewhere along a raw face, and the way out of the body there.
  const onFace = () => {
    const [i, j] = faces[randInt(0, faces.length - 1)]
    const a = vertices[i],
      b = vertices[j]
    const along = Math.random()
    const px = a.x + (b.x - a.x) * along,
      py = a.y + (b.y - a.y) * along
    // face outward, away from the body behind the face
    let nx = -(b.y - a.y),
      ny = b.x - a.x
    const len = Math.hypot(nx, ny) || 1
    nx /= len
    ny /= len
    if ((px - centre.x) * nx + (py - centre.y) * ny < 0) {
      nx = -nx
      ny = -ny
    }
    return { px, py, nx, ny }
  }

  let fire = carry.fire + spec.rate * heat * dt
  while (fire >= 1) {
    fire -= 1
    const { px, py, nx, ny } = onFace()
    const speed = randRange(18, 62) * (0.45 + 0.55 * heat)
    game.emit(
      px,
      py,
      body.vx + nx * speed + randRange(-16, 16),
      body.vy + ny * speed + randRange(-16, 16),
      randRange(0.16, 0.38),
      Math.random() < 0.35 ? spec.ember : spec.colour,
    )
  }

  // Smoke keeps coming as the flame dies down, so a wreck that has finished burning is
  // still smouldering on its way out.
  let smoke = carry.smoke + spec.smokeRate * (0.35 + 0.65 * heat) * dt
  while (smoke >= 1) {
    smoke -= 1
    const { px, py, nx, ny } = onFace()
    const speed = randRange(SMOKE_SPEED[0], SMOKE_SPEED[1]) * (0.5 + 0.5 * heat)
    game.emit(
      px,
      py,
      body.vx * SMOKE_CARRY + nx * speed + randRange(-9, 9),
      body.vy * SMOKE_CARRY + ny * speed + randRange(-9, 9),
      randRange(SMOKE_LIFE[0], SMOKE_LIFE[1]),
      spec.smoke,
    )
  }
  return { fire, smoke }
}

// The raw face itself, still glowing and cooling as it goes out.
export function drawBurnFaces(renderer, vertices, faces, spec, heat) {
  for (const [i, j] of faces) {
    const a = vertices[i],
      b = vertices[j]
    renderer.line(a.x, a.y, b.x, b.y, {
      color: spec.colour,
      width: 1.6 + 1.8 * heat,
      glow: 10 + 16 * heat,
      alpha: 0.35 + 0.55 * heat,
    })
  }
}

// Contact between two bodies. A body presents one of two surfaces: a disc, when
// a shield is raised over it, or its real outline as a list of convex parts that
// tile it. Callers reject on the enclosing circles first. Returns the push `b`
// must take (and `a` resist), or null when they are apart.
//
// A raised shield is a physical barrier, not only something shots stop against,
// so a hull cannot be flown inside a bubble it can see. A bubble is round, so a
// disc is its shape rather than a proxy for it, which is the same answer beams
// and shots already give.
//
// The two halves of the answer are measured differently, and both matter:
//
// Whether they touch at all is decided surface against surface, part by part,
// which is exact for any outline. A separating-axis test on a concave outline
// reports a contact across its notch, which is what a plain SAT call on a cut
// hull would do.
//
// How far to push is then measured over each body as a whole: for a candidate
// axis, how far must b travel along it before it clears every part of a. The
// axis needing least travel wins, so the result is the smallest push that
// separates the bodies completely. Answering with one part pair's own push
// instead is wrong either way round - the shallowest pair stops as soon as it
// alone is clear and leaves the others interpenetrating, while the deepest pair
// names the one axis that is worst to push along.
export function shapeContact(a, b) {
  if (!shapesTouch(a, b)) {
    return null
  }
  let bestDepth = Infinity,
    bestX = 0,
    bestY = 0
  for (const [nx, ny] of contactAxes(a, b)) {
    const depth = shapeExtent(a, nx, ny).max - shapeExtent(b, nx, ny).min
    if (depth > 0 && depth < bestDepth) {
      bestDepth = depth
      bestX = nx
      bestY = ny
    }
  }
  if (bestDepth === Infinity) {
    return null
  }
  return { nx: bestX, ny: bestY, depth: bestDepth }
}

// Two outlines, with no shield over either. Kept as its own name because most
// callers know they are solving hull against hull.
export function bodyContact(partsA, centreA, partsB, centreB) {
  return shapeContact({ centre: centreA, parts: partsA }, { centre: centreB, parts: partsB })
}

// How far a surface reaches along an axis.
function shapeExtent(shape, nx, ny) {
  if (shape.radius) {
    const centre = shape.centre.x * nx + shape.centre.y * ny
    return { min: centre - shape.radius, max: centre + shape.radius }
  }
  let min = Infinity,
    max = -Infinity
  for (const part of shape.parts) {
    for (const v of part) {
      const d = v.x * nx + v.y * ny
      if (d < min) {
        min = d
      }
      if (d > max) {
        max = d
      }
    }
  }
  return { min, max }
}

// Nearest point of a convex part to `p`, and whether `p` is inside it.
function nearestOnPart(part, p) {
  let distance = Infinity,
    point = part[0]
  for (let i = 0; i < part.length; i++) {
    const a = part[i],
      b = part[(i + 1) % part.length]
    const dx = b.x - a.x,
      dy = b.y - a.y
    const len2 = dx * dx + dy * dy || 1
    const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1)
    const qx = a.x + dx * t,
      qy = a.y + dy * t
    const d = Math.hypot(p.x - qx, p.y - qy)
    if (d < distance) {
      distance = d
      point = { x: qx, y: qy }
    }
  }
  return { point, distance, inside: pointInPolygon(p, part) }
}

function shapesTouch(a, b) {
  if (a.radius && b.radius) {
    return Math.hypot(b.centre.x - a.centre.x, b.centre.y - a.centre.y) < a.radius + b.radius
  }
  if (a.radius || b.radius) {
    const disc = a.radius ? a : b,
      outline = a.radius ? b : a
    for (const part of outline.parts) {
      const near = nearestOnPart(part, disc.centre)
      if (near.inside || near.distance < disc.radius) {
        return true
      }
    }
    return false
  }
  for (const pa of a.parts) {
    for (const pb of b.parts) {
      if (convexContact(pa, pb, a.centre, b.centre)) {
        return true
      }
    }
  }
  return false
}

// Every axis worth testing, each oriented from a toward b up front so an overlap
// has one meaning: how far b must travel along it to clear a. Face normals cover
// the outlines; a disc has no faces, so it contributes the direction to whatever
// of the other surface is nearest, which is where a curve is closest to touching.
function contactAxes(a, b) {
  const axes = []
  const toBx = b.centre.x - a.centre.x,
    toBy = b.centre.y - a.centre.y
  const add = (x, y) => {
    const len = Math.hypot(x, y)
    if (len < 1e-9) {
      return
    }
    const nx = x / len,
      ny = y / len
    const flip = toBx * nx + toBy * ny < 0
    axes.push(flip ? [-nx, -ny] : [nx, ny])
  }
  for (const shape of [a, b]) {
    for (const part of shape.parts || []) {
      for (let i = 0; i < part.length; i++) {
        const p = part[i],
          q = part[(i + 1) % part.length]
        add(-(q.y - p.y), q.x - p.x)
      }
    }
  }
  for (const [disc, other] of [
    [a, b],
    [b, a],
  ]) {
    if (!disc.radius) {
      continue
    }
    if (other.radius) {
      add(other.centre.x - disc.centre.x, other.centre.y - disc.centre.y)
    } else {
      for (const part of other.parts) {
        const near = nearestOnPart(part, disc.centre)
        add(disc.centre.x - near.point.x, disc.centre.y - near.point.y)
      }
    }
  }
  return axes
}

// One hull-against-rock contact, shared by every ship so the player and a rival
// answer it the same way. The hull is pushed clear along the contact normal, and
// the closing speed is measured against the rock's surface as it is actually
// moving, spin included: a rock that drifts or spins into a stationary hull must
// carry it away, and judging the approach by the hull's own velocity alone leaves
// it embedded, grinding its energy away every frame. The rock takes the opposite
// impulse about its own centre, so a shove off-centre spins it.
//
// Returns the impact point and the closing speed; the speed is 0 when the pair
// was already separating, which still pushes them apart but lands no knock.
export function resolveHullRockContact(ship, asteroid, contact) {
  const ux = contact.nx,
    uy = contact.ny
  // The same resting overlap every other contact tolerates, so a hull settled
  // against a rock is not shoved by a fraction of a unit every frame. Unlike a
  // rock pair this is not eased out over several frames: one hull against the
  // world has no chain of contacts to unsettle, and a ship that sinks in and
  // climbs out reads as mushy.
  const push = Math.max(0, contact.depth - CONFIG.CONTACT_SLOP)
  ship.x += ux * push
  ship.y += uy * push
  // The contact lies on the ship's own surface facing the rock, which is its
  // shield bubble while one is raised and its outline when none is. A circle
  // around the hull puts it somewhere the ship is not, which both misplaces the
  // impact effect and mismeasures the lever arm the rock is shoved on.
  const reach = ship.contactSupport(-ux, -uy)
  const impact = { x: ship.x - ux * reach, y: ship.y - uy * reach }
  const leverX = impact.x - asteroid.center.x,
    leverY = impact.y - asteroid.center.y
  const surfaceVx = asteroid.vx - asteroid.spin * leverY,
    surfaceVy = asteroid.vy + asteroid.spin * leverX
  const vn = (ship.vx - surfaceVx) * ux + (ship.vy - surfaceVy) * uy
  if (vn >= 0) {
    return { impact, closing: 0 }
  }
  const mass = rockMass(asteroid.area)
  // a rock resists a shove off its centre less the further out it lands
  const inertia = 0.5 * mass * Math.max(asteroid.boundRadius, 1) ** 2
  const lever = leverX * uy - leverY * ux
  // Inverse masses, as everywhere else a contact is solved. Writing the hull's
  // mass instead of its inverse is invisible for the player, whose mass is
  // exactly 1, and wrong for everything else.
  const share = 1 / ship.mass + 1 / mass + (lever * lever) / inertia
  const j = (-(1 + CONFIG.ROCK_RESTITUTION) * vn) / share
  ship.vx += (j * ux) / ship.mass
  ship.vy += (j * uy) / ship.mass
  asteroid.vx -= (j * ux) / mass
  asteroid.vy -= (j * uy) / mass
  asteroid.spin -= (leverX * j * uy - leverY * j * ux) / inertia
  return { impact, closing: -vn }
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
  const reach = a.contactReach() + b.contactReach()
  if (dx * dx + dy * dy >= reach * reach) {
    return 0
  }
  const contact = shapeContact(a.contactShape(), b.contactShape())
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
    this.carried = 0 // mass of everything fitted, added to the hull's own
    // What is left of the hull, as a fraction: a ship cut down to a piece of itself weighs
    // and handles as that piece. See Ship.reshape.
    this.massScale = 1
    // A raw face left by a cut that did not finish the hull, and the fire off it. Faces are
    // vertex index pairs into the outline, so they turn with the ship.
    this.burn = 0
    this.burnFaces = []
    this.burnBacklog = { fire: 0, smoke: 0 }
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

  // Every module on the body, including whatever is fitted inside a core. One
  // walk, so nothing has to remember that a shield might be in a core rather than
  // on a hardpoint of its own.
  *modules() {
    for (const hp of this.hardpoints) {
      if (!hp.module) {
        continue
      }
      yield hp.module
      if (hp.module.fitted) {
        yield* hp.module.fitted
      }
    }
  }

  shieldModule() {
    for (const module of this.modules()) {
      if (module.kind === "shield") {
        return module
      }
    }
    return null
  }

  // Has any part of this body reached inside the arena? Rocks and the player are
  // confined and so always have; a rival is outside it while flying in and again
  // while flying out, and out there it is not really in the sector.
  insideArena() {
    const dx = this.x - ARENA.cx,
      dy = this.y - ARENA.cy
    return Math.hypot(dx, dy) - this.boundRadius <= ARENA.radius
  }

  // Is this body really in the sector? A body that is not cannot be damaged, and
  // so must not stop a beam or swallow a bullet either: it is not there to be
  // shot at. Everything that fires reads this one predicate, so the two channels
  // cannot come to disagree about which bodies exist. Rocks always are.
  inPlay() {
    return true
  }

  // How far this body notices `what`, one of ships, rocks, ore or specials.
  // Everything sees as far as the sensor floor, which is a circle over what is on
  // screen, and a fitted radar set reaches past it for the kinds it covers. So a
  // hull with nothing fitted is not blind, it is just short-sighted.
  sensorRange(what) {
    let reach = CONFIG.SENSOR_FLOOR
    for (const module of this.modules()) {
      if (module.kind === "radar") {
        reach = Math.max(reach, module.reach(what))
      }
    }
    return reach
  }

  // Which side this body is on, for deciding what shoots at what. A rock is a
  // hazard, and so is the wreckage cut from a hull: whatever it was made of, once
  // it is debris it fires on the player alone.
  get faction() {
    return "hazard"
  }

  // Is a shield raised over this entity?
  shieldUp() {
    const shield = this.shieldModule()
    return !!(shield && shield.up)
  }

  // Is that shield something other bodies cannot pass through? A bubble is a wall: a
  // hull cannot be flown inside one and a rock stops against it. A field that repels
  // instead is not - it leans on what comes near it and lets a rock that pushes hard
  // enough arrive anyway - so what other bodies meet is the outline inside it.
  barrierUp() {
    const shield = this.shieldModule()
    return !!(shield && shield.up && shield.solid)
  }

  // Radius of the shield bubble. The view draws the bubble at exactly this, and
  // incoming beams are stopped by it, so what looks like the target is the target.
  // Zero means nothing is raised and the body's own outline is the surface.
  shieldRadius() {
    return 0
  }

  // How far this body's contact surface reaches from its centre, for the
  // broadphase reject every contact site does first. A raised shield stands
  // further out than the hull inside it, so it sets the reach while it is up.
  contactReach() {
    return Math.max(this.boundRadius, this.barrierUp() ? this.shieldRadius() : 0)
  }

  // The surface an incoming hit of this channel has to reach: the shield bubble
  // while one is raised against it, and zero when the body's own outline is the
  // surface. Every weapon asks this, so a shot and a beam cannot come to
  // disagree about how big a shielded body is to aim at.
  blockingRadius(channel) {
    const shield = this.shieldModule()
    const raised = shield && shield.up && shield.blocks(channel) && this.energy > 0
    return raised ? this.shieldRadius() : 0
  }

  // The body's own outline in world space, for an exact hit test against it.
  hitOutline() {
    return []
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
      this.energy = Math.max(
        0,
        this.energy - amount * shield.drainPer(channel) * this.damageResist(),
      )
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

  updateShield(dt, game) {
    if (this.fxCooldown > 0) {
      this.fxCooldown -= dt
    }
    if (game && this.updateBurn) {
      this.updateBurn(dt, game)
    }
    const shield = this.shieldModule()
    if (shield) {
      shield.tick(dt, this)
      if (game) {
        shield.repel(dt, this, game)
      }
    }
  }

  onHull() {
    /* subclasses decide what losing the hull means */
  }
}

// A turret as the view draws it: a mount ring and one barrel per barrel the gun
// carries, fanned either side of the aim. Every turret in the game goes through
// here, so a rock's, a rival's and the player's all read the same way and a
// glance at one says how fast it fires.
// Where a turret points: at the player while it can see one, and at its last
// bearing while it cannot, so a swing toward a hidden ship does not give it away.
// The bearing is remembered on the hardpoint, which is why this takes one rather
// than a bare point; `at` is where the mount actually is, since a ship stores a
// local offset and a rock stores a world position.
function trackedAim(seen, hp, at, fallback) {
  if (seen) {
    hp.aim = bearingTo(at, seen)
  }
  return hp.aim ?? fallback
}

// A gun on its mount: a nub with a barrel per shot it throws at once. `scale` draws the
// whole thing larger or smaller without changing its proportions, for a diagram of a ship
// drawn at some other size than the sector draws it at, and `glow` is worth turning off
// for one drawn faintly: half a dozen soft edges over each other read as a smudge rather
// than as a gun.
export function drawTurret(renderer, x, y, aim, barrels, colour, opts = {}) {
  const { length = 10, alpha = 1, scale = 1, glow = 8 } = opts
  renderer.circle(x, y, 3.4 * scale, { stroke: colour, width: 1.6 * scale, glow, alpha })
  const across = 2.6 * scale // barrel separation, across the line of fire
  const px = -Math.sin(aim) * across,
    py = Math.cos(aim) * across
  for (let i = 0; i < barrels; i++) {
    const offset = i - (barrels - 1) / 2
    const bx = x + px * offset,
      by = y + py * offset
    renderer.line(bx, by, bx + Math.cos(aim) * length, by + Math.sin(aim) * length, {
      color: colour,
      width: 1.6 * scale,
      glow,
      alpha,
    })
  }
}

// How far past a target a beam carries by default, so it cuts rather than grazes.
// A weapon type can name its own `overshoot` instead.
const CUT_OVERSHOOT = 20

// ---------------------------------------------------------------------------
// Weapon module. `kind` projectile or beam; `controller` decides firing.
// ---------------------------------------------------------------------------
export class Weapon {
  constructor(typeName, controller, arc) {
    this.kind = "weapon"
    this.typeName = typeName
    this.type = WEAPON_TYPES[typeName]
    this.controller = controller
    // How far off the hull's facing this gun can be brought to bear, in radians
    // either side. The mount's own limit if the loadout states one, otherwise the
    // gun's, otherwise none: a turret on a ring traverses freely, one buried in the
    // jaw of a pincer only covers what is in front of the ship.
    this.arc = arc ?? this.type.arc ?? Infinity
    this.barrels = barrelCount(this.type)
    this.cooldown = this.rollReload() * randRange(0.15, 1) // random phase so turrets don't fire in unison
    this.charge = 0
    this.overdrive = 0 // 0 to 1 across the wind-up past full charge
    this.charging = 0 // wind-up time left before a charged beam fires
    this.chargeDuration = 0
    this.resting = 0 // what a hull waits out between shots, see rollPace
  }

  // Drop a held charge, including any overdrive wound onto it.
  release() {
    this.charge = 0
    this.overdrive = 0
  }

  // How far a beam has to carry to cut a target rather than graze it: past the far
  // side of it, measured from wherever the shot starts. Stopping at the middle
  // crosses the outline once, which severs nothing. A projectile ignores the reach
  // and flies on its own speed, so this only shapes a beam.
  cutReach(target, toCentre) {
    return toCentre + target.boundRadius + (this.type.overshoot ?? CUT_OVERSHOOT)
  }

  // Can this gun be brought to bear on a world bearing, given where its host is
  // pointed? Asked by every controller that picks its own target, so a mount's arc is
  // one rule rather than one rule per behaviour.
  bearsOn(host, bearing) {
    return Math.abs(shortestTurn(host.angle, bearing)) <= this.arc
  }

  // How long before it can fire again. A gun that states no reload has none: what limits
  // it is somewhere else, which for a gun that winds up is the cell it winds up out of.
  rollReload() {
    const r = this.type.reload
    if (r === undefined) {
      return 0
    }
    return Array.isArray(r) ? randRange(r[0], r[1]) : r
  }
  // Whether the host can pay for this and still hold its bubble up afterwards. A hull
  // that empties its cell into one gun has no shield for the seconds that follow, which
  // is not a trade a ship makes with itself: `reserve` is what it keeps back, as a
  // fraction of its own cell. The player is free to make it, which is why this is asked
  // by the controllers rather than by the gun.
  affordableBy(host) {
    const cost = this.type.energy ?? 0
    return host.energy >= cost + (this.type.reserve ?? 0) * (host.energyMax || 0)
  }

  // How long a hull waits after this before it lines the next one up. Rolled, so two of
  // them in a sector do not fall into step.
  rollPace() {
    const pace = this.type.pace
    if (!pace) {
      return 0
    }
    return Array.isArray(pace) ? randRange(pace[0], pace[1]) : pace
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
        this.type,
      ),
    )
    game.burst(x, y, 4, this.type.colour, 40, 120, 0.3)
    this.cooldown = this.rollReload()
    Sound.turret()
  }

  emitBeam(game, host, ax, ay, angle, length) {
    // Paid for over the wind-up where there is one, so the shot itself is free.
    if (!this.type.chargeTime && !host.spendEnergy(this.type.energy)) {
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
      // What the shot does to the space along it, for the view to bend: an alien beam
      // cuts by warping what it crosses rather than by burning it.
      warp: this.type.warp,
    })
    this.cooldown = this.rollReload()
    Sound[this.type.sound || "fire"]()
  }

  // Fire from a hardpoint along a bearing, whichever kind this weapon is, so a
  // controller can decide when and where without also deciding with what.
  // `reach` is how far a beam should carry; a projectile has its own speed and
  // life and ignores it.
  fire(game, host, x, y, aim, reach) {
    if (this.type.kind === "beam") {
      this.emitBeam(game, host, x, y, aim, reach)
    } else if (this.type.kind === "well") {
      this.launchWell(game, host, x, y, aim)
    } else {
      this.fireProjectile(game, x, y, aim, host)
    }
  }

  // Let go of a singularity. It carries the gun that made it, so how deep it reaches and
  // what it does there is the gun's business, and it remembers who fired it: a well
  // spares its owner while the owner lives.
  launchWell(game, host, x, y, aim) {
    // Paid for over the wind-up where there is one, so the shot itself is free.
    if (!this.type.chargeTime && !host.spendEnergy(this.type.energy)) {
      this.cooldown = 0.4
      return
    }
    game.projectiles.push(
      new Singularity(
        x,
        y,
        Math.cos(aim) * this.type.speed,
        Math.sin(aim) * this.type.speed,
        this.type.damage,
        host,
        this.type,
      ),
    )
    game.burst(x, y, 20, PALETTE.alien.beam, 30, 160, 0.7)
    game.ring(x, y, 16, PALETTE.alien.shotCore, 240, 0.5)
    game.screenShake = Math.max(game.screenShake, 8)
    Sound.explode()
    this.cooldown = this.rollReload()
  }

  // Winding one up: while the charge runs, the muzzle draws in what is loose around it.
  // Particles and other people's shots, never rock, because a sector heaving toward a
  // point is mayhem and the contact solver would not survive it. Vanity particles are
  // spawned out at the edge so there is always something falling in.
  // A wind-up is paid for as it runs rather than at the shot: what it costs is the gun's
  // `energy`, spread over its `chargeTime`, so a hull that cannot keep it up loses what it
  // has spent and the shot with it. Returns false when the cell has run dry.
  windUp(dt, host) {
    const seconds = this.type.chargeTime
    if (!seconds || !this.type.energy) {
      return true
    }
    return host.spendEnergy((this.type.energy * dt) / seconds)
  }

  // A wind-up let go of before it was ready. Nothing is fired: it comes apart where it
  // was being held, at whatever it had become.
  evaporate(game, world) {
    const progress = this.chargeDuration > 0 ? 1 - this.charging / this.chargeDuration : 0
    if (progress <= 0.05) {
      return
    }
    const colour = this.type.colour || PALETTE.alien.beam
    game.burst(world.x, world.y, Math.round(6 + 26 * progress), colour, 20, 120 * progress, 0.5)
    game.ring(world.x, world.y, Math.round(6 + 10 * progress), colour, 120 * progress, 0.35)
    this.cooldown = Math.max(this.cooldown, this.rollReload() * 0.5)
    Sound.hit()
  }

  // What a wind-up looks like where it is happening. A gun that throws a well grows one
  // at the muzzle as it goes, a dark middle inside a ring, so what is about to be let go
  // of is the thing itself rather than a glow standing in for it.
  drawWindUp(renderer, world, aim) {
    if ((this.charging <= 0 && !this.wound) || this.chargeDuration <= 0) {
      return
    }
    const prog = this.wound ? 1 : clamp(1 - this.charging / this.chargeDuration, 0, 1)
    const colour = this.type.colour
    if (this.type.well) {
      const reach = 3 + prog * (this.type.well.radius ?? 40) * 0.3
      renderer.circle(world.x, world.y, reach, { fill: PALETTE.alien.void, alpha: 0.85 })
      renderer.circle(world.x, world.y, reach, {
        stroke: colour,
        width: 1.2 + prog * 1.8,
        glow: 8 + prog * 26,
        alpha: 0.45 + 0.55 * prog,
      })
      return
    }
    renderer.circle(world.x, world.y, 2 + prog * 9, {
      fill: colour,
      glow: 10 + prog * 24,
      alpha: 0.35 + 0.55 * prog,
    })
    const along = 24 + prog * 40
    renderer.line(
      world.x,
      world.y,
      world.x + Math.cos(aim) * along,
      world.y + Math.sin(aim) * along,
      {
        color: colour,
        width: 1 + prog * 2.5,
        glow: 12,
        alpha: 0.3 + 0.5 * prog,
      },
    )
  }

  generate(dt, game, host, world) {
    const spec = this.type.generate
    if (!spec) {
      return
    }
    const progress = this.chargeDuration > 0 ? 1 - this.charging / this.chargeDuration : 1
    const pull = spec.pull * (0.3 + 0.7 * progress)
    game.drawInParticles(world, spec.radius, pull, dt)
    game.applyRadialForce({
      centre: world,
      radius: spec.radius,
      include: ["projectiles"],
      visit: (shot, { dir, falloff }) => {
        // Loose shot, and not a well that is already out there. Wells pull each other,
        // which is worth watching; a gun winding up a new one towing the last one about
        // is not the same thing, and it is what sent a single well out on its own the
        // moment the ship that threw it flew past it.
        if (shot.type && shot.type.well) {
          return
        }
        shot.vx -= dir.x * pull * falloff * dt
        shot.vy -= dir.y * pull * falloff * dt
      },
    })
    // Something to watch: motes appearing at the edge and falling toward the muzzle.
    this.spinBacklog = (this.spinBacklog ?? 0) + spec.motes * dt
    while (this.spinBacklog >= 1) {
      this.spinBacklog -= 1
      const angle = Math.random() * TAU
      const away = spec.radius * randRange(0.55, 1)
      game.emit(
        world.x + Math.cos(angle) * away,
        world.y + Math.sin(angle) * away,
        -Math.cos(angle) * pull * 0.35,
        -Math.sin(angle) * pull * 0.35,
        0.5,
        PALETTE.alien.beam,
      )
    }
  }

  update(dt, game, host, world) {
    this.tick(dt)
    // A host outside the arena holds fire, for the same reason it cannot be shot
    // out there: it is on its way in or on its way out and not yet part of the
    // fight. Rocks and the player are confined, so this only gates a rival.
    if (!this.ready || !game.canFly() || host.leaving || !host.insideArena()) {
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
export const WEAPON_CONTROLLERS = {
  // driven directly by player input, see PlayerShip.fireLaser
  manual() {},

  // leads nothing: fires straight at whatever the host is hostile to
  turret(weapon, dt, game, host, world) {
    const found = game.hostileTarget(host, world)
    // don't snipe from off-screen, where the target cannot see the shooter
    if (!found || !game.onScreen(host.x, host.y, CONFIG.OFFSCREEN_FIRE_MARGIN)) {
      return
    }
    const aim = bearingTo(world, found.target)
    if (!weapon.bearsOn(host, aim)) {
      return // outside what this mount covers, so the hull has to come round
    }
    const reach = weapon.cutReach(found.target, found.distance)
    weapon.fire(game, host, world.x, world.y, aim, reach)
  },

  // cuts rocks for ore, firing along the host's facing when one is near
  miner(weapon, dt, game, host, world) {
    // No trigger range means it never fires, which is what a missing one always did.
    if (game.nearestAsteroid(host, weapon.type.triggerRange ?? 0)) {
      weapon.emitBeam(game, host, world.x, world.y, host.angle, weapon.rollLength())
    }
  },

  // heavy cannon: winds up with a growing glow (drawn by drawShip) and, once
  // committed, fires even if the player slips away, so the shot is telegraphed
  hunter(weapon, dt, game, host, world) {
    if (weapon.resting > 0) {
      weapon.resting -= dt
    }
    const found = game.hostileTarget(host)
    if (!found) {
      return
    }
    if (weapon.charging > 0) {
      if (!weapon.windUp(dt, host)) {
        weapon.charging = 0 // the cell gave out, and what was spent is spent
        return
      }
      weapon.charging -= dt
      // A gun that generates rather than charges spends the wind-up drawing things in,
      // which is the telegraph: the same clock, doing something visible with it.
      weapon.generate(dt, game, host, world)
      if (weapon.charging <= 0) {
        weapon.charging = 0
        weapon.fire(game, host, world.x, world.y, host.angle, weapon.type.length)
        weapon.resting = weapon.rollPace()
      }
      return
    }
    // Not while it is between shots, and not if paying for this one would leave it
    // flying about with no bubble: a hull that manages its own cell is a harder thing to
    // fight than one that empties it into the first shot it can line up.
    if (weapon.resting > 0 || !weapon.affordableBy(host)) {
      return
    }
    if (
      weapon.bearsOn(host, bearingTo(host, found.target)) &&
      found.distance < weapon.type.length &&
      game.onScreen(host.x, host.y, CONFIG.OFFSCREEN_FIRE_MARGIN)
    ) {
      weapon.charging = weapon.type.chargeTime || 0.8
      weapon.chargeDuration = weapon.charging
      Sound.charge(weapon.chargeDuration)
    }
  },

  // The player's nose turret, firing from its hardpoint. Arrow keys aim
  // host.turretAim and fire on demand; with no input it auto-targets the nearest
  // hostile hull in range. Rocks are the main laser's business: a bare rock has no
  // hull to lose and is destroyed by being cut, so a turret spent on one achieves
  // nothing while pointing away from what does.
  defense(weapon, dt, game, host, world) {
    if (host.turretManual > 0) {
      if (host.turretFiring) {
        weapon.fire(game, host, world.x, world.y, host.turretAim, weapon.type.range)
      }
      return
    }
    // Auto-targeting shoots at things that cannot see the ship, which would give
    // it away. Under the player's own hand it still fires, since that is a choice.
    if (host.buffField("invisible", false)) {
      return
    }
    const found = game.hostileTarget(host, world, weapon.type.range)
    if (found && weapon.bearsOn(host, bearingTo(world, found.target))) {
      host.turretAim = bearingTo(world, found.target)
      const reach = weapon.cutReach(found.target, found.distance)
      weapon.fire(game, host, world.x, world.y, host.turretAim, reach)
    }
  },
}

// One module from a loadout entry, whichever kind it names. Shared so a hardpoint
// and a core build the same thing from the same description.
export function moduleFor(entry) {
  if (entry.weapon) {
    return new Weapon(entry.weapon, entry.controller, entry.arc)
  }
  if (entry.shield) {
    return new Shield(entry.shield)
  }
  if (entry.engine) {
    return new Engine(entry.engine)
  }
  if (entry.radar) {
    return new Radar(entry.radar)
  }
  if (entry.thruster) {
    return new Thruster(entry.thruster)
  }
  return null
}

// ---------------------------------------------------------------------------
// Maneuvering thruster module: the nozzles that bring a hull about. It does
// nothing on its own; what it puts out is read where the turn rate is worked out,
// which is why a hull with none cannot steer.
// ---------------------------------------------------------------------------
export class Thruster {
  constructor(typeName) {
    this.kind = "thruster"
    this.typeName = typeName
    this.type = THRUSTER_TYPES[typeName]
  }
}

// ---------------------------------------------------------------------------
// Core module: the cell the hull runs on, and the room it has for what runs off
// it. Energy is the core's own rather than one of its slots, so a hull that has a
// core can always power itself.
//
// `fitted` is a slot name to the equipment in it. A slot the core has no room for
// is refused rather than silently overfilled.
// ---------------------------------------------------------------------------
export class Core {
  constructor(typeName, fitted = {}) {
    this.kind = "core"
    this.typeName = typeName
    this.type = CORE_TYPES[typeName]
    this.fitted = []
    for (const [slot, name] of Object.entries(fitted)) {
      this.equip(slot, { [slot]: name })
    }
  }

  // How many of `slot` are already in, against how many the core will take.
  #countIn(slot) {
    return this.fitted.filter((module) => module.slot === slot).length
  }

  // Take whatever is in `slot` out. Returns whether anything was there.
  remove(slot) {
    const before = this.fitted.length
    this.fitted = this.fitted.filter((module) => module.slot !== slot)
    return this.fitted.length !== before
  }

  // Fit `entry` into `slot`, replacing what is there when the core has no room for
  // a second. Returns whether anything changed, so a repeat purchase is a no-op.
  equip(slot, entry) {
    const room = this.type[slot] ?? 0
    if (room <= 0) {
      return false
    }
    const module = moduleFor(entry)
    if (!module) {
      return false
    }
    module.slot = slot
    const already = this.fitted.find((m) => m.slot === slot && m.typeName === module.typeName)
    if (already) {
      return false
    }
    if (this.#countIn(slot) >= room) {
      this.fitted = this.fitted.filter((m) => m.slot !== slot)
    }
    this.fitted.push(module)
    return true
  }
}

// ---------------------------------------------------------------------------
// Radar module: what its host knows about, and how far off. It does nothing on
// its own; everything that looks for something asks the host, and the host asks
// whatever set is fitted.
// ---------------------------------------------------------------------------
export class Radar {
  constructor(typeName) {
    this.kind = "radar"
    this.typeName = typeName
    this.type = RADAR_TYPES[typeName]
  }

  reach(what) {
    return this.type.sees[what] ?? 0
  }
}

// ---------------------------------------------------------------------------
// Engine module: what pushes the hull along, and the plume that says so. Each
// keeps its own backlog, so two engines cycle independently instead of flickering
// between one stream and the other.
// ---------------------------------------------------------------------------
export class Engine {
  constructor(typeName) {
    this.kind = "engine"
    this.typeName = typeName
    this.type = ENGINE_TYPES[typeName]
    this.backlog = 0 // fractional plumes carried between frames
  }

  // Throw plumes back from `world` along the bearing `back`, at this engine's own
  // rate, counted through the backlog so it does not vary with the frame rate.
  //
  // `width` spreads where a plume starts, across the nozzle rather than out of a
  // point, so a wide throat reads as a plume that is already broad where it leaves
  // the hull. `spread` scatters where it goes. A nozzle of no width is a point
  // emitter, which is what a plume that only states `spread` gets.
  emit(dt, game, world, back) {
    const plume = this.type.plume
    this.backlog += plume.rate * dt
    const bx = Math.cos(back),
      by = Math.sin(back)
    const acrossX = -by,
      acrossY = bx
    while (this.backlog >= 1) {
      this.backlog -= 1
      const spread = plume.spread ?? 20
      const off = plume.width ? randRange(-plume.width / 2, plume.width / 2) : 0
      game.emit(
        world.x + acrossX * off,
        world.y + acrossY * off,
        bx * plume.speed + randRange(-spread, spread),
        by * plume.speed + randRange(-spread, spread),
        plume.life,
        this.type.colour,
      )
    }
  }

  // The fire at the throat, drawn back along `back` from `world`. It is the engine's
  // own rather than the hull's, so every drive burns its own way and a hull with two
  // of them burns twice.
  drawFlame(renderer, world, back, alpha = 1) {
    const flame = this.type.flame
    if (!flame) {
      return
    }
    const reach = flame.length + Math.random() * flame.flicker
    const half = (flame.width ?? this.type.plume.width ?? 0) / 2
    const bx = Math.cos(back),
      by = Math.sin(back)
    const acrossX = -by,
      acrossY = bx
    const paint = {
      color: flame.colour ?? this.type.colour,
      width: 1.4,
      glow: 10,
      alpha,
    }
    if (!flame.round) {
      // A hard V: two edges meeting at the tip, open across the throat.
      renderer.strokePoly(
        [
          { x: world.x + acrossX * half, y: world.y + acrossY * half },
          { x: world.x + bx * reach, y: world.y + by * reach },
          { x: world.x - acrossX * half, y: world.y - acrossY * half },
        ],
        { ...paint, closed: false },
      )
      return
    }
    // A teardrop: the throat bulges round into the hull and the fire draws out to a point.
    // Sampled from one lip, back around the bulge, to the other, and closed through the tip.
    const points = []
    const steps = 8
    for (let i = 0; i <= steps; i++) {
      const angle = Math.PI / 2 - (i / steps) * Math.PI
      const outward = -Math.cos(angle) * half * 0.55
      const across = Math.sin(angle) * half
      points.push({
        x: world.x + bx * outward + acrossX * across,
        y: world.y + by * outward + acrossY * across,
      })
    }
    points.push({ x: world.x + bx * reach, y: world.y + by * reach })
    renderer.strokePoly(points, { ...paint, closed: true })
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
    return this.type.blocks.includes(channel)
  }

  // Whether the bubble is a wall other bodies stop against. Everything is unless it
  // says otherwise, since that is what a shield was before any of them repelled.
  get solid() {
    return this.type.solid !== false
  }

  // Energy drained per point of damage on this channel. One number covers every
  // channel the shield blocks; a bubble braced against one kind of fire states them
  // separately, and anything it blocks without pricing costs a point for a point.
  drainPer(channel) {
    const efficiency = this.type.efficiency
    return typeof efficiency === "number" ? efficiency : (efficiency[channel] ?? 1)
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
  // Lean on the rock and the loose shot around the host, and pay for it. `repel` is
  // the field's: `force` is what it pushes with at the host's own surface, dying away
  // to nothing at the edge of the bubble, and `energyPerPush` what a unit of momentum
  // turned away costs.
  //
  // The cost follows what is actually being held off, so a hull in open space runs the
  // field for almost nothing and one backed into a rock field bleeds: burying it in
  // debris is a way to strip it. A push is a force rather than an acceleration, so a
  // boulder is moved less than a pebble and costs the same to shift, which is what
  // "how much was repelled" means.
  //
  // Rocks and shots only. A hull is not pushed, so ramming one still works and the
  // pincer's mouth stays as dangerous as it looks.
  repel(dt, host, game) {
    const spec = this.type.repel
    if (!spec || !this.up || host.energy <= 0) {
      return
    }
    const radius = host.shieldRadius()
    if (!(radius > 0)) {
      return
    }
    let spent = 0
    // A force per kind of thing, because the intent differs: a boulder is leant on, a
    // round has to be turned aside before it arrives, and a hull is held off without
    // being made unable to close at all. Cost is the momentum turned away whichever it
    // is, so the round that takes the most force to deflect is also the one that costs
    // the most to deflect.
    for (const [include, force] of Object.entries(spec.force)) {
      game.applyRadialForce({
        centre: host,
        radius,
        include: [include],
        toSurface: true,
        skip: host,
        visit: (body, { dir, falloff }) => {
          // Not its own fire. Every gun on the hull sits inside the field, so a field that
          // turned away what it launched would fling every shot out sideways and hold the
          // ship's own well at arm's length.
          if (body.owner === host) {
            return
          }
          // Its own side's fire it simply bounces, and pays nothing for: a field knows the
          // ordnance it was built alongside, so a sector with three aliens in it is never a
          // sector where they shoot each other. Anything else it has to push against, which
          // is what the force and the cost below are for.
          if (body.owner && body.owner.faction === host.faction) {
            const inward = -(body.vx * dir.x + body.vy * dir.y)
            if (inward > 0) {
              body.vx += 2 * inward * dir.x
              body.vy += 2 * inward * dir.y
            }
            return
          }
          const push = force * falloff * dt
          const mass = body.mass ?? 1
          body.vx += (dir.x * push) / mass
          body.vy += (dir.y * push) / mass
          spent += push
        },
      })
    }
    if (spent > 0) {
      host.energy = Math.max(0, host.energy - spent * spec.energyPerPush)
      this.checkOverload(host)
    }
  }

  tick(dt, host) {
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt)
    }
    if (this.up) {
      // Whatever emptied the cell, not only a hit that emptied it. A bubble was checked
      // when it was shot at and when it shoved something, so a hull that spent its cell
      // on a gun instead kept a bubble it could not pay for: drawn, and paying nothing,
      // while every hit went through to the hull.
      this.checkOverload(host)
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

  // `fade` dims the whole bubble, for a host that is drawing itself faint.
  draw(renderer, cx, cy, radius, fraction, time, fade = 1) {
    // A pulse that never fades to invisible, with brightness tracking energy. Rate,
    // depth and which way the shape turns are the type's, so a bubble that is switched
    // on and a field that is being held there do not read the same: the alien one turns
    // against everything else and breathes twice as fast.
    const depth = this.type.pulseDepth ?? 0.12
    const pulse = 1 - depth + depth * Math.sin(time * (this.type.pulseRate ?? 1.8))
    const alpha = clamp((0.24 + 0.4 * fraction) * pulse, 0.2, 0.75) * fade
    const rotation = time * (this.type.spin ?? 0.3),
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
        alpha: clamp(0.9 * f, 0, 1) * fade,
        closed: false,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Projectile: damages every entity except its owner (friendly fire).
// ---------------------------------------------------------------------------
export class Projectile extends Entity {
  constructor(x, y, vx, vy, damage, owner, type = null) {
    super(x, y)
    this.vx = vx
    this.vy = vy
    this.damage = damage
    this.owner = owner
    // The gun that fired it, so a round is drawn the way that gun's rounds look
    // rather than the way every round in the game used to look.
    this.type = type
    // A round lives as long as any round unless its gun says otherwise, which is how a
    // well hangs about long enough to be a place to avoid rather than a thing to duck.
    this.life = (type && type.life) || CONFIG.BULLET_LIFE
    this.age = 0
  }

  update(dt, game) {
    this.life -= dt
    this.age += dt
    this.steer(dt, game)
    this.integrate(dt)
    if (
      this.life <= 0 ||
      Math.hypot(this.x - ARENA.cx, this.y - ARENA.cy) > ARENA.radius + CONFIG.BULLET_ESCAPE_MARGIN
    ) {
      this.#expire(game)
      return
    }
    // The player is hit against its outline, as every other ship is: a circle
    // of `radius` is twice the hull's area and still leaves the nose outside it.
    const player = game.player
    if (player && this.owner !== player && player.inPlay() && this.#reaches(player)) {
      this.#strike(game, player, PALETTE.weapon.bulletImpact, 8)
      return
    }
    for (const rival of game.rivals) {
      if (rival === this.owner || !rival.inPlay() || !this.#reaches(rival)) {
        continue
      }
      this.#strike(game, rival, PALETTE.rival.hull, 6)
      return
    }
    for (const asteroid of game.asteroids) {
      if (asteroid === this.owner || !this.#reaches(asteroid)) {
        continue
      }
      this.#strike(game, asteroid, PALETTE.rock.impact, 5)
      return
    }
  }

  // What a round is worth where it lands. `impact` is the gun's: how much comes off it,
  // how hard the screen moves and whether the ring goes with it. A gun that says nothing
  // gets what every gun always got, which is a handful of sparks in the struck body's
  // own colour and a shake only the player feels.
  //
  // One place for it, because a shot dies in four and the loud ones have to be loud
  // wherever that happens.
  #strike(game, body, colour, sparks) {
    this.dead = true
    const impact = (this.type && this.type.impact) || null
    const at = { x: this.x, y: this.y }
    const hitPlayer = body === game.player
    if (impact) {
      const [slow, fast] = impact.speed
      game.burst(at.x, at.y, impact.particles, impact.colour, slow, fast, 0.6)
      if (impact.ring) {
        game.ring(at.x, at.y, impact.ring.count, impact.colour, impact.ring.speed, 0.5)
      }
      // The shake is what the shot weighs, and it is the player's screen: a round
      // landing on something else across the sector does not move it.
      if (hitPlayer && impact.shake) {
        game.screenShake = Math.max(game.screenShake, impact.shake)
      }
      // A hit that should feel like it reached out of the game tears the picture where
      // it landed. Only on the player: nothing else has a screen to break.
      if (hitPlayer && impact.glitch) {
        const tear = impact.glitch
        game.glitchAt(at.x, at.y, tear.strength, tear.radius, tear.seconds)
      }
    } else {
      game.burst(at.x, at.y, sparks, colour, 40, 140, 0.4)
      if (hitPlayer) {
        game.screenShake = Math.max(game.screenShake, 5)
      }
    }
    if (hitPlayer) {
      Sound.hit()
    }
    body.takeDamage(this.damage, game, "projectile", 0, at)
  }

  // Run out of life, or left the arena. A round that says how it lands comes apart the
  // same way here: an orb that has failed to reach anything still goes off, rather than
  // winking out of existence.
  #expire(game) {
    this.dead = true
    const impact = this.type && this.type.impact
    if (impact) {
      const [slow, fast] = impact.speed
      game.burst(
        this.x,
        this.y,
        Math.round(impact.particles * 0.6),
        impact.colour,
        slow * 0.7,
        fast * 0.7,
        0.5,
      )
    }
  }

  // Has the shot reached the body? A raised shield is struck on the bubble the
  // view draws, exactly as a beam is; without one the answer comes from the
  // outline, since a circle around a hull covers the empty space beside it and
  // still leaves the nose outside. A bounding-circle reject comes first, so the
  // exact test only costs anything on a near miss.
  #reaches(body) {
    const bubble = body.blockingRadius("projectile")
    if (bubble > 0) {
      return this.#withinRadius(body.x, body.y, bubble)
    }
    return (
      this.#withinRadius(body.x, body.y, body.boundRadius) &&
      pointInPolygon(this, body.hitOutline())
    )
  }

  #withinRadius(cx, cy, radius) {
    const dx = this.x - cx,
      dy = this.y - cy
    return dx * dx + dy * dy <= radius * radius
  }

  // A shot that leans toward what it was fired at. `homing` is the gun's: `turn` is
  // how many radians a second it can bend its course by and `reach` how far it looks.
  // Not private, because a well is a shot that leans as well.
  // Speed is untouched, so it curves rather than accelerating, and a slow one can
  // still be flown around, which is the whole point of a slow one.
  //
  // It hunts through the faction table, like everything else that picks a target, and
  // asks on behalf of whoever fired it. With that host gone it stops steering: a ball
  // with nothing behind it carries on as it was going.
  steer(dt, game) {
    const homing = this.type && this.type.homing
    if (!homing || !this.owner || this.owner.dead) {
      return
    }
    const found = game.hostileTarget(this.owner, this, homing.reach)
    if (!found) {
      return
    }
    const speed = Math.hypot(this.vx, this.vy)
    if (speed < 1) {
      return
    }
    const turn = clamp(
      shortestTurn(Math.atan2(this.vy, this.vx), bearingTo(this, found.target)),
      -homing.turn * dt,
      homing.turn * dt,
    )
    const heading = Math.atan2(this.vy, this.vx) + turn
    this.vx = Math.cos(heading) * speed
    this.vy = Math.sin(heading) * speed
  }

  // A round looks like whatever fired it. Without a `shot` spec it is the streak
  // every gun in the game drew before guns had a say: a short smear back along its
  // own travel. With one it can be a ball instead, breathing as it goes, which is
  // what the aliens throw.
  draw(renderer) {
    const colour = (this.type && this.type.colour) || PALETTE.weapon.gun
    const shot = this.type && this.type.shot
    if (!shot) {
      renderer.line(this.x, this.y, this.x - this.vx * 0.02, this.y - this.vy * 0.02, {
        color: colour,
        width: 2,
        glow: 10,
        cap: "round",
      })
      return
    }
    if (shot.streak) {
      renderer.line(
        this.x,
        this.y,
        this.x - this.vx * shot.streak,
        this.y - this.vy * shot.streak,
        {
          color: colour,
          width: 2,
          glow: 10,
          cap: "round",
        },
      )
    }
    if (!shot.radius) {
      return
    }
    const breath = shot.pulse ? 1 + 0.18 * Math.sin(this.age * shot.pulse) : 1
    renderer.circle(this.x, this.y, shot.radius * breath, {
      stroke: colour,
      width: 1.6,
      glow: 18,
    })
    renderer.circle(this.x, this.y, shot.radius * 0.35, {
      fill: shot.core || PALETTE.alien.shotCore,
      glow: 12,
    })
  }
}

// ---------------------------------------------------------------------------
// Ship base: an oriented hull outline hosting hardpoint modules.
// ---------------------------------------------------------------------------
export class Ship extends Entity {
  constructor(x, y) {
    super(x, y)
    this.outlineLocal = []
    this.boundRadius = 0
    this.colour = PALETTE.white
    this.slamCooldown = 0 // one impact charged per collision, not one per frame
  }

  // What a frame of rock contact costs a hull: a steady grind for as long as the
  // contact lasts, plus a knock scaled to how hard it landed. Contact is a frame
  // or two now that the bounce works, so without the second term a full-speed ram
  // would cost the same as brushing past.
  //
  // Shared, so every hull is charged the same way for the same contact.
  // `rockContact` on the type scales it: a hull that shoulders rocks aside for a
  // living is not in the same weight class as one that should be avoiding them.
  chargeRockContact(dt, game, closingSpeed, impact) {
    const scale = this.rockContact ?? this.type.rockContact ?? 1
    if (scale <= 0) {
      return
    }
    const grind = CONFIG.DMG_AST_GUN * dt * CONFIG.ROCK_GRIND_DAMAGE
    let slam = 0
    if (closingSpeed > 0 && this.slamCooldown <= 0) {
      slam = closingSpeed * CONFIG.ROCK_IMPACT_DAMAGE
      this.slamCooldown = CONFIG.ROCK_IMPACT_COOLDOWN
    }
    this.takeDamage((grind + slam) * scale, game, "projectile", 0, impact)
  }

  // Set the hull outline, the bounding circle broadphase tests use, and the
  // convex parts contacts are solved against. Every hull here is concave (the
  // player and the scout are darts with a notched tail, the frigate has a
  // waist), so the outline is partitioned into convex parts that tile it
  // exactly. Contacts then match the hull that is drawn, at any angle.
  setOutline(outline) {
    this.outlineLocal = outline
    let furthest = 0
    for (const p of outline) {
      furthest = Math.max(furthest, Math.hypot(p[0], p[1]))
    }
    this.boundRadius = furthest
    this.collisionParts = convexPartition(outline.map(([x, y]) => ({ x, y })))
  }

  // The hull in world space as convex parts, for bodyContact.
  collisionOutline() {
    const world = this.worldOutline()
    return this.collisionParts.map((part) => part.map((i) => world[i]))
  }

  // What other bodies touch: the bubble while one stands in the way, the outline
  // when none does. The outline is not built while it is not the surface.
  contactShape() {
    const bubble = this.barrierUp() ? this.shieldRadius() : 0
    return bubble > 0
      ? { centre: this, radius: bubble }
      : { centre: this, parts: this.collisionOutline() }
  }

  // How far that surface reaches from the centre in a direction, for placing an
  // impact on it.
  contactSupport(ux, uy) {
    const bubble = this.barrierUp() ? this.shieldRadius() : 0
    return bubble > 0 ? bubble : supportDistance(this.worldOutline(), this, ux, uy)
  }

  // Mass for collision response, in the same units as a rock's: the bare hull plus
  // everything fitted to it, so a laden ship shoulders a rock aside the way its
  // weight says it should.
  get mass() {
    return (this.type.mass ?? 1) * this.massScale + this.carried
  }

  // Take a cut without coming apart: what is left of the hull becomes its outline. The
  // piece is handed over in world space, since that is where a beam cut it, and comes back
  // into the hull's own space here.
  //
  // What it weighs and what it has left to lose both follow the material it lost, so a
  // grazed slab is lighter, quicker to come about, and closer to being finished. Anything
  // that was mounted on the part that came off goes with it: a gun on a severed corner is
  // on the corner.
  reshape(worldPart, removedParts = [], cut = null) {
    const areaOf = (outline) => polygonArea(outline.map(([x, y]) => ({ x, y })))
    const before = areaOf(this.outlineLocal)
    // Mounts are placed against the hull, and some sit a little outside it on purpose: a
    // frigate's nozzles hang off the tail so the pair sweeps it round. So what a mount goes
    // with is the piece it is nearest to, not the piece that happens to contain it, which
    // took a hull's engines off it wherever the cut landed.
    const going = []
    for (const hp of this.hardpoints) {
      if (!hp.module) {
        continue
      }
      const at = this.mountWorld(hp.local)
      const keptGap = distanceToPolygon(at, worldPart)
      const lost = removedParts.some((part) => distanceToPolygon(at, part) < keptGap)
      if (lost) {
        going.push(hp)
      }
    }

    const cos = Math.cos(-this.angle),
      sin = Math.sin(-this.angle)
    const local = worldPart.map((p) => {
      const dx = p.x - this.x,
        dy = p.y - this.y
      return [dx * cos - dy * sin, dx * sin + dy * cos]
    })
    this.setOutline(local)
    const kept = before > 0 ? clamp(areaOf(local) / before, 0.05, 1) : 1
    this.hull = Math.max(1, Math.round(this.hull * kept))
    this.massScale *= kept
    for (const hp of going) {
      hp.module = null
    }
    // The edge the beam left is raw, and burns if the hull is made of something that
    // burns: the same face, the same fire and the same cooling as the piece that came off.
    const spec = this.burnSpec
    if (cut && spec) {
      const lit = facesOnLine(this.worldOutline(), cut.point, cut.normal)
      if (lit.length) {
        this.burnFaces = lit
        this.burn = spec.seconds
      }
    }
    this.refreshFitting()
    return kept
  }

  // What the hull is made of, when it is made of anything that burns.
  get burnSpec() {
    return (this.type.debrisMaterial && this.type.debrisMaterial.burn) || null
  }

  // How hot the cut faces still are, 1 just after the cut down to 0 when out.
  get heat() {
    const spec = this.burnSpec
    return spec && this.burn > 0 ? this.burn / spec.seconds : 0
  }

  // Fire off whatever the last cut left raw. Ticked wherever the shield is, so a hull that
  // is still flying is still smoking.
  updateBurn(dt, game) {
    if (this.burn <= 0) {
      return
    }
    this.burn = Math.max(0, this.burn - dt)
    this.burnBacklog = emitBurn(
      game,
      this,
      this.worldOutline(),
      this.burnFaces,
      this.burnSpec,
      this.heat,
      this.burnBacklog,
      dt,
    )
  }

  // Exhaust, from every nozzle the hull has: each engine throws its own at its own
  // rate, so a hull with a pair of them leaves two streams and one with a wide throat
  // leaves a broad one. The flame at the throat is drawn from the same mounts.
  thrustPlume(dt, game) {
    const back = this.angle + Math.PI
    for (const hp of this.hardpoints) {
      if (hp.module && hp.module.kind === "engine") {
        hp.module.emit(dt, game, this.mountWorld(hp.local), back)
      }
    }
  }

  // What is fitted, and what the hull does with it. One method for every ship, so a
  // rival that turned up carrying an extra gun and a player who has just bought one
  // are worked out the same way, through the relationships in flightStats. Called
  // whenever what is aboard changes.
  refreshFitting() {
    let thrust = 0
    let torque = 0
    let carried = 0
    for (const module of this.modules()) {
      carried += module.type.mass ?? 0
      if (module.kind === "engine") {
        thrust += module.type.thrust
      }
      if (module.kind === "thruster") {
        torque += module.type.torque
      }
    }
    this.carried = carried // before the mass getter is asked, since it reads this
    Object.assign(
      this,
      flightStats({
        mass: this.mass,
        reach: this.boundRadius,
        thrust,
        torque,
        handling: this.type.handling ?? 1,
        // Rock contact is priced off the hull it has to protect and the speed it can
        // arrive at, both of which a refit can move.
        hull: this.hull ?? this.type.hull ?? 0,
        stated: this.type.flightOverrides ?? {},
      }),
    )
  }

  // What the fitted engines manage backwards, as a fraction of their thrust. The
  // best of them answers, so refitting one nozzle is enough to back a hull up.
  driveReverse() {
    let most = 0
    for (const module of this.modules()) {
      if (module.kind === "engine") {
        most = Math.max(most, module.type.reverseAmount ?? 0)
      }
    }
    return most
  }

  // A hull flies for whichever side its type names, and for the rivals without
  // one, so a new type is still a shape and three numbers.
  get faction() {
    return this.type.faction ?? "rival"
  }

  // Whether an unshielded hull comes apart when a beam passes through it, as a
  // rock does. True for anything the sector can throw at you; how big the pieces
  // are is the material's business, not this flag's.
  get severable() {
    return true
  }

  // The bubble sits clear of the hull by the type's own margin, so a long ship
  // does not wear a shield that clips through it. In world units, as the outline is.
  // A bubble sits where the shape says, a little clear of the hull. A field that leans
  // on what comes near it needs room to lean in, so a shield may stand further off by
  // saying so: without the standoff the pincer's field reached 30 units past a hull
  // that reaches 92, and a rock was inside the outline before the field had touched it.
  shieldRadius() {
    const shield = this.shieldModule()
    const base = this.type.bubbleRadius ?? this.boundRadius * 1.33
    return base * ((shield && shield.type.standoff) || 1)
  }

  buildHardpoints(list) {
    this.hardpoints = list.map((hp) => ({ local: hp.local, role: hp.role, module: null }))
  }

  // What the guns on this hull are drawn in. Whose they are, rather than what they are:
  // a hull ringed with guns should read as its faction's from across the sector.
  get turretColour() {
    if (this.type && this.type.faction === "alien") {
      return PALETTE.alien.turret
    }
    return this.type && this.type.faction === "player" ? PALETTE.player.turret : PALETTE.weapon.gun
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
      if (entry.core) {
        hp.module = new Core(entry.core, entry.fitted)
      } else if (entry.slot) {
        // Equipment bound for a core rather than for the hardpoint itself.
        const core = hp.module
        if (core && core.kind === "core") {
          core.equip(entry.slot, entry)
        }
      } else {
        hp.module = moduleFor(entry) ?? hp.module
      }
    }
  }

  worldOutline() {
    const c = Math.cos(this.angle),
      s = Math.sin(this.angle)
    return this.outlineLocal.map((p) => ({
      x: this.x + (p[0] * c - p[1] * s),
      y: this.y + (p[0] * s + p[1] * c),
    }))
  }

  hitOutline() {
    return this.worldOutline()
  }

  mountWorld(local) {
    const c = Math.cos(this.angle),
      s = Math.sin(this.angle)
    return {
      x: this.x + (local[0] * c - local[1] * s),
      y: this.y + (local[0] * s + local[1] * c),
    }
  }

  // Draw hull, shield, weapon nubs, and any beam emitter.
  // The fire at every nozzle, drawn before the hull so the hull sits over it.
  drawFlames(renderer, alpha = 1) {
    const back = this.angle + Math.PI
    for (const hp of this.hardpoints) {
      if (hp.module && hp.module.kind === "engine") {
        hp.module.drawFlame(renderer, this.mountWorld(hp.local), back, alpha)
      }
    }
  }

  drawShip(renderer, game, hullWidth) {
    this.drawFlames(renderer)
    renderer.strokePoly(this.worldOutline(), { color: this.colour, width: hullWidth, glow: 12 })
    if (this.burn > 0) {
      drawBurnFaces(renderer, this.worldOutline(), this.burnFaces, this.burnSpec, this.heat)
    }
    const shield = this.shieldModule()
    if (shield && shield.up) {
      shield.draw(
        renderer,
        this.x,
        this.y,
        this.shieldRadius(),
        this.energy / this.energyMax,
        game.gameTime,
      )
    }
    const found = game.hostileTarget(this)
    const seen = found && found.target
    for (const hp of this.hardpoints) {
      const m = hp.module
      if (!m || m.kind !== "weapon") {
        continue
      }
      const w = this.mountWorld(hp.local)
      m.drawWindUp(renderer, w, this.angle)
      if (m.type.kind === "projectile") {
        // pointed where the controller points it, so a heavy turret is legible
        const aim = trackedAim(seen, hp, w, this.angle)
        drawTurret(renderer, w.x, w.y, aim, m.barrels, this.turretColour, { length: 8 })
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
  // `type` is the hull being flown, which is the player's own unless a dev build says
  // otherwise. Everything below reads it rather than the design directly, so any hull
  // the shop can find mounts on can be flown.
  constructor(game, type = PLAYER_TYPE) {
    super(VIEW_W / 2, VIEW_H / 2)
    this.game = game
    this.angle = -Math.PI / 2
    this.type = type
    this.radius = type.confineRadius ?? type.boundRadius
    this.setOutline(type.outline)
    this.colour = type.colour
    this.buildHardpoints(type.hardpoints)
    this.applyLoadout(type.loadout)
    // Before the equipment goes on, because what a rock costs is priced off the hull it
    // has to get through.
    this.hull = type.hull
    // What the hull bar was reading a moment ago, which recedes toward the truth: the
    // gap between the two is drawn as the part just lost.
    this.hullShown = this.hull
    this.fitEquipment(game)
    this.nose = this.hardpointByRole("nose")
    this.aux = this.hardpointByRole("aux") // the turret's mount, filled from EQUIPMENT
    this.mainWeapon = this.nose.module
    this.energyMax = game.maxEnergy()
    this.energy = this.energyMax
    this.regen = 0 // regen handled explicitly (paused while charging/thrusting)
    this.invincible = CONFIG.INVIN_TIME
    this.thrusting = false
    this.reversing = false
    // One entry per slot, null where the slot is empty, so a slot's index is its
    // identity: buying into the third slot puts it in the third box.
    this.items = new Array(MAX_SLOTS).fill(null)
    // What the hull leaves the yard carrying, before anything is bought.
    for (const [slot, id] of (type.startingSpecials || []).entries()) {
      this.equip(slot, id)
    }
    this.buffs = new Map() // special id -> seconds of effect remaining
    this.turretAim = 0
    this.turretManual = 0 // time left under player (arrow-key) control
    this.turretFiring = false
    this.atBoundary = false
    this.impactSfx = 0 // throttles collision / boundary sounds
    // Warp presence: 1 is solid, 0 is gone. The ship is intangible below 1, and
    // the view turns this into the ripple and the hull fade.
    this.warp = 1
    this.warpTarget = 1
    this.warpHold = 0 // beat to wait before an arrival starts
  }

  // Whoever is flying it decides the side, not the hull. A dev build can put the player
  // in a rival's hull or an alien's, and a hull that reported its own faction made the
  // player one of them: their own guns looked for a target on the side they were now on
  // and found nothing, and an alien field treated alien fire as friendly.
  get faction() {
    return "player"
  }

  // Losing the hull costs a life and a respawn, so the player's is never cut into
  // wreckage the way a rival's is.
  get severable() {
    return false
  }
  // Nothing can reach the ship while it is still warping in, when it is not really
  // in the sector, nor during the grace period that follows. Named once because two
  // things turn on it: what damage is turned away, and whether anything hunting the
  // ship can see it at all, via Game.visiblePlayer. Those must not disagree.
  get untouchable() {
    return !this.inPlay() || this.invincible > 0
  }

  // Answered here, and not at each thing that can hurt, because the hull has no
  // health of its own: a single shot that reaches it costs a life, so being proof
  // against rocks alone is no protection.
  //
  // Everything that lands is totalled for the sector summary, whether the shield
  // soaked it or the hull did, so "flawless" means untouched. Nothing turned away
  // counts, since none of it landed.
  takeDamage(amount, game, channel, scoreOnKill, impact) {
    if (this.untouchable) {
      return false
    }
    game.stats.damage += amount
    return super.takeDamage(amount, game, channel, scoreOnKill, impact)
  }
  // A hit no bubble took reaches the hull, as it does on any other ship: it costs hull
  // points, and a life only when there are none left. Which is what makes a gentle bump
  // against a rock something to fly away from rather than the end of the run.
  onHull(amount, game) {
    this.hull -= amount
    if (this.hull <= 0) {
      this.hull = 0
      this.game.playerLoseLife()
      return
    }
    if (this.fxCooldown <= 0) {
      ;(game || this.game).burst(this.x, this.y, 5, PALETTE.player.lowEnergy, 40, 150, 0.4)
      this.fxCooldown = 0.12
    }
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
  inPlay() {
    return this.solid
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

  // Put a special in a slot. The slot holds its own state, so a level or any
  // other per-copy property has somewhere to live beside the cooldown.
  equip(slot, id) {
    this.items[slot] = { id, cooldown: 0, active: false }
    return this.items[slot]
  }

  // The first empty slot the ship has been fitted with, or -1 when it is full.
  freeSlot(slots) {
    for (let slot = 0; slot < slots; slot++) {
      if (!this.items[slot]) {
        return slot
      }
    }
    return -1
  }

  // Seconds left on a timed special, 0 when it is not running.
  buffTime(id) {
    return this.buffs.get(id) ?? 0
  }

  // Every special effect currently running: the timed ones, and any toggle that
  // is switched on.
  *activeEffects() {
    for (const id of this.buffs.keys()) {
      yield SPECIAL_TYPES[id]
    }
    for (const item of this.items) {
      if (!item) {
        continue
      }
      const type = SPECIAL_TYPES[item.id]
      if (item.active || type.mode === "passive") {
        yield type
      }
    }
  }

  // The running special type declaring `field`, or null. Effects are named in
  // SPECIAL_TYPES rather than tested for by id, so the gameplay code below asks
  // "is anything lengthening my beam?" instead of "is BOOSTER running?".
  buffWith(field) {
    for (const type of this.activeEffects()) {
      if (type[field] !== undefined) {
        return type
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

  // Stop what one slot is doing, wherever the effect is held, and start its
  // cooldown. A timed effect lives in `buffs` and a toggle on the item itself.
  stopSlot(slot) {
    const item = this.items[slot]
    if (!item) {
      return
    }
    item.active = false
    this.buffs.delete(item.id)
    item.cooldown = SPECIAL_TYPES[item.id].cooldown
  }

  // Stop whatever is running that declares `field`, wherever it is held: a timed
  // effect is dropped and a toggle is switched off, both onto their cooldowns.
  endEffectsWith(field) {
    for (const [id, remaining] of this.buffs) {
      if (SPECIAL_TYPES[id][field] !== undefined && remaining > 0) {
        this.buffs.delete(id)
        this.#beginCooldown(id)
      }
    }
    for (const item of this.items) {
      if (item && item.active && SPECIAL_TYPES[item.id][field] !== undefined) {
        item.active = false
        item.cooldown = SPECIAL_TYPES[item.id].cooldown
      }
    }
  }

  // A timed effect is held in `buffs` by id, so its cooldown has to be found in
  // whichever slots carry that special.
  #beginCooldown(id) {
    for (const item of this.items) {
      if (item && item.id === id) {
        item.cooldown = SPECIAL_TYPES[id].cooldown
      }
    }
  }

  #tickBuffs(dt) {
    for (const [id, remaining] of this.buffs) {
      if (remaining - dt <= 0) {
        this.buffs.delete(id)
        this.#beginCooldown(id) // the cooldown runs from the end of the effect
      } else {
        this.buffs.set(id, remaining - dt)
      }
    }
  }

  // Slots recover, and anything switched on keeps drawing on the cell. A toggle
  // that runs the cell dry switches itself off rather than stranding the ship.
  #tickSlots(dt, game) {
    for (const item of this.items) {
      if (!item) {
        continue
      }
      const type = SPECIAL_TYPES[item.id]
      if (type.mode === "passive") {
        // Always on, so what it costs is charged for as long as it is fitted. The
        // magnet costs nothing, which is why it can sit in a slot for a whole run.
        if (type.drain) {
          this.energy = Math.max(0, this.energy - type.drain * this.energyMax * dt)
        }
      } else if (item.active) {
        this.energy = Math.max(0, this.energy - type.drain * this.energyMax * dt)
        if (this.energy <= 0) {
          item.active = false
          item.cooldown = type.cooldown
          game.showToast(`${type.label} OFFLINE`)
        }
      } else if (item.cooldown > 0) {
        item.cooldown = Math.max(0, item.cooldown - dt)
      }
    }
  }

  // Fitting something already fitted is ignored, so buying twice or resuming a
  // run does not reset a weapon mid-reload.
  // Mount whatever the run has fitted in each equipment slot, replacing what was
  // there. The drive decides how hard the ship accelerates, so that follows.
  // Which of this hull's mounts a shop slot fills, in the hull's own terms: every mount
  // whose role the slot names. A drive is the ship's rather than one nozzle's, so a hull
  // with a pair of them takes a matched pair; a turret is each mount's own, which is what
  // `perMount` decides once they are found.
  mountsForSlot(spec) {
    const found = []
    this.hardpoints.forEach((hp, index) => {
      if (spec.roles.includes(hp.role)) {
        found.push(index)
      }
    })
    return found
  }

  fitEquipment(game) {
    for (const [slot, spec] of Object.entries(EQUIPMENT)) {
      this.mountsForSlot(spec).forEach((at, ordinal) => {
        const id = game.fittedEquipment(slot, ordinal)
        const hp = this.hardpoints[at]
        // Nothing said about this mount, which only a per-mount slot can mean: it keeps
        // whatever the hull came with rather than being stripped by a slot nobody has
        // touched.
        if (id === undefined) {
          return
        }
        // Nothing fitted means the slot is empty on purpose, so whatever it put there
        // comes off. Each slot owns its mounts outright, so there is nothing else on
        // them to lose.
        if (!id) {
          if (spec.slot) {
            if (hp.module && hp.module.kind === "core") {
              hp.module.remove(spec.slot)
            }
          } else if (hp.module) {
            hp.module = null
          }
          return
        }
        const entry = { hp: at, [spec.mount]: id }
        if (spec.controller) {
          entry.controller = spec.controller
        }
        if (spec.slot) {
          if (hp.module && hp.module.kind === "core") {
            hp.module.equip(spec.slot, entry)
          }
        } else if (!hp.module || hp.module.typeName !== id) {
          this.applyLoadout([entry])
        }
      })
    }
    // The main laser is whatever ended up on the nose, so swapping a mark in has to
    // be followed by looking again.
    const nose = this.hardpointByRole("nose")
    if (nose) {
      this.mainWeapon = nose.module
    }
    this.refreshFitting()
  }

  // Is a turret fitted? Asked of the mount rather than of an upgrade flag, so it is
  // true exactly when there is a gun there to aim and to draw.
  hasTurret() {
    return !!(this.aux && this.aux.module && this.aux.module.kind === "weapon")
  }

  fireLaser(game) {
    const w = this.mainWeapon
    if (!w || w.cooldown > 0) {
      return
    }
    // A gun that does not charge fires the way every other hull fires it: at its own
    // reach, for its own energy, the moment the trigger goes. The charged path below
    // reads fields such a gun does not have, and a beam of NaN length is drawn as a
    // white disc over half the screen.
    if (!w.type.chargeable) {
      // A gun that winds up is fired by the wind-up finishing and the trigger coming up,
      // which the update loop does. Firing one from here would hand over a finished well
      // for a tap, since the key going up is a release like any other.
      if (w.type.chargeTime && !w.wound) {
        return
      }
      const mount = this.mountWorld(this.nose.local)
      game.stats.shots++
      w.fire(game, this, mount.x, mount.y, this.angle, w.rollLength())
      return
    }
    if (w.charge < w.type.chargeMin) {
      return
    }
    const chargeFrac = clamp(w.charge / w.type.chargeMax, 0, 1)
    const length = w.charge * this.beamLengthMult() + w.type.chargeReach
    const damage = w.type.damage * this.chargeDamageMult()
    const colour = this.overdriven ? PALETTE.player.overdrive : w.type.colour
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
        color: colour,
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
    w.release()
    this.endEffectsWith("endsOnFire") // the shot gives the ship's position away
    Sound.fire(0.9 + 0.35 * chargeFrac) // pitch rises slightly with charge
  }

  // Charged-beam reach multiplier, extended by a special that declares one.
  beamLengthMult() {
    return this.buffField("beamLengthMult", 1)
  }

  // A laser wound all the way up, at a level that has overdrive. The shot shatters
  // any rock it reaches.
  get overdriven() {
    return this.overdriveWind >= 1
  }

  // How far the shot is into its overdrive wind-up, 0 to 1. Zero at a level that
  // does not have overdrive, so the glow never leaves its usual colour.
  get overdriveWind() {
    const w = this.mainWeapon
    return w && w.type.canOverdrive ? w.overdrive : 0
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
    // The grace period is for flying, so it does not run down while the ship is
    // still warping in and cannot be flown. Counting it from the arrival is what
    // makes INVIN_TIME the number of seconds a player actually gets.
    if (this.solid) {
      this.invincible = Math.max(0, this.invincible - dt)
    }
    this.#tickWarp(dt, game)
    this.#tickBuffs(dt)
    this.#tickSlots(dt, game)
    this.impactSfx = Math.max(0, this.impactSfx - dt)
    this.slamCooldown = Math.max(0, this.slamCooldown - dt)
    // The hull bar catches up with the hull, so a loss is shown receding rather than
    // having already happened. A gain (a fresh ship) is taken at once: there is nothing
    // to explain about being whole again.
    this.hullShown =
      this.hullShown > this.hull
        ? Math.max(this.hull, this.hullShown - CONFIG.HULL_LOSS_FADE * dt)
        : this.hull
    this.energyMax = game.maxEnergy()

    const pad = game.padInput
    const canControl = game.canFly() && this.solid
    // Keys fly the ship and aim the defense turret (below), through whatever they
    // are bound to. A gamepad steers by stick, so the turn is a signed rate rather
    // than a pair of keys: a key counts as full deflection and a stick gives
    // everything between.
    if (canControl) {
      const turn = clamp(
        pad.turn + (game.holding("turnRight") ? 1 : 0) - (game.holding("turnLeft") ? 1 : 0),
        -1,
        1,
      )
      this.angle += this.turnRate * turn * dt
      this.thrusting = game.holding("thrust") || pad.thrust
    } else {
      this.thrusting = false
    }

    // The turret controls take it off auto: two of them swing the aim and one
    // fires. A gamepad's right stick points it instead, which is an absolute
    // bearing rather than a rate. Any input holds manual mode; after a short
    // cooldown with no input it reverts to auto-targeting.
    this.turretManual = Math.max(0, this.turretManual - dt)
    this.turretFiring = false
    if (canControl && this.hasTurret()) {
      let active = false
      if (pad.turretAim !== null) {
        this.turretAim = pad.turretAim
        active = true
      }
      if (game.holding("turretLeft")) {
        this.turretAim -= CONFIG.TURRET_AIM_RATE * dt
        active = true
      }
      if (game.holding("turretRight")) {
        this.turretAim += CONFIG.TURRET_AIM_RATE * dt
        active = true
      }
      if (game.holding("turretFire") || pad.turretFire) {
        this.turretFiring = true
        active = true
      }
      if (active) {
        this.turretManual = CONFIG.TURRET_MANUAL_HOLD
      }
    }

    if (this.thrusting) {
      this.vx += Math.cos(this.angle) * this.accel * dt
      this.vy += Math.sin(this.angle) * this.accel * dt
      if (this.energy > 0) {
        this.energy -= CONFIG.THRUST_COST * dt
      }
      const back = this.angle + Math.PI
      this.thrustPlume(dt, game)
      // exhaust wash gently shoves rocks caught behind the thruster away
      const bx = Math.cos(back),
        by = Math.sin(back)
      const range = CONFIG.EXHAUST_WASH_RANGE
      for (const a of game.asteroids) {
        const dx = a.center.x - this.x,
          dy = a.center.y - this.y
        const centre = Math.hypot(dx, dy)
        if (centre < 1) {
          continue
        }
        const ux = dx / centre,
          uy = dy / centre
        const align = ux * bx + uy * by // 1 = directly behind the ship
        if (align < 0.25) {
          continue
        }
        // Range is measured to the rock's near surface, as a blast's is. Measured
        // to the middle, a boulder with its face in the exhaust counted as most of
        // a range away and was barely moved, which is exactly the rock the wash is
        // wanted for. Mass is the sim's own, so the wash agrees with everything
        // else about how heavy a rock is.
        const gap = Math.max(0, centre - a.boundRadius)
        if (gap > range) {
          continue
        }
        const push = (CONFIG.EXHAUST_WASH_FORCE * (1 - gap / range) * align) / rockMass(a.area)
        a.vx += ux * push * dt
        a.vy += uy * push * dt
      }
    }

    // Whether the ship can back up at all is the drive's business, not an upgrade
    // flag: a nozzle pointed one way pushes one way, and the shop sells a drive
    // whose vanes can turn it around.
    const reverseAmount = this.driveReverse()
    this.reversing =
      canControl && reverseAmount > 0 && !this.thrusting && (game.holding("reverse") || pad.reverse)
    if (this.reversing) {
      this.vx -= Math.cos(this.angle) * this.accel * reverseAmount * dt
      this.vy -= Math.sin(this.angle) * this.accel * reverseAmount * dt
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
    if (speed > this.maxSpeed) {
      this.vx *= this.maxSpeed / speed
      this.vy *= this.maxSpeed / speed
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
    const holding = canControl && (game.holding("fire") || pad.charging)
    const freeShot = this.buffField("freeCharge", false)
    // A gun that does not charge has no `chargeMax`, `chargeRate` or `chargeCost`, and
    // winding one up puts NaN through the cell: the energy bar, the charge bar and the
    // shield bubble all read off it, and a bubble drawn at NaN alpha is an opaque white
    // ring round the ship. It fires on its own cooldown for as long as the trigger is
    // held instead, which is how every other hull fires one.
    // A gun that winds up rather than charging keeps its own clock, and pays as it runs.
    // It is held wound once the clock is out, and let go of on the release, which is how
    // the main laser is fired: the trigger means the same thing whatever is on the nose.
    // Only while something is actually happening. A hold that cannot start a wind-up,
    // because the gun is still on a reload, must fall through to the cell below: holding
    // the trigger through one used to stall the regen and do nothing else.
    const winds = !w.type.chargeable && w.type.chargeTime
    if (winds && (w.wound || w.charging > 0 || (holding && w.ready))) {
      if (!holding) {
        if (w.wound) {
          this.fireLaser(game) // let go of, so it goes
        } else {
          // Let go of early: what was drawn in comes apart where it was being held, and
          // what it cost is gone with it. The hulls that carry these guns hold them until
          // they are ready, so this is the player's to get right.
          w.evaporate(game, this.mountWorld(this.nose.local))
        }
        w.wound = false
        w.charging = 0
      } else if (w.wound) {
        // Holding a finished one keeps drawing on the cell: what limits how often it can
        // be thrown is how fast the cell fills, and everything the cell is also paying
        // for goes short while it is being held. The shield reads the same cell.
        if (w.windUp(dt, this)) {
          w.generate(dt, game, this, this.mountWorld(this.nose.local))
        } else {
          w.evaporate(game, this.mountWorld(this.nose.local))
          w.wound = false
        }
      } else if (w.charging > 0) {
        if (w.windUp(dt, this)) {
          w.charging -= dt
          w.generate(dt, game, this, this.mountWorld(this.nose.local))
          w.wound = w.charging <= 0
        } else {
          w.charging = 0 // the cell gave out, and what was spent is spent
        }
      } else if (w.ready) {
        w.charging = w.type.chargeTime
        w.chargeDuration = w.charging
        Sound.charge(w.chargeDuration)
      }
    } else if (holding && !w.type.chargeable && !winds) {
      this.fireLaser(game)
    } else if (holding && w.type.chargeable) {
      const rate = w.type.chargeRate
      const cost = w.type.chargeCost
      if (this.energy > 4 || freeShot) {
        // Past full charge the hold keeps drawing, winding the shot up to overdrive
        // at its own rate and its own price.
        const winding = w.charge >= w.type.chargeMax && w.type.canOverdrive
        if (winding) {
          w.overdrive = Math.min(1, w.overdrive + dt / CONFIG.LASER_OVERDRIVE_TIME)
        } else {
          w.charge = Math.min(w.type.chargeMax, w.charge + rate * dt)
        }
        if (!freeShot) {
          this.energy -= (winding ? CONFIG.LASER_OVERDRIVE_COST : cost) * dt
        }
      }
    } else {
      if (w.charge > 0) {
        w.release()
      }
      if (!this.thrusting) {
        this.energy = Math.min(this.energyMax, this.energy + game.playerCore().regen * dt)
      }
    }
    this.energy = clamp(this.energy, 0, this.energyMax)
    this.updateShield(dt, game)

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

    // Pick up specials into a free inventory slot. One just thrown overboard is
    // still arming, and is passed over until it settles.
    for (let i = game.specialPickups.length - 1; i >= 0; i--) {
      const pickup = game.specialPickups[i]
      const slot = this.freeSlot(game.specialSlots())
      if (
        pickup.arming <= 0 &&
        slot >= 0 &&
        Math.hypot(pickup.x - this.x, pickup.y - this.y) < this.radius + 14
      ) {
        this.equip(slot, pickup.type)
        game.specialPickups.splice(i, 1)
        game.findSpecial(pickup.type)
        Sound.power()
        const spec = SPECIAL_TYPES[pickup.type]
        game.burst(pickup.x, pickup.y, 12, spec.colour, 30, 120, 0.6)
        game.showToast(`${spec.label} SPECIAL COLLECTED`)
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
        const reach = asteroid.contactReach() + this.contactReach()
        if (dx * dx + dy * dy >= reach * reach) {
          continue
        }
        const contact = shapeContact(asteroid.contactShape(), this.contactShape())
        if (!contact) {
          continue
        }
        touching = true
        moved = true
        const { impact, closing } = resolveHullRockContact(this, asteroid, contact)
        if (closing > 0) {
          closingSpeed = Math.max(closingSpeed, closing)
          worstImpact = impact
          if (closing > 45 && this.impactSfx <= 0) {
            Sound.bump() // knock on contact with a rock
            this.impactSfx = 0.15
          }
          // Hit hard enough, the piece comes apart on the hull instead of bouncing off
          // it. The hull is charged for the contact either way, below.
          game.impactShatter(asteroid, closing)
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
    // flash the shield on the side facing the rock
    this.chargeRockContact(dt, game, closingSpeed, worstImpact)
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
    const scale = 0.3 + 0.7 * t // the hull swelling into place, at its own size
    const hull = this.outlineLocal.map((p) => ({
      x: this.x + (p[0] * c - p[1] * s) * scale,
      y: this.y + (p[0] * s + p[1] * c) * scale,
    }))
    renderer.strokePoly(hull, {
      color: this.colour,
      width: this.type.hullWidth,
      glow: 20,
      alpha: t,
    })
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
    // A special that hides the ship draws it faint, so the player can still fly
    // it while nothing else can see it.
    const fade = this.buffField("hullAlpha", 1)

    if (this.thrusting) {
      this.drawFlames(renderer, fade)
    }
    renderer.strokePoly(this.worldOutline(), {
      color: colour,
      width: this.type.hullWidth,
      glow: 14,
      alpha: fade,
    })
    if (tint) {
      renderer.circle(this.x, this.y, this.radius * 1.7, {
        stroke: colour,
        width: this.type.hullWidth,
        alpha: 0.5 * fade,
      })
    }

    // Shield bubble around the ship (fades with the energy cell; gone when overloaded).
    const shield = this.shieldModule()
    if (shield && shield.up) {
      shield.draw(
        renderer,
        this.x,
        this.y,
        this.shieldRadius(),
        this.energy / this.energyMax,
        game.gameTime,
        fade,
      )
    }

    // Every gun the hull carries that is not the one on its nose, rather than only the
    // one the shop fitted: a hull flown out of the dev page brings its own, and they were
    // firing from mounts with nothing drawn on them.
    for (const hp of this.hardpoints) {
      const gun = hp.module
      if (!gun || gun.kind !== "weapon" || hp.role === "nose") {
        continue
      }
      // The one under the player's own hand points where they are aiming; the hull's own
      // point where their controller has them pointed.
      const own = hp === this.aux
      const aim = own ? this.turretAim || 0 : (hp.aim ?? this.angle)
      const mount = this.mountWorld(hp.local)
      drawTurret(renderer, mount.x, mount.y, aim, gun.barrels, this.turretColour, {
        length: 12,
        alpha: fade,
      })
    }

    const w = this.mainWeapon
    // A gun that winds up shows it at the muzzle, the same way it does on the hull this
    // one was taken from.
    if (w && (w.charging > 0 || w.wound)) {
      w.drawWindUp(renderer, this.mountWorld(this.nose.local), this.angle)
    }
    if (w && w.charge > 4) {
      const nose = this.mountWorld(this.nose.local)
      const length = w.charge * this.beamLengthMult() + w.type.chargeReach
      const frac = clamp(w.charge / w.type.chargeMax, 0.3, 1)
      // The glow crosses to the overdrive colour across the wind-up and pulses once
      // it is there, so a primed shot reads differently from one still winding up.
      const wind = this.overdriveWind
      const pulse = this.overdriven ? 0.78 + 0.22 * Math.sin(game.gameTime * 11) : 1
      renderer.line(
        nose.x,
        nose.y,
        nose.x + Math.cos(this.angle) * length,
        nose.y + Math.sin(this.angle) * length,
        {
          color: mixColour(PALETTE.player.charge, PALETTE.player.overdrive, wind),
          alpha: frac * pulse * fade,
          width: 1.5 + 2.5 * (w.charge / w.type.chargeMax) + 2 * wind,
          glow: 14 + 10 * wind,
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
    this.setOutline(type.outline)
    this.colour = type.colour
    this.energyMax = type.energyMax
    this.energy = type.energyMax
    this.regen = type.regen
    this.hull = type.hull // hull HP once the shield is gone; more than one hit
    this.lifeTimer = randRange(type.lifeTime[0], type.lifeTime[1])
    // A rival starts well outside the view and flies in, and out there it is
    // intangible and holds fire. Its life is what it spends in the sector, so
    // the clock does not start until it has reached one.
    this.arrived = false
    this.leaving = false
    this.wander = null // where it is headed with nothing better to do
    this.wanderFor = 0
    this.buildHardpoints(type.hardpoints)
    this.applyLoadout(loadout || type.loadout || [])
    // How it flies comes from what it turned up carrying rather than from the type,
    // so a hull that rolled an extra gun is a little heavier and a little slower for
    // it. With the design's own loadout the two answers are the same.
    this.refreshFitting()
    this.hunts = !!type.hunts
  }

  // Outside the arena a rival cannot be harmed at all, whatever the channel. It is
  // flying in or flying out and not really in the sector, so this mirrors the
  // player being intangible mid-warp. Wreckage left out there would be snapped
  // back into the field by the arena confinement the moment it existed.
  inPlay() {
    return this.insideArena()
  }
  takeDamage(amount, game, channel, scoreOnKill, impact) {
    if (!this.inPlay()) {
      return false
    }
    return super.takeDamage(amount, game, channel, scoreOnKill, impact)
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
    if (this.dead) {
      return // killed earlier this frame, and dropped from the list after this loop
    }
    const prey = game.hostileTarget(this)
    this.regenEnergy(dt)
    this.updateShield(dt, game)
    this.slamCooldown = Math.max(0, this.slamCooldown - dt)
    if (this.arrived) {
      this.lifeTimer -= dt
    } else if (this.insideArena()) {
      this.arrived = true
    }

    // Ore close by is worth a detour; with none in reach it makes for the nearest
    // rock, which is where ore comes from. A rock's own x/y is its centroid, so
    // steering at the body steers at the middle of it.
    const found =
      game.nearestOre(this, Math.min(CONFIG.RIVAL_ORE_INTEREST, this.sensorRange("ore"))) ||
      game.nearestAsteroid(this, this.sensorRange("rocks"))
    const target = found && found.target
    if (this.lifeTimer <= 0) {
      this.leaving = true
    }

    this.wanderFor -= dt
    this.#considerBreakingOff(dt, prey)
    const outAngle = Math.atan2(this.y - ARENA.cy, this.x - ARENA.cx)
    const goal = this.leaving
      ? {
          x: ARENA.cx + Math.cos(outAngle) * (ARENA.radius + CONFIG.RIVAL_EXIT_MARGIN),
          y: ARENA.cy + Math.sin(outAngle) * (ARENA.radius + CONFIG.RIVAL_EXIT_MARGIN),
        }
      : this.hunts && prey
        ? this.breaking > 0
          ? this.#awayFrom(prey.target)
          : { x: prey.target.x, y: prey.target.y }
        : target || this.#wanderGoal()
    // A hull breaking off is committing to an arc out, not snapping round on the spot: what
    // it can manage while it does is the type's business, and a hull that says nothing turns
    // as it always does.
    const spec = this.type.breakOff
    const rate = this.breaking > 0 && spec && spec.turn ? this.turnRate * spec.turn : this.turnRate
    const turn = shortestTurn(this.angle, bearingTo(this, goal))
    this.angle += clamp(turn, -rate * dt, rate * dt)
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

    this.thrustPlume(dt, game)

    for (let i = game.oreChunks.length - 1; i >= 0; i--) {
      if (
        Math.hypot(game.oreChunks[i].x - this.x, game.oreChunks[i].y - this.y) <
        CONFIG.RIVAL_ORE_GRAB
      ) {
        game.oreChunks.splice(i, 1)
        game.rivalScore += CONFIG.ORE_SCORE
        game.burst(this.x, this.y, 4, PALETTE.rival.hull, 30, 80, 0.3)
      }
    }

    this.#bounceOffRocks(dt, game)
    this.updateWeapons(dt, game) // guns + main laser fire via their controllers

    // Dropped only once it is wholly outside the ring and wholly out of sight, so
    // it is never seen to blink out. Its own reach is added to both, so the test is
    // about the hull and not about its centre.
    if (
      this.leaving &&
      !this.insideArena() &&
      !game.onScreen(this.x, this.y, this.boundRadius + CONFIG.RIVAL_DESPAWN_MARGIN)
    ) {
      this.dead = true
    }
  }

  // Where a hull goes when its radar finds nothing worth going to. It keeps to one
  // point until it arrives or gives up on it, which reads as looking for something;
  // steering at the middle of the arena instead reads as waiting on the spawn, and
  // is where the player is about to appear.
  #wanderGoal() {
    const reached = this.wander && Math.hypot(this.x - this.wander.x, this.y - this.wander.y) < 120
    if (!this.wander || reached || this.wanderFor <= 0) {
      // A step from where it stands, rather than a point picked over the field.
      // Picking over the field walks a hull toward the middle of the arena, because
      // that is where the middle of the field is, and the middle of the arena is
      // where the player warps in. A step has no such pull.
      const bearing = randRange(0, TAU)
      const step = randRange(320, 720)
      let x = this.x + Math.cos(bearing) * step
      let y = this.y + Math.sin(bearing) * step
      const away = Math.hypot(x - ARENA.cx, y - ARENA.cy)
      const limit = ARENA.radius - 60 // room to search the rim, not just the middle
      if (away > limit) {
        x = ARENA.cx + ((x - ARENA.cx) / away) * limit
        y = ARENA.cy + ((y - ARENA.cy) / away) * limit
      }
      this.wander = { x, y }
      this.wanderFor = randRange(4, 9)
    }
    return this.wander
  }

  // Every engine draws its own plume from its own hardpoint, so a hull with two
  // nozzles shows two streams and one that has lost an engine stops showing its.
  // A hull that hunts can also know when to be somewhere else. `breakOff` on the type says
  // when: inside `near` it is too close to be shooting from, and inside `aimedWithin` with
  // the prey pointed at it within `facing` it is about to be shot at. Either sends it out
  // for `hold` seconds, which is what stops it dithering on the line: a hull that turned
  // back the instant it was clear would sit at the boundary being shot.
  //
  // A type that says nothing keeps flying straight at what it hunts, which is what a slab
  // does: it has no dodge in it and nothing to gain by trying.
  #considerBreakingOff(dt, prey) {
    const spec = this.type.breakOff
    this.breaking = Math.max(0, (this.breaking ?? 0) - dt)
    if (!spec || !prey || this.leaving) {
      return
    }
    const tooClose = prey.distance < spec.near
    const aimed =
      prey.target.angle != null &&
      prey.distance < spec.aimedWithin &&
      Math.abs(shortestTurn(prey.target.angle, bearingTo(prey.target, this))) < spec.facing
    if (tooClose || aimed) {
      this.breaking = spec.hold
    }
  }

  // Somewhere well away from a body, on the bearing straight out from it.
  #awayFrom(body) {
    const out = bearingTo(body, this)
    return { x: this.x + Math.cos(out) * 400, y: this.y + Math.sin(out) * 400 }
  }

  // Rivals are solid: they shoulder rocks aside instead of flying through them.
  // Contact is the rock's outline against the ship's, both as convex parts, so
  // a frigate's length and waist are respected. It costs them, as it costs the
  // player, so a rival that ploughs through a field wears itself down; how much
  // is the type's `rockContact`. Damage is charged once however many rocks are
  // touching, so a corner is not doubly punishing.
  #bounceOffRocks(dt, game) {
    let worstImpact = null
    let closingSpeed = 0
    let touching = false
    for (const asteroid of game.asteroids) {
      const dx = this.x - asteroid.center.x,
        dy = this.y - asteroid.center.y
      const reach = asteroid.contactReach() + this.contactReach()
      if (dx * dx + dy * dy >= reach * reach) {
        continue
      }
      const contact = shapeContact(asteroid.contactShape(), this.contactShape())
      if (!contact) {
        continue
      }
      touching = true
      const { impact, closing } = resolveHullRockContact(this, asteroid, contact)
      game.impactShatter(asteroid, closing)
      if (closing > closingSpeed) {
        closingSpeed = closing
        worstImpact = impact
      } else if (!worstImpact) {
        worstImpact = impact
      }
    }
    if (touching) {
      this.chargeRockContact(dt, game, closingSpeed, worstImpact)
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
    this.burnBacklog = { fire: 0, smoke: 0 }
    if (this.burnSpec && opts.burnFrom) {
      this.burnFaces = facesOnLine(this.vertices, opts.burnFrom.point, opts.burnFrom.normal)
      if (this.burnFaces.length) {
        this.burn = this.burnSpec.seconds
      }
    }

    if (!opts.vertices) {
      // Fresh rock: mount modules on hardpoints. A shield takes the centre; guns
      // are fanned around it.
      //
      // Each gun used to pick its own vertex to sit under, and independent picks
      // land on the same bearing often enough to read as a cluster: one pair in
      // ten ended up closer than the nubs the view draws for them. They are now
      // dealt an even share of the circle each, jittered, and set a fraction of
      // the way out along that bearing, so they stay inside the outline whatever
      // its shape and stay apart at any count.
      const traits = opts.traits || {}
      if (traits.gun) {
        const count = randInt(traits.gun.count[0], traits.gun.count[1])
        const jitter = traits.gun.jitter ?? 0.3
        const inset = traits.gun.inset ?? [0.35, 0.7]
        // Each turret is rolled from the trait's pool, so one rock can carry a
        // mix. A trait naming a single gun is that pool with one entry in it.
        const guns = traits.gun.guns ?? [traits.gun]
        const phase = Math.random() * TAU
        for (let k = 0; k < count; k++) {
          const bearing = phase + (k / count) * TAU + randRange(-jitter, jitter)
          const ux = Math.cos(bearing),
            uy = Math.sin(bearing)
          const reach = boundaryDistance(
            this.vertices,
            this.center,
            ux,
            uy,
            this.boundRadius * 2 + 1,
          )
          const out = reach * randRange(inset[0], inset[1])
          // Weighed as every pool is, on weights the spawner baked in for the
          // sector; an empty pool arms nothing rather than throwing.
          const gun = weightedPick(guns, (entry) => entry.weight ?? 1)
          if (!gun) {
            continue
          }
          this.hardpoints.push({
            x: this.center.x + ux * out,
            y: this.center.y + uy * out,
            module: new Weapon(gun.weapon, gun.controller),
          })
        }
      }
      if (traits.shield) {
        this.hardpoints.push({
          x: this.center.x,
          y: this.center.y,
          module: new Shield(traits.shield.shield),
        })
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

  // A rock's bubble clears its outline by a fixed margin, since a rock has no
  // type to carry one.
  shieldRadius() {
    return this.boundRadius + 10
  }

  hitOutline() {
    return this.vertices
  }

  // The closing speed at which this piece comes apart rather than being shoved. Its
  // material's if it has one, which is how a hull fragment is more fragile than the
  // rock it is drifting among.
  get shatterAt() {
    return (this.material && this.material.shatterAt) ?? CONFIG.ROCK_SHATTER_SPEED
  }

  contactShape() {
    const bubble = this.barrierUp() ? this.shieldRadius() : 0
    return bubble > 0
      ? { centre: this.center, radius: bubble }
      : { centre: this.center, parts: this.convexParts() }
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

  #burnFaces(dt, game) {
    this.burn = Math.max(0, this.burn - dt)
    this.burnBacklog = emitBurn(
      game,
      this,
      this.vertices,
      this.burnFaces,
      this.burnSpec,
      this.heat,
      this.burnBacklog,
      dt,
    )
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
    if (this.dead) {
      return // detonated or shattered earlier this frame
    }
    this.regenEnergy(dt)
    this.updateShield(dt, game)
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

  // A gun coming apart at its mount: a flash, fire out of it and embers falling off
  // the debris, burning as whatever it was bolted to burns. Shared, so a gun shot off
  // a rock and a gun lost to a cut through it go the same way. The sound is the
  // caller's, since several can go at once.
  turretLost(hp, game) {
    const burn = this.burnSpec || DEFAULT_BURN
    game.burst(hp.x, hp.y, randInt(14, 20), burn.colour, 60, 230, 0.5)
    game.burst(hp.x, hp.y, randInt(6, 10), burn.ember, 30, 150, 0.75)
    game.ring(hp.x, hp.y, 9, PALETTE.fx.flash, 230, 0.4)
  }

  // Shoot the guns off. A mount within AST_TURRET_HITBOX of the beam is taken out,
  // whether or not the shot goes on to cut the rock underneath it, so a turret can
  // be picked off a boulder too big to cut apart. Returns how many were lost, and
  // the rock's cell shrinks with them.
  strikeTurrets(beam, halfWidth, game) {
    const reach = CONFIG.AST_TURRET_HITBOX + halfWidth
    const struck = this.hardpoints.filter(
      (hp) =>
        hp.module &&
        hp.module.kind === "weapon" &&
        segmentCircleEntry(beam.a, beam.b, hp, reach) !== null,
    )
    if (!struck.length) {
      return 0
    }
    this.hardpoints = this.hardpoints.filter((hp) => !struck.includes(hp))
    for (const hp of struck) {
      this.turretLost(hp, game)
    }
    Sound.explode() // once, however many went with the shot
    this.refreshEnergy(this.energy)
    return struck.length
  }

  // Split by a beam, distributing hardpoints to whichever piece they fall on.
  // A concave fragment can yield more than two pieces; all are handled.
  splitBy(beam, game) {
    const cutNormal = perpendicular(beam.dir)
    const parts = slicePolygon(this.vertices, beam.a, cutNormal)
    if (parts.length < 2) {
      return null
    }
    // A gun the cut passes through goes with it. Distance to the cut line rather
    // than to the piece's outline, since the cut is the only edge that is new: a
    // turret was inside the parent, so the cut is the only thing that can leave it
    // hanging off an edge. A shield sits at the centre and is the rock's rather than
    // any one piece's, so it is not held to this.
    const lostToCut = (hp) =>
      hp.module &&
      hp.module.kind === "weapon" &&
      Math.abs(dot(subtract(hp, beam.a), cutNormal)) < CONFIG.AST_TURRET_CLEARANCE
    for (const hp of this.hardpoints) {
      if (lostToCut(hp)) {
        this.turretLost(hp, game)
      }
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
        const oreCount = oreFromFragment(area)
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
      // is correct even when a concave cut produces more than two pieces) and clear
      // of the cut itself
      const mine = this.hardpoints.filter((hp) => pointInPolygon(hp, partVerts) && !lostToCut(hp))
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
    const blast = { centre: this.center, radius: CONFIG.BLAST_R }
    // Range to a rock is measured to its near surface, not to its middle, so a
    // boulder with its face against the blast is next to it however far off its
    // centre sits.
    game.applyRadialForce({
      ...blast,
      include: ["asteroids"],
      toSurface: true,
      skip: this,
      visit: (other, { dir, distance, falloff }) => {
        if (other.explosive) {
          if (other.fuse == null) {
            other.fuse = randRange(0.05, 0.18)
          }
          return
        }
        // Whether a shield was there to meet the blast, asked before the blast
        // drains it: a shield that soaks this hit has earned the rock this hit,
        // even if the drain overloads it and leaves it bare for the next one.
        const wasShielded = other.shieldUp()
        // A rock takes blast damage as a ship does, so a shield drains and an armed
        // rock is worn down instead of the blast passing through it. A bare rock has
        // no hull to lose, which is what the shatter below is for.
        other.takeDamage(CONFIG.BLAST_DAMAGE * falloff, game, "projectile")
        // Close in, anything the blast reached unshielded is broken up outright.
        if (distance < killRadius && !wasShielded) {
          game.shatterToOre(other)
          other.dead = true
          return
        }
        other.vx += dir.x * CONFIG.BLAST_IMPULSE * falloff
        other.vy += dir.y * CONFIG.BLAST_IMPULSE * falloff
        other.spin += randRange(-2, 2) * falloff
      },
    })
    game.applyRadialForce({
      ...blast,
      include: ["player"],
      visit: (player, { dir, falloff }) => {
        player.vx += dir.x * CONFIG.BLAST_KNOCK_PLAYER * falloff
        player.vy += dir.y * CONFIG.BLAST_KNOCK_PLAYER * falloff
        player.takeDamage(CONFIG.BLAST_DAMAGE * falloff, game, "projectile")
      },
    })
    game.applyRadialForce({
      ...blast,
      include: ["rivals"],
      visit: (rival, { dir, falloff }) => {
        rival.vx += dir.x * CONFIG.BLAST_KNOCK_RIVAL * falloff
        rival.vy += dir.y * CONFIG.BLAST_KNOCK_RIVAL * falloff
        rival.takeDamage(CONFIG.BLAST_DAMAGE * falloff, game, "projectile", rival.type.blastScore)
      },
    })
    game.applyRadialForce({
      ...blast,
      include: ["projectiles"],
      visit: (bullet, { dir }) => {
        const speed = Math.max(CONFIG.BULLET_SPEED, Math.hypot(bullet.vx, bullet.vy))
        bullet.vx = dir.x * speed
        bullet.vy = dir.y * speed
      },
    })
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
      drawBurnFaces(renderer, this.vertices, this.burnFaces, this.burnSpec, this.heat)
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
        this.shieldRadius(),
        this.energy / this.energyMax,
        game.gameTime,
      )
    }
    const found = game.hostileTarget(this)
    const seen = found && found.target
    for (const hp of this.hardpoints) {
      if (!hp.module || hp.module.kind !== "weapon") {
        continue
      }
      const aim = trackedAim(seen, hp, hp, 0)
      drawTurret(renderer, hp.x, hp.y, aim, hp.module.barrels, PALETTE.weapon.gun)
    }
  }
}

// ---------------------------------------------------------------------------
// Singularity: what an alien heavy gun lets go of. A slow-travelling well that drags
// in what is loose around it, damages what is caught inside it on a channel no shield
// lists, and collapses when its time is up.
//
// It is a Projectile so that everything already true of a shot stays true: it is in the
// same list, it is drawn with the rest, it ages out. What it overrides is what it does
// while it lives and what happens when it stops, which is where a well differs from a
// round: nothing stops it by being hit, because it does not hit anything.
//
// It spares whoever fired it while that ship lives, and stops sparing them the moment it
// does not. That is the whole of the pincer being killed by its own singularity: cut the
// hull while the well is up and the halves are wreckage inside a field that no longer
// knows them. Nothing about that case is written down.
// ---------------------------------------------------------------------------
export class Singularity extends Projectile {
  // How much of itself it has become. It arrives as a point and opens out, so everything
  // it does opens out with it: what it pulls, what it bites, how it is drawn and how hard
  // it rings the space behind it. The view reads this too.
  get grown() {
    const grow = this.type.well.grow || 0
    return grow > 0 ? clamp(this.age / grow, 0.05, 1) : 1
  }

  update(dt, game) {
    this.life -= dt
    this.age += dt
    this.steer(dt, game) // it leans after its target, as the orbs do
    // Two of them inside each other's reach pull each other, and nothing in the sector
    // takes that energy back out again: left alone they wind each other up past 4,000
    // units a second, which is fifty times what one is thrown at. They still fall
    // together, which is worth watching; they simply cannot outrun the ship doing the
    // watching. `terminal` is the fastest one is ever seen to move.
    const limit = this.type.well.terminal
    if (limit) {
      const speed = Math.hypot(this.vx, this.vy)
      if (speed > limit) {
        this.vx = (this.vx / speed) * limit
        this.vy = (this.vy / speed) * limit
      }
    }
    this.integrate(dt)
    const well = this.type.well
    const grown = this.grown
    // Everything loose nearby falls toward it, and other people's shots with it.
    game.drawInParticles(this, well.radius * grown, well.pull * grown, dt)
    game.applyRadialForce({
      centre: this,
      radius: well.radius * grown,
      include: ["projectiles"],
      skip: this,
      visit: (shot, { dir, falloff }) => {
        shot.vx -= dir.x * well.pull * grown * falloff * dt
        shot.vy -= dir.y * well.pull * grown * falloff * dt
      },
    })
    // And whatever is caught inside it is being pulled apart. A gravity channel, which no
    // shield blocks: a bubble is no help against the space it is sitting in.
    const owner = this.owner
    const spares = owner && !owner.dead ? owner : null
    game.applyRadialForce({
      centre: this,
      radius: well.bite * grown,
      include: ["asteroids", "rivals", "player"],
      toSurface: true,
      skip: spares,
      visit: (body, { falloff }) => {
        // A rock has no hull to lose, so what a well does to one is what any hard impact
        // does: it comes apart if it cannot hold against what is pulling on it. The
        // measure is the speed the pull would give it in a second, against the material's
        // own limit, so wreckage is torn apart further out than rock is and both go at
        // the middle. One rule, and the same one that governs a piece hitting anything.
        if (body.shatterAt !== undefined) {
          game.impactShatter(body, well.pull * grown * falloff)
          return
        }
        body.takeDamage(well.damage * grown * falloff * dt, game, "gravity", 0, {
          x: this.x,
          y: this.y,
        })
      },
    })
    // Something falling in, always: motes struck off at the rim and thrown inward, so the
    // accretion is visible whether or not the sector happens to have anything loose near
    // it. The pull is real either way; this is what makes it read.
    this.moteBacklog = (this.moteBacklog ?? 0) + well.motes * grown * dt
    while (this.moteBacklog >= 1) {
      this.moteBacklog -= 1
      const angle = Math.random() * TAU
      const away = well.radius * grown * randRange(0.5, 1)
      const inward = well.pull * 0.5
      game.emit(
        this.x + Math.cos(angle) * away,
        this.y + Math.sin(angle) * away,
        -Math.cos(angle) * inward + this.vx,
        -Math.sin(angle) * inward + this.vy,
        0.7,
        Math.random() < 0.25 ? PALETTE.alien.shotCore : PALETTE.alien.beam,
      )
    }
    if (this.life <= 0) {
      this.collapse(game)
    }
  }

  // The well going out: a hard shove on everything close, and a tear in the picture, since
  // this is the one thing in the game that is not made of the game.
  collapse(game) {
    this.dead = true
    const well = this.type.well
    game.applyRadialForce({
      centre: this,
      radius: well.radius,
      include: ["asteroids", "rivals", "player", "oreChunks"],
      toSurface: true,
      visit: (body, { dir, falloff }) => {
        const shove = (well.collapse * falloff) / (body.mass ?? 1)
        body.vx += dir.x * shove
        body.vy += dir.y * shove
      },
    })
    game.burst(this.x, this.y, 44, PALETTE.alien.beam, 60, 320, 0.8)
    game.burst(this.x, this.y, 18, PALETTE.alien.shotCore, 40, 200, 1)
    game.ring(this.x, this.y, 26, PALETTE.fx.flash, 340, 0.6)
    game.glitchAt(this.x, this.y, 1, well.radius * 1.4, 0.45)
    game.screenShake = Math.max(game.screenShake, 16)
    Sound.explode()
  }

  // A hole rather than a light: a dark middle, a bright rim being dragged round it, and
  // the accretion the view sees as a lens.
  // A hole rather than a light: a dark middle with a bright rim, opening out of nothing,
  // and rings running outward from it. The rings are the ripple made visible, so what is
  // drawn and what the space behind it is doing say the same thing.
  draw(renderer) {
    const well = this.type.well
    const grown = this.grown
    const core = well.core * grown
    // Nothing in the middle: not the colour of space but the absence of any, so the stars
    // and the rocks behind it are gone rather than dimmed.
    renderer.circle(this.x, this.y, core * 1.08, { fill: PALETTE.alien.void, glow: 0 })
    renderer.circle(this.x, this.y, core, {
      stroke: PALETTE.alien.shotCore,
      width: 1.4 + 1.6 * grown,
      glow: 16 + 18 * grown,
    })
    // Three rings, each a third of a cycle apart, swelling out and fading as they go.
    for (let ring = 0; ring < 3; ring++) {
      const phase = (this.age * 1.6 + ring / 3) % 1
      renderer.circle(this.x, this.y, core + phase * well.bite * grown, {
        stroke: PALETTE.alien.beam,
        width: 1.4,
        glow: 10,
        alpha: (1 - phase) * 0.55 * grown,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Ore chunk and special pickup (simple drifting collectables).
// ---------------------------------------------------------------------------
// How close a collectable is to expiring, 0 until its last few seconds and 1 as
// it goes. Drives the flash that warns it is about to be lost.
function expiryUrgency(life) {
  return life < CONFIG.EXPIRY_WARN ? clamp(1 - life / CONFIG.EXPIRY_WARN, 0, 1) : 0
}

export class Ore extends Entity {
  constructor(x, y, vx, vy) {
    super(x, y)
    this.vx = vx
    this.vy = vy
    this.spin = randRange(-3, 3)
    this.angle = Math.random() * TAU
    this.life = CONFIG.ORE_LIFE
    this.size = randRange(CONFIG.ORE_SIZE[0], CONFIG.ORE_SIZE[1])
  }

  update(dt, game) {
    this.life -= dt
    const player = game.player,
      dist = Math.hypot(this.x - player.x, this.y - player.y)
    // Whatever is fitted that pulls ore, and how far it reaches: a special with no
    // `pullRange` reaches the whole sector.
    const buffPull = player.buffField("pull", 0)
    const reach = player.buffField("pullRange", Infinity)
    if (game.oreVacuum || (buffPull > 0 && dist < reach)) {
      const pull = normalize(subtract(player, this))
      const force = game.oreVacuum ? CONFIG.ORE_VACUUM_PULL : buffPull
      this.vx += pull.x * force * dt
      this.vy += pull.y * force * dt
    }
    this.vx *= Math.pow(CONFIG.ORE_DRAG, dt)
    this.vy *= Math.pow(CONFIG.ORE_DRAG, dt)
    this.integrate(dt)
    this.angle += this.spin * dt
    this.confine(0.4, this.size)
    if (this.life <= 0) {
      game.burst(this.x, this.y, randInt(5, 8), PALETTE.ore.body, 40, 150, 0.4)
      this.dead = true
    }
  }

  draw(renderer, game) {
    const urgency = expiryUrgency(this.life)
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

export class Special extends Entity {
  constructor(x, y, vx, vy, type) {
    super(x, y)
    this.vx = vx
    this.vy = vy
    this.type = type
    this.angle = 0
    this.life = CONFIG.SPECIAL_LIFE
    // Seconds before it can be picked up. One that spawned in the sector is live
    // at once; one just thrown overboard has to clear the ship first.
    this.arming = 0
    // Velocity retained per second. One drifting in from off-screen keeps coming;
    // one thrown overboard slows, so it lands within reach of where it was let go.
    this.drag = 1
  }

  update(dt, game) {
    this.life -= dt
    this.arming = Math.max(0, this.arming - dt)
    this.angle += dt * 1.4
    this.vx *= Math.pow(this.drag, dt)
    this.vy *= Math.pow(this.drag, dt)
    this.integrate(dt)
    // A special is something to come back for, so it bounces off the arena wall
    // instead of leaving the sector.
    this.confine(0.5, 24)
    if (this.life <= 0) {
      const spec = SPECIAL_TYPES[this.type]
      game.burst(this.x, this.y, randInt(10, 16), spec.colour, 40, 170, 0.5)
      game.ring(this.x, this.y, 10, spec.colour, 90, 0.4)
      this.dead = true
    }
  }

  draw(renderer, game) {
    const spec = SPECIAL_TYPES[this.type]
    // Two flashes with nothing to do with each other: one still arming cannot be
    // picked up, and one near the end of its life is about to be lost.
    const urgency = expiryUrgency(this.life)
    const flash = urgency * (0.5 + 0.5 * Math.sin(game.gameTime * (7 + urgency * 36)))
    const alpha = this.arming > 0 ? 0.35 + 0.4 * (Math.sin(game.gameTime * 22) + 1) * 0.5 : 1
    const colour = mixColour(spec.colour, PALETTE.white, flash),
      pts = []
    for (let i = 0; i < 6; i++) {
      const a = this.angle + (i / 6) * TAU
      pts.push({ x: this.x + Math.cos(a) * 12, y: this.y + Math.sin(a) * 12 })
    }
    renderer.strokePoly(pts, {
      color: colour,
      width: 1.7 + 0.8 * flash,
      glow: 14 + 12 * flash,
      alpha,
    })
    renderer.text(spec.icon, this.x, this.y, {
      size: 12,
      color: colour,
      align: "center",
      baseline: "middle",
      bold: true,
      glow: 14,
      alpha,
    })
    this.#label(renderer, game, spec, alpha)
  }

  // Name it on a leader line for a ship close enough to be going for it, so a
  // pickup does not have to be recognised by its letter. Help text is a setting,
  // and it takes the HUD's scale since it is there to be read.
  #label(renderer, game, spec, alpha) {
    const player = game.player
    if (!game.settings.help || !player || !game.canFly()) {
      return
    }
    const range = CONFIG.SPECIAL_LABEL_RANGE
    const distance = Math.hypot(this.x - player.x, this.y - player.y)
    if (distance > range) {
      return
    }
    const scale = game.settings.uiScale
    const fade = clamp((1 - distance / range) * 2.5, 0, 1) * alpha
    const rise = 20 * scale,
      run = 14 * scale
    const cornerX = this.x + rise,
      cornerY = this.y - rise
    renderer.line(this.x + 9, this.y - 9, cornerX, cornerY, {
      color: spec.colour,
      width: 1,
      alpha: fade * 0.8,
    })
    renderer.line(cornerX, cornerY, cornerX + run, cornerY, {
      color: spec.colour,
      width: 1,
      alpha: fade * 0.8,
    })
    renderer.text(spec.label, cornerX + run + 4 * scale, cornerY + 3 * scale, {
      size: 10 * scale,
      color: spec.colour,
      baseline: "middle",
      glow: 6,
      alpha: fade,
    })
  }
}
