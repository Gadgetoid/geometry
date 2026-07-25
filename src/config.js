// Configuration and balance. Everything tuneable lives here.
//
// The combat model is uniform for every host (player, rival, asteroid):
//   * a host has an ENERGY pool (+ regen)
//   * WEAPONS are modules mounted on hardpoints; firing costs energy
//   * a SHIELD module means "incoming damage drains energy instead of hull
//     until energy hits zero, then the shield is down"
//   * a CONTROLLER decides when a mounted weapon fires
// New weapons/ships/shields/powerups are added by editing the registries below.
// A registry entry may carry an `apply` function; it drives the effect through
// the public Game API so the whole definition stays in one place.

import { normalize, randRange, subtract } from "./math.js"
import { PALETTE } from "./palette.js"

export const VIEW_W = 1024
export const VIEW_H = 640
export const TAU = Math.PI * 2

// The play field is a circle larger than the viewport. The camera follows the
// ship; outside the circle is an out-of-bounds zone that confines the player
// and repels asteroids back in.
export const ARENA = { cx: VIEW_W / 2, cy: VIEW_H / 2, radius: 860 }

// The dev button gives free purchases and lets you jump to any sector, so it is
// offered while developing locally and on an explicit ?dev, but not on a
// published build.
export const DEV_VISIBLE =
  typeof location === "undefined" ||
  location.protocol === "file:" ||
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1" ||
  new URLSearchParams(location.search).has("dev")
export const SHIELD_SPARK = PALETTE.shield.spark // ring colour when a shield takes a hit

export const CONFIG = {
  // player movement / feel
  ROT: 3.2,
  ACCEL: 270,
  MAX_SPEED: 340,
  SPEED_DRAG: 0.85,
  THRUST_COST: 21, // energy/sec while thrusting
  CORE_MAX: [320, 520, 760, 1000], // player energy capacity by power-core level
  PLAYER_REGEN: [32, 53, 74, 95], // energy regen/sec by power-core level (raises back to full)
  INVIN_TIME: 2.0,
  START_LIVES: 3,
  MAX_LIVES: 6,
  REVERSE_ACCEL_MULT: 0.6, // reverse thrust is weaker than forward
  BOUNDARY_RESTITUTION: 0.35, // bounce off the arena wall
  ROCK_RESTITUTION: 0.5, // bounce off an asteroid
  ROCK_GRIND_DAMAGE: 3.6, // multiplies DMG_AST_GUN per second of contact
  ROCK_IMPACT_DAMAGE: 0.55, // damage per unit of closing speed on the bounce
  ROCK_IMPACT_COOLDOWN: 0.25, // seconds before another bounce can land its knock
  EXHAUST_WASH_RANGE: 150, // thruster wash shoves rocks caught behind the ship
  EXHAUST_WASH_FORCE: 160,
  TURRET_AIM_RATE: 3.0, // radians/sec while swinging the turret by hand
  TURRET_MANUAL_HOLD: 1.5, // seconds of manual control after the last input
  ORE_GRAB_RADIUS: 8, // added to the ship radius when collecting ore
  ORE_VACUUM_GRAB_RADIUS: 42, // wider grab while sweeping a cleared sector

  // asteroids
  AST_MAX_R: 100,
  AST_MIN_AREA: 3300, // a cut piece smaller than this shatters straight to ore
  // Ship hulls are far smaller than rocks, so their cut halves get their own,
  // lower threshold; otherwise a sliced frigate would only ever leave ore.
  SHIP_DEBRIS_MIN_AREA: 1650,
  AST_MAX_SPEED: 340,
  AST_MAX_RIM_SPEED: 340, // how fast a rock's edge may sweep, spin cap = this / boundRadius
  SPLIT_IMPULSE: 55, // gentle push so cut halves drift apart, not fling
  ORE_ENERGY: 9, // energy refunded per ore collected
  ORE_SCORE: 120,
  // Ore yield: one chunk per this much rock area, for a sub-minimum cut piece
  // and for a whole rock shattered by a blast. Both scale with AST_MIN_AREA, so
  // a piece just under the threshold still yields a handful rather than the cap.
  ORE_PER_FRAGMENT_AREA: 1240,
  ORE_PER_ROCK_AREA: 3600,
  ORE_PASSIVE_PULL: 120, // attraction inside the ship's magnet radius
  ORE_VACUUM_PULL: 560, // attraction while sweeping up a cleared sector
  SLICE_SCORE: 15,
  BLAST_R: 160,
  BLAST_IMPULSE: 280,
  BLAST_DAMAGE: 300,
  BULLET_SPEED: 250,
  AST_REGEN: 12, // shielded/armed rocks recover energy slowly
  AST_ENERGY_SHIELD: 100,
  AST_ENERGY_GUN: 50,
  // Contact resolution between rocks: overlap below CONTACT_SLOP is left alone
  // so resting pairs do not jitter, and only CONTACT_BIAS of the rest is undone
  // each frame so a contact eases apart instead of snapping.
  CONTACT_SLOP: 0.5,
  CONTACT_BIAS: 0.35,
  AST_MASS_AREA: 3200, // rock area per unit of mass, for collision response
  AST_DRAG: 0.985, // velocity retained per second
  AST_SPIN_DRAG: 0.82,
  AST_BOUNDARY_BOUNCE: 1.9, // rocks are repelled hard off the arena wall
  ORE_LIFE: 24, // seconds before an uncollected chunk expires
  POWERUP_LIFE: 26,

  // camera, pacing and end-of-sector scoring
  CAMERA_FOLLOW: 6, // how quickly the view eases toward the ship
  CAMERA_MARGIN: 140, // how far inside the arena edge the view stops
  CLEAR_DELAY: 2.4, // seconds of ore sweep-up after the last rock
  TOAST_TIME: 2.6,
  ACCURACY_BONUS: 500, // scaled by hit fraction
  FLAWLESS_BONUS: 800, // for taking no damage
  CLEAR_BONUS_PER_SECTOR: 150,

  // base damage values referenced by weapon types
  DMG_AST_GUN: 120,
  DMG_RIVAL_GUN: 130,
  DMG_FRIGATE_LASER: 300,

  // upgrade effects, indexed by upgrade level
  SHIELD_EFFICIENCY: [1, 0.72, 0.5, 0.32], // energy drained per point of damage (player shield plating)
  MAGNET_RANGE: [62, 120, 190, 270],
  LASER_RATE_MULT: [1, 1.45, 1.45, 1.45],
  LASER_COST_MULT: [1, 1, 0.55, 0.55],
  LASER_INSTA_CHANCE: [0, 0, 0, 0.5],
}

// ---------------------------------------------------------------------------
// ASTEROID SHAPE - how makeAsteroidPolygon builds a silhouette. It hulls a ring
// of points around each of `lobes` overlapping circles, so one lobe gives a
// rounded rock and three give something lumpy and elongated. Widen `lobeSpread`
// for longer, more angular rocks; raise `pointsPerLobe` for smoother outlines.
// `areaFactor` is how much of pi * radius^2 the finished hull fills, and the
// hull is scaled to hit it exactly, so shape and size stay independent.
// ---------------------------------------------------------------------------
export const AST_SHAPE = {
  lobes: [1, 3],
  firstLobeRadius: [0.75, 1], // fraction of the requested radius
  lobeRadius: [0.35, 0.9],
  lobeSpread: [0.5, 1.05], // centre separation, as a fraction of the two radii summed
  pointsPerLobe: [4, 6], // few points per lobe keeps the outline faceted
  angleJitter: 0.28, // radians, so the ring is not evenly spaced
  radiusJitter: [0.78, 1.08],
  areaFactor: 0.84,
}

// ---------------------------------------------------------------------------
// WEAPON TYPES - guns and lasers, shared by every host. A weapon is either a
// 'projectile' or a 'beam'. `energy` is spent per shot. Beams may be
// `chargeable` (the player's main laser); AI beams fire at a fixed length.
// `sound` names a Sound method and `shotLife` how long the flash lingers.
// ---------------------------------------------------------------------------
export const WEAPON_TYPES = {
  blaster: {
    kind: "projectile",
    damage: CONFIG.DMG_AST_GUN,
    energy: 6,
    reload: 2.4,
    speed: CONFIG.BULLET_SPEED,
    colour: PALETTE.weapon.gun,
  },
  autocannon: {
    kind: "projectile",
    damage: CONFIG.DMG_RIVAL_GUN,
    energy: 8,
    reload: [1.1, 1.9], // range so multiple turrets drift out of sync
    speed: CONFIG.BULLET_SPEED,
    colour: PALETTE.weapon.gun,
  },
  minerLaser: {
    kind: "beam",
    damage: 30,
    energy: 16,
    reload: [1.4, 2.6],
    length: [320, 520],
    width: 2.4,
    glow: 16,
    colour: PALETTE.rival.minerBeam,
  },
  cannonLaser: {
    kind: "beam",
    damage: CONFIG.DMG_FRIGATE_LASER,
    energy: 70,
    reload: [2.4, 3.8],
    length: 560,
    width: 26,
    glow: 30,
    arc: 0.42,
    chargeTime: 0.9, // telegraphs with a growing glow before firing
    sound: "bigLaser",
    shotLife: 0.55, // the flash lingers longer than an ordinary beam
    colour: PALETTE.rival.cannonBeam,
  },
  defenseLaser: {
    kind: "beam",
    damage: 30,
    energy: 10,
    reload: 4.6,
    range: 230,
    width: 2.4,
    glow: 14,
    colour: PALETTE.player.turret,
  },
  playerLaser: {
    kind: "beam",
    chargeable: true,
    damage: 38,
    colour: PALETTE.player.beam,
    width: 2.4,
    glow: 16,
    reload: 0.12,
    chargeRate: 720,
    chargeMax: 640,
    chargeMin: 95,
    chargeCost: 150,
  },
}

// ---------------------------------------------------------------------------
// SHIELD TYPES - a shield turns incoming damage into energy drain (efficiency)
// for the damage channels it `blocks`. e.g. a deflector stops shots but not
// lasers. A new channel needs no change here beyond listing it.
// ---------------------------------------------------------------------------
// A shield overloads (switches off) when energy falls to `dropAt` of the host's
// capacity, and only comes back once `recoverDelay` seconds have passed AND
// energy has recharged to `recoverAt`. The player's shield drops only at empty
// and recovers instantly, so its behaviour matches the old energy bar.
export const SHIELD_TYPES = {
  standard: {
    efficiency: 1,
    blocks: ["laser", "projectile"],
    sides: 6,
    colour: PALETTE.shield.standard,
    dropAt: 0.18,
    recoverAt: 0.6,
    recoverDelay: 3,
  },
  deflector: {
    efficiency: 1,
    blocks: ["projectile"],
    sides: 6,
    colour: PALETTE.shield.deflector,
    dropAt: 0.18,
    recoverAt: 0.55,
    recoverDelay: 2,
  },
  player: {
    efficiency: 1,
    blocks: ["laser", "projectile"],
    sides: 6,
    colour: PALETTE.shield.standard,
    dropAt: 0.15,
    recoverAt: 0.35,
    recoverDelay: 1.2,
  },
}

// ---------------------------------------------------------------------------
// SHIP TYPES - outline + a few numbers. `hardpoints` are attachment slots in
// local space (role is documentation); `loadout` mounts modules onto them by
// index. `arms` are optional modules the spawner rolls, each with a per-sector
// chance that ramps from the type's spawn sector up to its cap.
//
// The spawner reads `spawn`: a type with a `chance` is rolled once its
// `fromSector` is reached, up to `maxConcurrent` alive at a time; the type
// marked `fallback` is spawned when nothing else is picked.
//
// The rest describes how a type differs in play, so no code tests a ship by
// name: `hullWidth` is its outline weight, `sliceable` says an unshielded hull
// is cut in two by a beam rather than blocking it, and `debris` sizes the
// explosion.
// ---------------------------------------------------------------------------
export const FRIGATE_SHAPE = [
  [1.7, 0.55],
  [0.55, 0.55],
  [0.42, 0.2],
  [-0.42, 0.2],
  [-0.55, 0.55],
  [-1.7, 0.55],
  [-1.7, -0.55],
  [-0.55, -0.55],
  [-0.42, -0.2],
  [0.42, -0.2],
  [0.55, -0.55],
  [1.7, -0.55],
]

export const SHIP_TYPES = {
  scout: {
    outline: [
      [1.4, 0],
      [-0.9, -1.0],
      [-0.5, 0],
      [-0.9, 1.0],
    ],
    colour: PALETTE.rival.hull,
    size: 12,
    accel: 140,
    maxSpeed: 190,
    turnRate: 2.6,
    drag: 0.4,
    exhaustFactor: 1.17,
    lifeTime: [16, 26],
    energyMax: 90,
    regen: 22,
    hardpoints: [
      { local: [1.4, 0], role: "nose" },
      { local: [0.2, 0], role: "gun" },
      { local: [0, 0], role: "core" },
    ],
    loadout: [{ hp: 0, weapon: "minerLaser", controller: "miner" }], // always has a mining laser
    arms: {
      gun: {
        hp: 1,
        weapon: "autocannon",
        controller: "turret",
        chancePerSector: 0.15,
        chanceCap: 0.85,
      },
      shield: { hp: 2, shield: "standard", chancePerSector: 0.12, chanceCap: 0.8 },
    },
    spawn: { fromSector: 4, fallback: true },
    hullWidth: 1.8,
    sliceable: false,
    debris: { particles: 26, speed: 240, ring: 18, shake: 10 },
    killScore: 400,
    blastScore: 200,
    oreDrop: 5,
    hull: 80, // survives a couple of laser hits once its shield is down
  },
  frigate: {
    outline: FRIGATE_SHAPE,
    colour: PALETTE.rival.frigateHull,
    size: 40,
    accel: 32,
    maxSpeed: 44,
    turnRate: 0.17,
    drag: 0.94,
    exhaustFactor: 1.7,
    lifeTime: [34, 50],
    energyMax: 260,
    regen: 30,
    hardpoints: [
      { local: [1.7, 0], role: "nose" },
      { local: [1.13, -0.53], role: "gun" },
      { local: [-1.13, -0.53], role: "gun" },
      { local: [1.13, 0.53], role: "gun" },
      { local: [-1.13, 0.53], role: "gun" },
      { local: [0, 0], role: "core" },
    ],
    loadout: [
      { hp: 0, weapon: "cannonLaser", controller: "hunter" },
      { hp: 1, weapon: "autocannon", controller: "turret" },
      { hp: 2, weapon: "autocannon", controller: "turret" },
      { hp: 3, weapon: "autocannon", controller: "turret" },
      { hp: 4, weapon: "autocannon", controller: "turret" },
      { hp: 5, shield: "standard" },
    ],
    spawn: { fromSector: 6, chance: 0.3, maxConcurrent: 1 },
    hullWidth: 2,
    sliceable: true, // an unshielded hull is cut in two like a rock
    debris: { particles: 40, speed: 300, ring: 26, shake: 14 },
    killScore: 900,
    blastScore: 500,
    oreDrop: 9,
    hull: 320, // mostly relevant to blasts; an unshielded frigate is sliced, not shot
  },
}

// Player ship definition (its own type so the same machinery drives it).
export const PLAYER_TYPE = {
  outline: [
    [1.4, 0],
    [-0.8, -0.85],
    [-0.4, 0],
    [-0.8, 0.85],
  ],
  colour: PALETTE.player.hull,
  size: 13,
  hardpoints: [
    { local: [1.4, 0], role: "nose" },
    { local: [0, 0], role: "core" },
    { local: [0.2, 0], role: "aux" }, // defense turret slot (added by upgrade)
  ],
  loadout: [
    { hp: 0, weapon: "playerLaser", controller: "manual" },
    { hp: 1, shield: "player" },
  ],
}

// ---------------------------------------------------------------------------
// POWERUP TYPES - one entry per collectable. Fields:
//   label   name shown in the pickup toast
//   short   name shown in the active-buff list (omit to reuse `label`)
//   icon    single character drawn on the pickup and in the inventory slot
//   colour  pickup outline, inventory slot and buff text
//   seconds how long the effect lasts; omit for an instant effect
//   apply   optional immediate effect, run on use
// A timed powerup records its remaining seconds in player.buffs, which the
// gameplay code reads through player.buffTime(id).
// ---------------------------------------------------------------------------
export const POWERUP_TYPES = {
  repel: {
    label: "REPEL",
    icon: "R",
    colour: PALETTE.powerup.repel,
    impulse: 300,
    apply: (game, player, type) => {
      for (const asteroid of game.asteroids) {
        const d = normalize(subtract(asteroid.center, player))
        asteroid.vx += d.x * type.impulse
        asteroid.vy += d.y * type.impulse
        asteroid.spin += randRange(-3, 3)
      }
      for (const bullet of game.projectiles) {
        const d = normalize(subtract(bullet, player))
        const speed = Math.max(CONFIG.BULLET_SPEED, Math.hypot(bullet.vx, bullet.vy))
        bullet.vx = d.x * speed
        bullet.vy = d.y * speed
      }
      game.ring(player.x, player.y, 40, type.colour, 260, 0.7)
      game.screenShake = 9
    },
  },
  refuel: {
    label: "REFUEL",
    icon: "F",
    colour: PALETTE.powerup.refuel,
    apply: (game, player, type) => {
      player.energy = game.maxEnergy()
      game.ring(player.x, player.y, 24, type.colour, 150, 0.6)
    },
  },
  booster: {
    label: "BOOSTER",
    short: "BOOST",
    icon: "B",
    colour: PALETTE.powerup.booster,
    seconds: 6.5,
    beamLengthMult: 1.6, // charged shots reach further and cost nothing
    apply: (game, player, type) => {
      game.burst(player.x, player.y, 20, type.colour, 40, 140, 0.6)
    },
  },
  multi: {
    label: "MULTI-LASER",
    short: "MULTI",
    icon: "L",
    colour: PALETTE.powerup.multi,
    seconds: 9,
    beamOffsets: [-28, 0, 28], // parallel beams either side of the nose
  },
  magnet: {
    label: "ORE MAGNET",
    short: "MAGNET",
    icon: "M",
    colour: PALETTE.powerup.magnet,
    seconds: 6.5,
    pull: 260,
  },
}

export const POWERUP_IDS = Object.keys(POWERUP_TYPES)

// Maximum powerup slots the ship can be fitted with.
const MAX_SLOTS = 4

export function freshUpgrades() {
  return { slots: 1, core: 0, shield: 0, laser: 0, magnet: 0, turret: false, reverse: false }
}

// ---------------------------------------------------------------------------
// SHOP - one entry per purchasable upgrade, in menu order. Fields:
//   id      key into game.upgrades
//   name    menu label, desc the one-line explanation under it
//   max     highest level for a levelled upgrade; omit for a one-off fitting
//   cost    ore price, given the current game state
//   apply   what buying it does
// A levelled upgrade takes its cap from the effect table it indexes, so adding
// a level means extending that array and nothing else.
// ---------------------------------------------------------------------------
const levelled = (id, name, desc, max, cost, apply) => ({
  id,
  name,
  desc,
  max,
  cost: (g) => cost(g.upgrades[id]),
  info: (g) => `LV ${g.upgrades[id]} / ${max}`,
  maxed: (g) => g.upgrades[id] >= max,
  apply: (g) => {
    g.upgrades[id]++
    if (apply) {
      apply(g)
    }
  },
})

const fitting = (id, name, desc, price, apply) => ({
  id,
  name,
  desc,
  cost: () => price,
  info: (g) => (g.upgrades[id] ? "INSTALLED" : "-"),
  maxed: (g) => g.upgrades[id],
  apply: (g) => {
    g.upgrades[id] = true
    if (apply) {
      apply(g)
    }
  },
})

export const SHOP = [
  levelled(
    "core",
    "POWER CORE",
    "Bigger energy cell: more shields and more laser charge.",
    CONFIG.CORE_MAX.length - 1,
    (level) => 45 + level * 55,
    (g) => {
      if (g.player) {
        g.player.energyMax = g.maxEnergy()
        g.player.energy = g.player.energyMax
      }
    },
  ),
  {
    id: "life",
    name: "EXTRA LIFE",
    desc: "One more spare ship.",
    info: (g) => `${g.lives} / ${CONFIG.MAX_LIVES}`,
    cost: () => 60,
    maxed: (g) => g.lives >= CONFIG.MAX_LIVES,
    apply: (g) => {
      g.lives++
    },
  },
  {
    id: "slot",
    name: "POWERUP SLOT",
    desc: "Carry another powerup at once (keys 1-4).",
    info: (g) => `${g.upgrades.slots} / ${MAX_SLOTS}`,
    cost: (g) => 30 * g.upgrades.slots,
    maxed: (g) => g.upgrades.slots >= MAX_SLOTS,
    apply: (g) => {
      g.upgrades.slots++
    },
  },
  levelled(
    "shield",
    "SHIELD PLATING",
    "Your shield drains less energy per hit.",
    CONFIG.SHIELD_EFFICIENCY.length - 1,
    (level) => 40 + level * 45,
  ),
  levelled(
    "laser",
    "LASER SYSTEM",
    "Lv1 charges faster, Lv2 costs less energy, Lv3 may shatter a rock straight to ore.",
    CONFIG.LASER_RATE_MULT.length - 1,
    (level) => 45 + level * 45,
  ),
  levelled(
    "magnet",
    "ORE MAGNET",
    "Wider passive ore attraction, no powerup needed.",
    CONFIG.MAGNET_RANGE.length - 1,
    (level) => 35 + level * 35,
  ),
  fitting(
    "turret",
    "DEFENSE TURRET",
    "A nose turret that auto-fires on rocks that drift close.",
    85,
    (g) => {
      if (g.player) {
        g.player.installDefenseTurret()
      }
    },
  ),
  fitting("reverse", "REVERSE THRUST", "Forward thrusters: hold DOWN or S to back away.", 55),
]
