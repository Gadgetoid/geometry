// Configuration and balance. Everything tuneable lives here.
//
// The combat model is uniform for every host (player, rival, asteroid):
//   * a host has an ENERGY pool (+ regen)
//   * WEAPONS are modules mounted on hardpoints; firing costs energy
//   * a SHIELD module means "incoming damage drains energy instead of hull
//     until energy hits zero, then the shield is down"
//   * a CONTROLLER decides when a mounted weapon fires
// New weapons/ships/shields are added by editing the registries below.

export const VIEW_W = 1024
export const VIEW_H = 640
export const TAU = Math.PI * 2

// The play field is a circle larger than the viewport. The camera follows the
// ship; outside the circle is an out-of-bounds zone that confines the player
// and repels asteroids back in.
export const ARENA = { cx: VIEW_W / 2, cy: VIEW_H / 2, radius: 860 }
export const MONO_FONT = "ui-monospace,Menlo,monospace"
export const DEV_VISIBLE = true
export const SHIELD_SPARK = "#9fe8ff" // ring colour when a shield takes a hit

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

  // asteroids
  AST_MIN_R: 26,
  AST_MAX_R: 60,
  AST_MIN_AREA: 1650,
  AST_MAX_SPEED: 340,
  SPLIT_IMPULSE: 55, // gentle push so cut halves drift apart, not fling
  ORE_ENERGY: 9, // energy refunded per ore collected
  ORE_SCORE: 120,
  SLICE_SCORE: 15,
  BLAST_R: 160,
  BLAST_IMPULSE: 280,
  BLAST_DAMAGE: 300,
  BULLET_SPEED: 250,
  AST_REGEN: 12, // shielded/armed rocks recover energy slowly
  AST_ENERGY_SHIELD: 100,
  AST_ENERGY_GUN: 50,

  // base damage values referenced by weapon types
  DMG_AST_GUN: 120,
  DMG_RIVAL_GUN: 130,
  DMG_FRIGATE_LASER: 300,

  // rival arming ramp (per sector, for the basic scout)
  RIVAL_FROM_SECTOR: 4,
  FRIGATE_FROM_SECTOR: 6,
  RIVAL_SHIELD_CHANCE: 0.12,
  RIVAL_SHIELD_CHANCE_CAP: 0.8,
  RIVAL_GUN_CHANCE: 0.15,
  RIVAL_GUN_CHANCE_CAP: 0.85,

  // upgrade effects, indexed by upgrade level
  SHIELD_EFFICIENCY: [1, 0.72, 0.5, 0.32], // energy drained per point of damage (player shield plating)
  MAGNET_RANGE: [62, 120, 190, 270],
  LASER_RATE_MULT: [1, 1.45, 1.45, 1.45],
  LASER_COST_MULT: [1, 1, 0.55, 0.55],
  LASER_INSTA_CHANCE: [0, 0, 0, 0.5],
}

// ---------------------------------------------------------------------------
// WEAPON TYPES - guns and lasers, shared by every host. A weapon is either a
// 'projectile' or a 'beam'. `energy` is spent per shot. Beams may be
// `chargeable` (the player's main laser); AI beams fire at a fixed length.
// ---------------------------------------------------------------------------
export const WEAPON_TYPES = {
  blaster: {
    kind: "projectile",
    damage: CONFIG.DMG_AST_GUN,
    energy: 6,
    reload: 2.4,
    speed: CONFIG.BULLET_SPEED,
    colour: "#ffb14b",
  },
  autocannon: {
    kind: "projectile",
    damage: CONFIG.DMG_RIVAL_GUN,
    energy: 8,
    reload: [1.1, 1.9], // range so multiple turrets drift out of sync
    speed: CONFIG.BULLET_SPEED,
    colour: "#ffb14b",
  },
  minerLaser: {
    kind: "beam",
    damage: 30,
    energy: 16,
    reload: [1.4, 2.6],
    length: [320, 520],
    width: 2.4,
    glow: 16,
    colour: "#ffb060",
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
    colour: "#ff4d6d",
  },
  defenseLaser: {
    kind: "beam",
    damage: 30,
    energy: 10,
    reload: 4.6,
    range: 230,
    width: 2.4,
    glow: 14,
    colour: "#9ff5c8",
  },
  playerLaser: {
    kind: "beam",
    chargeable: true,
    damage: 38,
    colour: "#eaf4ff",
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
// for the channels it blocks. e.g. a deflector stops shots but not lasers.
// ---------------------------------------------------------------------------
// A shield overloads (switches off) when energy falls to `dropAt` of the host's
// capacity, and only comes back once `recoverDelay` seconds have passed AND
// energy has recharged to `recoverAt`. The player's shield drops only at empty
// and recovers instantly, so its behaviour matches the old energy bar.
export const SHIELD_TYPES = {
  standard: {
    efficiency: 1,
    blocksLaser: true,
    blocksProjectile: true,
    sides: 6,
    colour: "#9fe8ff",
    dropAt: 0.18,
    recoverAt: 0.6,
    recoverDelay: 3,
  },
  deflector: {
    efficiency: 1,
    blocksLaser: false,
    blocksProjectile: true,
    sides: 6,
    colour: "#b8f0ff",
    dropAt: 0.18,
    recoverAt: 0.55,
    recoverDelay: 2,
  },
  player: {
    efficiency: 1,
    blocksLaser: true,
    blocksProjectile: true,
    sides: 6,
    colour: "#9fe8ff",
    dropAt: 0.15,
    recoverAt: 0.35,
    recoverDelay: 1.2,
  },
}

// ---------------------------------------------------------------------------
// SHIP TYPES - outline + a few numbers. `hardpoints` are attachment slots in
// local space (role is documentation); `loadout` mounts modules onto them by
// index. A scout leaves its gun/shield slots empty for the spawner to roll.
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
    colour: "#ff9a3c",
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
      gun: { hp: 1, weapon: "autocannon", controller: "turret" },
      shield: { hp: 2, shield: "standard" },
    },
    killScore: 400,
    blastScore: 200,
    oreDrop: 5,
  },
  frigate: {
    outline: FRIGATE_SHAPE,
    colour: "#ff8a3c",
    size: 40,
    accel: 32,
    maxSpeed: 44,
    turnRate: 0.28,
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
    killScore: 900,
    blastScore: 500,
    oreDrop: 9,
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
  colour: "#5fd7ff",
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

export const POWERUP_TYPES = ["repel", "refuel", "booster", "multi", "magnet"]
export const POWERUP_LABEL = {
  repel: "REPEL",
  refuel: "REFUEL",
  booster: "BOOSTER",
  multi: "MULTI-LASER",
  magnet: "ORE MAGNET",
}
export const POWERUP_COLOUR = {
  repel: "#ff6bd0",
  refuel: "#57e39a",
  booster: "#ffcf5c",
  multi: "#5fd7ff",
  magnet: "#b38bff",
}

export function freshUpgrades() {
  return { slots: 1, core: 0, shield: 0, laser: 0, magnet: 0, turret: false, reverse: false }
}

export const SHOP = [
  {
    id: "core",
    name: "POWER CORE",
    info: (g) => `LV ${g.upgrades.core} / 3`,
    cost: (g) => 45 + g.upgrades.core * 55,
    maxed: (g) => g.upgrades.core >= 3,
    apply: (g) => {
      g.upgrades.core++
      if (g.player) {
        g.player.energyMax = g.maxEnergy()
        g.player.energy = g.player.energyMax
      }
    },
  },
  {
    id: "life",
    name: "EXTRA LIFE",
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
    info: (g) => `${g.upgrades.slots} / 4`,
    cost: (g) => 30 * g.upgrades.slots,
    maxed: (g) => g.upgrades.slots >= 4,
    apply: (g) => {
      g.upgrades.slots++
    },
  },
  {
    id: "shield",
    name: "SHIELD PLATING",
    info: (g) => `LV ${g.upgrades.shield} / 3`,
    cost: (g) => 40 + g.upgrades.shield * 45,
    maxed: (g) => g.upgrades.shield >= 3,
    apply: (g) => {
      g.upgrades.shield++
    },
  },
  {
    id: "laser",
    name: "LASER SYSTEM",
    info: (g) => `LV ${g.upgrades.laser} / 3`,
    cost: (g) => 45 + g.upgrades.laser * 45,
    maxed: (g) => g.upgrades.laser >= 3,
    apply: (g) => {
      g.upgrades.laser++
    },
  },
  {
    id: "magnet",
    name: "ORE MAGNET",
    info: (g) => `LV ${g.upgrades.magnet} / 3`,
    cost: (g) => 35 + g.upgrades.magnet * 35,
    maxed: (g) => g.upgrades.magnet >= 3,
    apply: (g) => {
      g.upgrades.magnet++
    },
  },
  {
    id: "turret",
    name: "DEFENSE TURRET",
    info: (g) => (g.upgrades.turret ? "INSTALLED" : "-"),
    cost: () => 85,
    maxed: (g) => g.upgrades.turret,
    apply: (g) => {
      g.upgrades.turret = true
      if (g.player) {
        g.player.installDefenseTurret()
      }
    },
  },
  {
    id: "reverse",
    name: "REVERSE THRUST",
    info: (g) => (g.upgrades.reverse ? "INSTALLED" : "-"),
    cost: () => 55,
    maxed: (g) => g.upgrades.reverse,
    apply: (g) => {
      g.upgrades.reverse = true
    },
  },
]
export const SHOP_DESC = {
  core: "Bigger energy cell: more shields and more laser charge.",
  life: "One more spare ship.",
  slot: "Carry another powerup at once (keys 1-4).",
  shield: "Your shield drains less energy per hit.",
  laser: "Lv1 charges faster, Lv2 costs less energy, Lv3 may shatter a rock straight to ore.",
  magnet: "Wider passive ore attraction, no powerup needed.",
  turret: "A nose turret that auto-fires on rocks that drift close.",
  reverse: "Forward thrusters: hold DOWN or S to back away.",
}
