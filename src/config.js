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

import { clamp, normalize, randRange, subtract } from "./math.js"
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
  CORE_MAX: [320, 520, 760, 1000, 1260], // player energy capacity by power-core level
  PLAYER_REGEN: [32, 53, 74, 95, 116], // energy regen/sec by power-core level (raises back to full)
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
  OFFSCREEN_FIRE_MARGIN: 40, // enemies hold fire this far beyond the view edge
  CUT_EDGE_TOLERANCE: 0.5, // world units, for spotting vertices left on a cut line

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
  BLAST_KNOCK_PLAYER: 300, // speed a blast at zero range adds to the ship
  BLAST_KNOCK_RIVAL: 220,
  BULLET_SPEED: 250,
  BULLET_LIFE: 4, // seconds before a shot expires
  BULLET_ESCAPE_MARGIN: 30, // how far past the boundary a shot survives
  AST_REGEN: 12, // shielded/armed rocks recover energy slowly
  AST_ENERGY_SHIELD: 100,
  AST_ENERGY_GUN: 50,
  // Contact resolution between bodies: overlap below CONTACT_SLOP is left alone
  // so resting pairs do not jitter, and only CONTACT_BIAS of the rest is undone
  // each frame so a contact eases apart instead of snapping. The solver runs
  // CONTACT_ITERATIONS sweeps per frame, so a body wedged against two others is
  // separated from both instead of alternating between them.
  CONTACT_SLOP: 0.5,
  CONTACT_BIAS: 0.35,
  CONTACT_ITERATIONS: 4,
  AST_MASS_AREA: 3200, // rock area per unit of mass, for collision response
  // Clamp on the mass a rock's area may imply, as a guard against extremes. It
  // has to stay clear of what a sector actually spawns: those run 4.3 to 8.2, so
  // a ceiling of 4 put every last one of them on it and made every rock in the
  // field weigh exactly the same, whatever its size.
  AST_MASS_RANGE: [0.4, 9],
  SHIP_RESTITUTION: 0.3, // bounce between two hulls
  RIVAL_ENTRY_MARGIN: 80, // how far past its own hull a rival starts, outside the boundary
  RIVAL_EXIT_MARGIN: 200, // how far outside the boundary a departing rival steers for
  // How far past the view edge a departing rival must be before it is dropped. It
  // has to be clear of the arena as well, so this only sets the extra slack beyond
  // the screen; the arena is larger than the view, so either can be the last to
  // come true depending on where the camera sits.
  RIVAL_DESPAWN_MARGIN: 140,
  RIVAL_ORE_INTEREST: 340, // a rival diverts for ore within this range
  RIVAL_ORE_GRAB: 18,
  AST_DRAG: 0.985, // velocity retained per second
  AST_SPIN_DRAG: 0.82,
  AST_BOUNDARY_BOUNCE: 1.9, // rocks are repelled hard off the arena wall
  ORE_LIFE: 24, // seconds before an uncollected chunk expires
  ORE_DRAG: 0.55, // velocity retained per second
  ORE_SIZE: [4, 6.5],
  POWERUP_LIFE: 26,

  // camera, pacing and end-of-sector scoring
  CAMERA_FOLLOW: 6, // how quickly the view eases toward the ship
  CAMERA_MARGIN: 140, // how far inside the arena edge the view stops
  CLEAR_DELAY: 12, // failsafe cap on the ore sweep-up, if a chunk cannot reach the ship
  WARP_TIME: 0.85, // seconds for the ship to dissolve into or out of a warp
  WARP_ARRIVE_PAUSE: 0.35, // beat before the ship warps in at the start of a sector
  RESPAWN_PAUSE: 1.2, // longer beat after losing a life, to get your bearings
  CAMERA_WARP_FOLLOW: 2.6, // gentler camera while warping, so the pan reads as a pan
  CAMERA_MAX_PAN: 620, // units/sec ceiling on camera travel, so long pans glide
  TOAST_TIME: 2.6,
  ACCURACY_BONUS: 500, // scaled by hit fraction
  FLAWLESS_BONUS: 800, // for taking no damage
  CLEAR_BONUS_PER_SECTOR: 150,
  // What a powerup fetches when traded in, as a fraction of what it costs. One
  // number so no entry can be worth more sold than bought.
  POWERUP_SELL_FRACTION: 0.35,
  // How long a slot button must be held before the powerup in it is thrown
  // overboard instead of used.
  POWERUP_JETTISON_HOLD: 0.55,
  // Ore for the next powerup slot, multiplied by how many the ship already has.
  SLOT_COST: 30,
  POWERUP_JETTISON_SPEED: [110, 160], // how hard a jettisoned one is flung clear
  POWERUP_JETTISON_DRAG: 0.25, // and how quickly it slows, so it lands within reach
  POWERUP_ARM_TIME: 1.4, // how long before it can be picked up again

  // audio. Every effect is mixed through MASTER_VOLUME, so its own level only sets
  // where it sits against the others and this one number sets how loud the game is.
  // Individual levels are deliberately small, which left the mix around 20 dB below
  // where it should be until this was applied.
  MASTER_VOLUME: 6,
  // Amplitude above which the mix bends toward full scale instead of running past
  // it. Below this the signal is untouched, so a single effect is exactly its own
  // level; several loud ones at once are curved back rather than clipping, which is
  // a far worse noise than being slightly quiet.
  AUDIO_SOFT_CLIP: 0.7,

  // base damage values referenced by weapon types
  DMG_AST_GUN: 120,
  DMG_RIVAL_GUN: 130,
  DMG_FRIGATE_LASER: 420,
  // Rounds a second one barrel can cycle. A gun that fires faster than this
  // needs more barrels, and is drawn with them, so a glance at a turret says how
  // hard it is about to fire.
  BARREL_CYCLE_RATE: 4,

  // upgrade effects, indexed by upgrade level
  // Shield plating: level 1 fits the shield, and each level above it drains less
  // energy per point of damage. Level 0 flies without one, so its entry is never
  // read.
  SHIELD_EFFICIENCY: [1, 1, 0.72, 0.5, 0.32],
  MAGNET_RANGE: [62, 120, 190, 270, 350],
  LASER_RATE_MULT: [1, 1.45, 1.45, 1.45, 1.45],
  LASER_COST_MULT: [1, 1, 0.55, 0.55, 0.55],
  LASER_DAMAGE_MULT: [1, 1, 1, 1.5, 1.5],
  // Overdrive: at a level that has it, a beam held past full charge winds up over
  // LASER_OVERDRIVE_TIME seconds, drawing LASER_OVERDRIVE_COST energy a second as
  // it does. The charge glow fades from green to red across the wind-up and pulses
  // once it is there, so the guaranteed shatter is visible before the shot goes.
  LASER_OVERDRIVE: [false, false, false, false, true],
  LASER_OVERDRIVE_TIME: 1.5,
  LASER_OVERDRIVE_COST: 120,
}

// ---------------------------------------------------------------------------
// GAMEPAD - indices into the Gamepad API's "standard mapping", plus the
// thresholds that turn analog travel into intent. Remapping a control is an edit
// here; src/gamepad.js reads nothing else.
//
// Left stick steers and the right trigger drives the engine; the left trigger
// fires. Both are held controls - the laser is charged by holding it - so which
// hand gets which is a matter of taste, and either can be changed from the CONTROLS
// page. The keyboard keeps W to fly and SPACE to fire, which is the other way round
// from the triggers on purpose: the two devices are bound separately. `slotLabels` are the face buttons the HUD
// names in place of the number keys once a pad is in use.
// ---------------------------------------------------------------------------
export const GAMEPAD = {
  // Only the fixed controls live here. What a ship control is bound to is the
  // player's business and belongs to BINDABLE_CONTROLS, which is the one place its
  // default is written down.
  buttons: {
    pause: 8, // back / select
    confirm: 9, // start
    // A confirms a menu and B backs out of one, as well as filling powerup slots.
    // The two never collide: a slot can only be used in a flying phase and a menu
    // only exists outside one, so each press reaches exactly one of them.
    confirmAlt: 0,
    back: 1,
    dpadUp: 12,
    dpadDown: 13,
    dpadLeft: 14,
    dpadRight: 15,
  },
  axes: { turn: 0, menu: 1, turretX: 2, turretY: 3 },
  deadzone: 0.22, // stick travel ignored, so a resting stick does not drift
  turretDeadzone: 0.5, // the turret only takes an aim from a deliberate push
  triggerThreshold: 0.35, // how far a trigger travels before it counts as held
  menuStep: 0.6, // stick deflection that counts as one menu move
  // A pad binding is taken when the button comes back up, so B can be bound to a
  // control like any other. Holding it this long abandons the wait instead, and
  // the release that ends the hold is not captured.
  rebindCancelHold: 0.6,
  // The face buttons, by their index in the standard mapping, so a slot bound to
  // one can be named on the HUD as the pad names it.
  slotLabels: ["A", "B", "X", "Y"],
}

// ---------------------------------------------------------------------------
// CONTROLS - the ship controls a player may rebind, in menu order, with each
// one's default binding per device. `slot` marks the powerup slots, so the code
// never has to read a meaning out of an id.
//
// An action with no entry for a device does not appear in that device's section:
// a pad steers and aims with its sticks, so there is nothing to bind for turning.
//
// What is NOT here is deliberate. Menu navigation is fixed - the D-pad, the left
// stick, A and START on a pad; the arrow keys, WASD and ENTER on a keyboard - as
// is PAUSE itself, since that is how the menu is reached. A rebind can therefore
// never leave a player unable to reach the menu and put it back.
// ---------------------------------------------------------------------------
export const BINDABLE_CONTROLS = [
  { id: "thrust", name: "THRUST", defaults: { keys: ["KeyW"], buttons: 7 } },
  { id: "turnLeft", name: "TURN LEFT", defaults: { keys: ["KeyA"] } },
  { id: "turnRight", name: "TURN RIGHT", defaults: { keys: ["KeyD"] } },
  { id: "reverse", name: "REVERSE", defaults: { keys: ["KeyS"], buttons: 4 } },
  { id: "fire", name: "FIRE LASER", defaults: { keys: ["Space"], buttons: 6 } },
  { id: "turretLeft", name: "TURRET LEFT", defaults: { keys: ["ArrowLeft"] } },
  { id: "turretRight", name: "TURRET RIGHT", defaults: { keys: ["ArrowRight"] } },
  { id: "turretFire", name: "TURRET FIRE", defaults: { keys: ["ArrowUp"], buttons: 5 } },
  {
    id: "slot1",
    name: "POWERUP 1",
    slot: 0,
    defaults: { keys: ["Digit1", "Numpad1"], buttons: 0 },
  },
  {
    id: "slot2",
    name: "POWERUP 2",
    slot: 1,
    defaults: { keys: ["Digit2", "Numpad2"], buttons: 1 },
  },
  {
    id: "slot3",
    name: "POWERUP 3",
    slot: 2,
    defaults: { keys: ["Digit3", "Numpad3"], buttons: 2 },
  },
  {
    id: "slot4",
    name: "POWERUP 4",
    slot: 3,
    defaults: { keys: ["Digit4", "Numpad4"], buttons: 3 },
  },
]

// The devices a control can be bound on. `id` is both the key into a bindings
// table and the field in an action's `defaults`.
export const BINDING_DEVICES = [
  { id: "keys", name: "KEYBOARD", prompt: "PRESS A KEY" },
  { id: "buttons", name: "GAMEPAD", prompt: "PRESS A BUTTON" },
]

// Keys that cannot be bound to a ship control. Menu navigation is not in here,
// because the arrow keys and WASD are already both menu keys and ship controls and
// never collide: a menu is only open when the ship is not being flown. These three
// are different. P pauses during flight, so a control bound to it would pause the
// game every time it was used, and ENTER and ESCAPE are how a rebind is confirmed
// and abandoned, so they cannot also be the thing being captured.
export const RESERVED_KEYS = new Set(["KeyP", "Enter", "Escape"])

// And the pad button that opens the menu, for the same reason P is reserved. The
// D-pad, the stick, A and START are not reserved: they navigate a menu, and a menu
// is only open when the ship is not being flown, so a control sharing one of them
// never fires at the same time as the menu uses it. BACK is different, because
// pausing happens during flight.
export const RESERVED_BUTTONS = new Set([GAMEPAD.buttons.pause])

// A fresh bindings table, taken from the registry above.
export function freshBindings() {
  const bindings = {}
  for (const device of BINDING_DEVICES) {
    bindings[device.id] = {}
    for (const action of BINDABLE_CONTROLS) {
      const value = action.defaults[device.id]
      if (value !== undefined) {
        bindings[device.id][action.id] = Array.isArray(value) ? value.slice() : value
      }
    }
  }
  return bindings
}

// ---------------------------------------------------------------------------
// PROGRESSION - how a sector's contents are derived from its number. These
// drive Game.planLevel, so the whole difficulty curve is tunable here without
// reading gameplay code.
// ---------------------------------------------------------------------------
export const PROGRESSION = {
  // rock count: base + perSector * sector, rounded up, capped at max
  rocks: { base: 1, perSector: 0.9, max: 11 },
  // chance a rock carries a hazard trait, ramping from `fromSector`
  hazards: { fromSector: 3, base: 0.14, perSector: 0.07, max: 0.6 },
  // rivals alive at once: one from RIVALS_FROM_SECTOR, then one more every
  // `perSectors`. The gap between arrivals shortens as sectors advance.
  rivals: { perSectors: 3, max: 3, intervalBase: 28, intervalPerSector: 1.4, intervalMin: 9 },
  // where a sector's rocks start, and how fast
  spawn: {
    edgeMargin: 120, // keep a new rock this far inside the boundary
    clearRadius: 220, // and this far from the ship's arrival point
    placementTries: 50,
    radius: [0.72, 1], // fraction of AST_MAX_R
    speed: [30, 74],
    spin: [-0.6, 0.6],
  },
  powerups: { fromSector: 3, firstDelay: [6, 10], interval: [12, 20], maxOnField: 2 },
}

// Hazard traits a rock can spawn with. A trait joins the roll once its
// `fromSector` is reached, and `weightPerSector` adds an extra entry for each
// sector past that, so a trait can come to crowd out the others. `weightCap` is
// how far that may go: growth with nothing to stop it does not crowd the others
// out so much as delete them, and a hazard nobody meets any more may as well not
// be in the game. Armed rocks at a cap of 5 are still three quarters of what a
// late sector rolls, against 95% and rising without one.
//
// `gun` and `shield` name the modules to mount, so arming a rock differently is
// an edit here rather than in the Asteroid constructor. `explosive` is a property
// of the rock itself and mounts nothing.
// Guns are dealt an even share of the rock's circumference each. `jitter` is how
// far a gun may wander off its share, in radians, and `inset` how far out along
// its bearing it sits as a fraction of the distance to the outline.
//
// `guns` is the pool each turret is rolled from, one entry per kind of gun a rock
// may mount, in the same shape a loadout entry uses. Every turret rolls on its
// own, so a rock can carry a mix; repeat an entry to weight it. Both projectiles
// and beams work, since the controller fires whichever the entry names.
//
// A gun joins the pool at its own `fromSector`, so what a rock may be armed with
// widens over a run while the rocks themselves are no more likely to be armed. A
// gun with no `fromSector` is in the pool as soon as the trait itself is offered,
// and one of those must be, or an early sector would have nothing to roll.
//
// A blaster rock lobs single heavy rounds; a flak rock throws a stream of light
// ones, and the autocannon sits between the two.
const ROCK_TURRETS = {
  guns: [
    { weapon: "blaster", controller: "turret" },
    { weapon: "autocannon", controller: "turret", fromSector: 15 },
    { weapon: "flakCannon", controller: "turret", fromSector: 15 },
  ],
  count: [1, 3],
  jitter: 0.3,
  inset: [0.35, 0.7],
}
const ROCK_SHIELD = { shield: "standard" }

export const HAZARD_TRAITS = [
  { traits: { explosive: true }, fromSector: 3 },
  { traits: { shield: ROCK_SHIELD }, fromSector: 4 },
  { traits: { gun: ROCK_TURRETS }, fromSector: 5, weightPerSector: 1, weightCap: 5 },
  { traits: { gun: ROCK_TURRETS, shield: ROCK_SHIELD }, fromSector: 6 },
]

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
// `survivesDebris` says the module keeps working when the hull carrying it is
// cut apart, so it arms the wreckage instead of being lost with the ship.
// ---------------------------------------------------------------------------
export const WEAPON_TYPES = {
  blaster: {
    kind: "projectile",
    damage: CONFIG.DMG_AST_GUN,
    energy: 6,
    reload: 2.4,
    speed: CONFIG.BULLET_SPEED,
    colour: PALETTE.weapon.gun,
    survivesDebris: true,
  },
  autocannon: {
    kind: "projectile",
    damage: CONFIG.DMG_RIVAL_GUN,
    energy: 8,
    reload: [1.1, 1.9], // range so multiple turrets drift out of sync
    speed: CONFIG.BULLET_SPEED,
    colour: PALETTE.weapon.gun,
    survivesDebris: true,
  },
  minerLaser: {
    kind: "beam",
    damage: 30,
    energy: 16,
    reload: [1.4, 2.6],
    length: [320, 520],
    width: 2.4,
    glow: 16,
    triggerRange: 420, // the host starts mining once a rock is this close
    colour: PALETTE.rival.minerBeam,
  },
  cannonLaser: {
    kind: "beam",
    damage: CONFIG.DMG_FRIGATE_LASER,
    energy: 70,
    reload: [2.4, 3.8],
    // A siege gun: it outranges everything else in the sector and hits hard
    // enough to strip a shield outright, and pays for it with a long wind-up
    // that is the player's cue to break the firing arc.
    length: 780,
    width: 26,
    glow: 30,
    arc: 0.42,
    chargeTime: 1.5, // telegraphs with a growing glow before firing
    sound: "bigLaser",
    shotLife: 0.55, // the flash lingers longer than an ordinary beam
    colour: PALETTE.rival.cannonBeam,
  },
  flakCannon: {
    kind: "projectile",
    // A wall of little rounds: a tenth of a rival gun's punch each, ten times as
    // often. It comes out at the same damage a second as an autocannon and is far
    // harder to weave through, and its energy is scaled down with its damage so a
    // rock's cell can still feed it.
    damage: CONFIG.DMG_RIVAL_GUN / 10,
    energy: 1,
    reload: [0.11, 0.19],
    speed: CONFIG.BULLET_SPEED,
    colour: PALETTE.weapon.gun,
    survivesDebris: true,
  },
  seekerLaser: {
    kind: "beam",
    // The cannon's opposite number: light, quick and barely telegraphed, for a
    // host that is already pointed at you because it is chasing you.
    damage: 45,
    energy: 24,
    reload: [0.9, 1.4],
    length: 420,
    width: 3,
    glow: 14,
    arc: 0.35,
    chargeTime: 0.22, // a snap rather than the cannon's wind-up
    sound: "snapLaser",
    colour: PALETTE.rival.seekerBeam,
  },
  defenseBlaster: {
    kind: "projectile",
    // Point defence against rivals. A rock cannot be shot apart, only cut, so
    // this is aimed at the things that can be: it chips a hull and drains a
    // shield while the main laser is busy elsewhere. Faster than a rival's own
    // rounds, or it could never catch one running.
    damage: 60,
    energy: 8,
    reload: 0.5,
    range: 340, // how far out it looks for a target
    speed: 420,
    colour: PALETTE.player.turret,
  },
  playerLaser: {
    kind: "beam",
    chargeable: true,
    damage: 38,
    // Reach is the point of charging, so damage follows it only gently: the
    // multiplier runs from the first entry at chargeMin to the second at
    // chargeMax. Set both to 1 to make charge buy reach alone.
    //
    // A full-charge shot lands 68, which no shielded rival loses its shield to in
    // one hit: 2 shots to strip a scout and a third to cut it, 4 to strip a frigate
    // and a fifth to cut it. LASER_DAMAGE_MULT takes one shot off each of those at
    // the levels that pay for it.
    chargeDamageMult: [1, 1.8],
    colour: PALETTE.player.beam,
    width: 2.4,
    glow: 16,
    reload: 0.12,
    chargeRate: 720,
    chargeMax: 640,
    chargeMin: 95,
    chargeCost: 150,
    chargeReach: 40, // beam length is charge * reach multipliers, plus this
  },
}

// How many barrels a gun needs to keep up with its own rate of fire, and is
// therefore drawn with. A type may state `barrels` to override it. Only a
// projectile has barrels to cycle; a beam has an emitter.
export function barrelCount(type) {
  if (type.barrels) {
    return type.barrels
  }
  if (type.kind !== "projectile") {
    return 1
  }
  const reload = Array.isArray(type.reload) ? (type.reload[0] + type.reload[1]) / 2 : type.reload
  const rate = reload > 0 ? 1 / reload : 0
  return clamp(Math.ceil(rate / CONFIG.BARREL_CYCLE_RATE), 1, 4)
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
  // Covers one channel instead of two and is better at it, which is the trade:
  // a hull carrying this is hardened against the sector and naked to a laser.
  // It has to hold through a chase, so it soaks a point-blank blast without
  // dropping, endures a long scrape along a rock, and is quick back up when
  // something does overload it - six seconds without it is a death sentence for
  // a hull this thin.
  deflector: {
    efficiency: 0.8,
    blocks: ["projectile"],
    sides: 6,
    colour: PALETTE.shield.deflector,
    dropAt: 0.12,
    recoverAt: 0.35,
    recoverDelay: 1,
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
// SHIP STATS - how a ship's settings come out of what the ship is.
//
// A type states its shape (`outline` and `size`) and three numbers a person can
// hold in their head:
//
//   mass    how heavy the hull is, on the scale a rock's mass is on
//   power   engine output, in units of `thrustPerPower` below
//   armour  plating quality, as hull points per unit of hull area
//
// How it flies and how much it can take then follow from those and from the
// outline itself, through the relationships below. That is the point of keeping
// them here: a ship is a shape and three numbers, not a dozen loose values that
// have to be kept consistent with one another by hand, and the reasoning that
// ties them together is written down once instead of being implied by the
// numbers a dozen times.
//
// Stating any derived field on a type keeps that value instead, for tuning one
// ship without disturbing the relationships. Nothing ships with one.
//
// `size` is not derived. It belongs with the outline, which is drawn at unit
// scale, and it cannot come out of mass without one of the ships moving a long
// way: a scout packs 2.1x the mass into its area that a frigate does, so a
// single density puts one of them 20% off whichever way it is fitted.
// ---------------------------------------------------------------------------
export const SHIP_SCALARS = {
  thrustPerPower: 100, // accel = power * this / mass
  speedPerAccel: 1.37, // top speed, as a multiple of acceleration
  // turnRate = thrust * this / (mass * size): thrusters at the hull's edge give a
  // torque proportional to its reach, against a spin inertia that grows with mass
  // and with reach squared, so one power of the reach cancels.
  turnPerThrust: 0.217,
  dragPerMass: 0.39, // drag = 1 - this / mass: a heavy hull coasts, a light one bites
  shieldClearance: 1.33, // the bubble, as a multiple of how far the outline reaches
  hullWidthBase: 1.71, // outline weight, which grows a little with the hull
  hullWidthPerSize: 0.0071,
  hullPerArea: 0.11, // hull = armour * hull area * this
  // rockContact is set so a full-speed ram costs about this much of the hull.
  // Rivals steer for ore and rocks and shoulder them aside constantly, so
  // charging them the player's flat rate kills them faster than they can do
  // anything interesting: at 1 a scout does not survive a single ram and a
  // rival's median life falls from 24s to 5s.
  ramSurvivability: 0.7,
  // And a ceiling for the hulls that are tough or slow enough that a ram cannot
  // threaten them anyway, which the formula would otherwise put on the player's
  // full rate. The player is the one hull meant to fear a rock.
  maxRockContact: 0.6,
}

// Area the outline encloses at unit scale, and how far it reaches from the origin.
const outlineArea = (outline) => {
  let twice = 0
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i],
      q = outline[(i + 1) % outline.length]
    twice += p[0] * q[1] - q[0] * p[1]
  }
  return Math.abs(twice) / 2
}
const outlineReach = (outline) => Math.max(...outline.map(([x, y]) => Math.hypot(x, y)))

// What the shape alone decides, for any hull including the player's.
function hullShape(type) {
  return {
    shieldScale: outlineReach(type.outline) * SHIP_SCALARS.shieldClearance,
    hullWidth: SHIP_SCALARS.hullWidthBase + type.size * SHIP_SCALARS.hullWidthPerSize,
  }
}

// Fill in everything a type has not stated for itself.
export function deriveShipStats(type) {
  const k = SHIP_SCALARS
  const stated = (field, value) => (type[field] !== undefined ? type[field] : value)
  const thrust = type.power * k.thrustPerPower
  const hullArea = outlineArea(type.outline) * type.size * type.size
  const accel = stated("accel", thrust / type.mass)
  const maxSpeed = stated("maxSpeed", accel * k.speedPerAccel)
  const hull = stated("hull", Math.round(type.armour * hullArea * k.hullPerArea))
  const shape = hullShape(type)
  return {
    ...type,
    accel,
    maxSpeed,
    hull,
    turnRate: stated("turnRate", (thrust * k.turnPerThrust) / (type.mass * type.size)),
    drag: stated("drag", clamp(1 - k.dragPerMass / type.mass, 0.05, 0.98)),
    shieldScale: stated("shieldScale", shape.shieldScale),
    hullWidth: stated("hullWidth", shape.hullWidth),
    rockContact: stated(
      "rockContact",
      clamp(
        (k.ramSurvivability * hull) / (maxSpeed * CONFIG.ROCK_IMPACT_DAMAGE),
        0.05,
        k.maxRockContact,
      ),
    ),
  }
}

// ---------------------------------------------------------------------------
// SHIP TYPES - a shape, three numbers, and what the simulation cannot work out
// for itself. `hardpoints` are attachment slots in local space (role is
// documentation); `loadout` mounts modules onto them by index. `arms` are
// optional modules the spawner rolls, each with a per-sector chance that ramps
// from the type's spawn sector up to its cap.
//
// The spawner reads `spawn`: a type with a `chance` is rolled once its
// `fromSector` is reached, up to `maxConcurrent` alive at a time; the type
// marked `fallback` is spawned when nothing else is picked.
//
// The rest is what a type does rather than what it is made of, so no code tests
// a ship by name: `debris` sizes the explosion, `debrisMaterial` says what its
// wreckage is made of, and `hunts` says it steers for the player instead of for
// ore and rocks.
//
// Debris takes its mass from its area, being rock from then on, so wreckage
// weighs less than the ship it was cut from.
//
// `exhaust` is the thruster: `mounts` are nozzle positions in local space, as
// hardpoints are, and every one of them emits, so two mounts read as two streams.
// `rate` is plumes a second per stream, `speed` how hard they are thrown back
// (which is also how long each streak draws), `life` how long they linger and
// `spread` how much they fan out.
//
// A beam cuts any unshielded hull, exactly as it cuts a rock. Nothing marks a
// type as cuttable: the material's `minArea` decides what the cut leaves, so a
// hull with halves above it comes apart into drifting wreckage and one too small
// for that is simply destroyed. A scout is the second case and a frigate the
// first, and anything sized between them lands wherever its halves fall.
// ---------------------------------------------------------------------------

// What a ship hull is made of. Plating holds together in smaller pieces than rock
// and burns where it is torn. The debris keeps the material, so a piece cut from
// a burning piece is plating too, and burns as well.
export const SHIP_PLATING = {
  minArea: CONFIG.SHIP_DEBRIS_MIN_AREA,
  burn: { seconds: 9.0, rate: 30 }, // rate is fire particles a second at full heat
}
// ---------------------------------------------------------------------------
export const FRIGATE_SHAPE = [
  [1.55, 0.4],
  [1.5, 0.6],
  [0.55, 0.6],
  [0.45, 0.4],
  [-0.45, 0.4],
  [-0.55, 0.6],
  [-1.7, 0.6],
  [-1.7, 0.25],
  [-1.6, 0.15],
  [-1.6, -0.2],
  [-1.7, -0.3],
  [-1.7, -0.6],
  [-0.55, -0.6],
  [-0.45, -0.4],
  [0.45, -0.4],
  [0.55, -0.6],
  [1.5, -0.6],
  [1.55, -0.4],
  [1.75, -0.35],
  [1.75, 0.35],
]

const SHIP_DESIGNS = {
  seeker: {
    outline: [
      [1.5, 0],
      [0, -0.4],
      [-0.05, -0.6],
      [-0.9, -0.6],
      [-0.85, -0.4],
      [-0.65, -0.4],
      [-0.85, 0],
      [-0.65, 0.4],
      [-0.85, 0.4],
      [-0.9, 0.6],
      [-0.05, 0.6],
      [0, 0.4],
    ],
    colour: PALETTE.ore.body,
    size: 12,
    mass: 0.8,
    power: 1.5,
    armour: 1.2,
    exhaust: {
      mounts: [
        [-0.9, 0.5],
        [-0.9, -0.5],
      ],
      rate: 40,
      speed: 30,
      life: 0.48,
      spread: 4,
    },
    lifeTime: [26, 36],
    energyMax: 300,
    regen: 34,
    hardpoints: [
      { local: [1.5, 0], role: "nose" },
      { local: [-0.45, 0], role: "gun" },
      { local: [-0.05, 0], role: "core" },
    ],
    loadout: [
      // `hunter` is the behaviour, not the ship: line up, wind up briefly, fire.
      { hp: 0, weapon: "seekerLaser", controller: "hunter" },
      { hp: 2, shield: "deflector" },
    ],
    arms: {
      gun: {
        hp: 1,
        weapon: "autocannon",
        controller: "turret",
        chancePerSector: 0.15,
        chanceCap: 0.85,
      },
    },
    spawn: { fromSector: 4, chance: 0.2, maxConcurrent: 1 },
    hunts: true,
    debrisMaterial: SHIP_PLATING,
    debris: { particles: 26, speed: 260, ring: 19, shake: 10 },
    killScore: 420,
    blastScore: 200,
    oreDrop: 0,
  },
  scout: {
    outline: [
      [1.4, 0],
      [-0.9, -1.0],
      [-0.5, 0],
      [-0.9, 1.0],
    ],
    colour: PALETTE.rival.hull,
    size: 12,
    mass: 0.7, // a light dart
    power: 1,
    armour: 1,
    exhaust: { mounts: [[-1.17, 0]], rate: 26, speed: 55, life: 0.4, spread: 20 },
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
    debrisMaterial: SHIP_PLATING,
    debris: { particles: 26, speed: 240, ring: 18, shake: 10 },
    killScore: 400,
    blastScore: 200,
    oreDrop: 5,
  },
  frigate: {
    outline: FRIGATE_SHAPE,
    colour: PALETTE.rival.frigateHull,
    size: 40,
    mass: 6, // a slab: heavy, hard to turn, and thin-skinned for its size
    power: 2,
    armour: 0.6,
    // twin nozzles set either side of the tail, throwing a long heavy plume: a
    // single small stream read far too light for a hull this size
    exhaust: {
      mounts: [
        [-1.78, -0.36],
        [-1.78, 0.36],
      ],
      rate: 44,
      speed: 150,
      life: 0.62,
      spread: 26,
    },
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
    hunts: true, // steers for the player rather than for ore and rocks
    debrisMaterial: SHIP_PLATING,
    debris: { particles: 40, speed: 300, ring: 26, shake: 14 },
    killScore: 900,
    blastScore: 500,
    oreDrop: 9,
  },
}

export const SHIP_TYPES = Object.fromEntries(
  Object.entries(SHIP_DESIGNS).map(([name, design]) => [name, deriveShipStats(design)]),
)

// Player ship definition (its own type so the same machinery drives it). How it
// flies is CONFIG's business and not this table's, since the player's throttle,
// turn and drag are tuned against the controls rather than against the hull; the
// bubble and the outline weight still come from the shape, as every hull's do.
const PLAYER_DESIGN = {
  outline: [
    [1.4, 0],
    [-0.8, -0.85],
    [-0.4, 0],
    [-0.8, 0.85],
  ],
  colour: PALETTE.player.hull,
  size: 13,
  mass: 1, // the scale every other hull's mass is quoted against
  hardpoints: [
    { local: [1.4, 0], role: "nose" },
    { local: [0, 0], role: "core" },
    { local: [0.2, 0], role: "aux" }, // filled by a fitting, see below
  ],
  loadout: [{ hp: 0, weapon: "playerLaser", controller: "manual" }],
  // Modules the shop bolts on after the fact, keyed by the upgrade that pays for
  // them. Each entry is an ordinary loadout entry, mounted the same way a spawn
  // loadout is, and re-mounted when a saved run is resumed. A one-off fitting in
  // SHOP needs no `apply` of its own to reach this. A levelled upgrade reaches it
  // from its own `apply`, and mounts at level 1.
  fittings: {
    shield: { hp: 1, shield: "player" },
    turret: { hp: 2, weapon: "defenseBlaster", controller: "defense" },
  },
}

export const PLAYER_TYPE = { ...PLAYER_DESIGN, ...hullShape(PLAYER_DESIGN) }

// ---------------------------------------------------------------------------
// POWERUP TYPES - one entry per collectable. Fields:
//   label   name shown in the pickup toast
//   short   name shown in the active-buff list (omit to reuse `label`)
//   icon    single character drawn on the pickup and in the inventory slot
//   colour   pickup outline, inventory slot and buff text
//   cost     ore price in the shop, once the run has found one
//   mode     how using it works, one of:
//              pulse  one-off effect, then the cooldown
//              single one-off effect that is used up, emptying the slot
//              timed  runs for `seconds`, then the cooldown
//              toggle switches on and off, drawing `drain` a second while on
//   energy   taken at the moment of use, as a fraction of the energy cell
//   drain    drawn per second while switched on, as a fraction of the cell
//
// Both are fractions rather than amounts because the cell quadruples across the
// power core's levels: a flat cost that bites at level 0 is loose change at level
// 4, and a fully upgraded ship would run stealth on regen alone.
//   cooldown seconds before the slot can be used again, counted from the moment
//            the effect ends
//   seconds  how long a timed effect lasts
//   apply    optional immediate effect, run on use
//
// A powerup is equipment, not ammunition: using one leaves it in its slot and
// starts its cooldown. Its ongoing effect is declared here as a field the
// gameplay code looks up by name through PlayerShip.buffField, so nothing tests
// for a powerup by id. The fields the simulation currently reads off an active
// effect:
//   beamOffsets     parallel beam positions either side of the nose
//   beamLengthMult  multiplies the charged beam's reach
//   freeCharge      charging the laser costs no energy
//   collisionImmune asteroid contact does no damage
//   pull            ore attraction strength, at any range
//   tintsShip       the hull and the energy bar take this entry's `colour`
//   invisible       nothing hunting the player can see it, see Game.visiblePlayer
//   hullAlpha       the hull is drawn this solid
//   endsOnFire      firing the main laser switches the effect off
// Adding a field means reading it at one gameplay site; adding a powerup that
// reuses existing fields means editing nothing but this registry.
// ---------------------------------------------------------------------------
export const POWERUP_TYPES = {
  // Shoves what is around the ship clear. `range` keeps it to the immediate
  // neighbourhood, so it is a way out of a squeeze and not a way to sweep the
  // sector; a rock counts as in range when its surface is.
  repel: {
    label: "REPEL",
    icon: "R",
    colour: PALETTE.powerup.repel,
    cost: 90,
    mode: "pulse",
    energy: 0.22,
    cooldown: 4,
    range: 240,
    impulse: 300,
    apply: (game, player, type) => {
      for (const asteroid of game.asteroids) {
        if (
          Math.hypot(asteroid.center.x - player.x, asteroid.center.y - player.y) >
          type.range + asteroid.boundRadius
        ) {
          continue
        }
        const d = normalize(subtract(asteroid.center, player))
        asteroid.vx += d.x * type.impulse
        asteroid.vy += d.y * type.impulse
        asteroid.spin += randRange(-3, 3)
      }
      for (const bullet of game.projectiles) {
        if (Math.hypot(bullet.x - player.x, bullet.y - player.y) > type.range) {
          continue
        }
        const d = normalize(subtract(bullet, player))
        const speed = Math.max(CONFIG.BULLET_SPEED, Math.hypot(bullet.vx, bullet.vy))
        bullet.vx = d.x * speed
        bullet.vy = d.y * speed
      }
      game.ring(player.x, player.y, 40, type.colour, type.range, 0.7)
      game.screenShake = 9
    },
  },
  // The one powerup that cannot be paid for in energy, being made of it, so it is
  // spent instead: a full cell once, and the slot is empty again.
  refuel: {
    label: "REFUEL",
    icon: "F",
    colour: PALETTE.powerup.refuel,
    cost: 70,
    mode: "single",
    energy: 0,
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
    cost: 140,
    mode: "timed",
    energy: 0.38,
    cooldown: 60,
    seconds: 6.5,
    beamLengthMult: 1.6, // charged shots reach further...
    freeCharge: true, // ...and cost nothing to charge
    collisionImmune: true, // and rocks can be shouldered aside unharmed
    tintsShip: true,
    apply: (game, player, type) => {
      game.burst(player.x, player.y, 20, type.colour, 40, 140, 0.6)
    },
  },
  multi: {
    label: "MULTI-LASER",
    short: "MULTI",
    icon: "L",
    colour: PALETTE.powerup.multi,
    cost: 130,
    mode: "timed",
    energy: 0.44,
    cooldown: 75,
    seconds: 9,
    beamOffsets: [-28, 0, 28], // parallel beams either side of the nose
  },
  magnet: {
    label: "ORE MAGNET",
    short: "MAGNET",
    icon: "M",
    colour: PALETTE.powerup.magnet,
    cost: 100,
    mode: "timed",
    energy: 0.19,
    cooldown: 45,
    seconds: 6.5,
    pull: 260,
  },
  // Held on rather than triggered: it costs energy for as long as it runs, and
  // firing the main laser gives the position away and drops it.
  stealth: {
    label: "STEALTH",
    icon: "S",
    colour: PALETTE.powerup.stealth,
    cost: 160,
    mode: "toggle",
    drain: 0.2,
    cooldown: 2,
    invisible: true,
    hullAlpha: 0.35,
    endsOnFire: true,
  },
}

export const POWERUP_IDS = Object.keys(POWERUP_TYPES)

// Maximum powerup slots the ship can be fitted with.
export const MAX_SLOTS = 4

export function freshUpgrades() {
  return { slots: 1, core: 0, shield: 0, laser: 0, magnet: 0, turret: false, reverse: false }
}

// ---------------------------------------------------------------------------
// PAUSE MENU - one entry per row, in order. Fields:
//   name    the label
//   value   optional (game) => text shown on the right, for anything with a state
//   action  optional (game) => run on ENTER / A
//   adjust  optional (game, step) => run on LEFT / RIGHT, for anything on a scale
//   confirm optional prompt; ENTER once asks, ENTER again does it
//   label   optional (game) => text shown in place of `name`, which stays its identity
//   available optional (game) => whether the row belongs here at all
//   section optional heading this row sits under, for a page that groups them
// Everything goes through a method on Game, so this file stays free of the audio
// and renderer plumbing and a row cannot reach past the game's own API.
// ---------------------------------------------------------------------------
export const PAUSE_MENU = [
  // Only offered while the sector is still being fought, and asked twice like the
  // other rows that throw something away.
  {
    name: "EXIT SECTOR",
    confirm: "LEAVE THIS SECTOR?",
    available: (g) => g.canExitSector(),
    action: (g) => g.exitSector(),
  },
  {
    name: "VOLUME",
    value: (g) => `${Math.round(g.settings.volume * 100)}%`,
    adjust: (g, step) => g.setVolume(g.settings.volume + step * 0.1),
  },
  {
    name: "SOUND",
    value: (g) => (g.settings.sound ? "ON" : "OFF"),
    action: (g) => g.setSound(!g.settings.sound),
    adjust: (g, step) => g.setSound(step > 0),
  },
  {
    name: "CRT FILTER",
    value: (g) => (g.settings.crt ? "ON" : "OFF"),
    action: (g) => g.setCrt(!g.settings.crt),
    adjust: (g, step) => g.setCrt(step > 0),
  },
  { name: "CONTROLS", value: () => ">", action: (g) => g.openPausePage("controls") },
  {
    name: "RESET PROGRESS",
    value: (g) => (g.savedRun ? `SECTOR ${g.resumeSector()}` : "-"),
    confirm: "ERASE YOUR RUN?",
    action: (g) => g.resetProgress(),
  },
  // Only where the window can actually be closed, which is an app window and not a
  // tab. Offering it in a tab would be a row that does nothing when pressed.
  {
    name: "EXIT GAME",
    confirm: "QUIT TO DESKTOP?",
    available: (g) => g.canExit,
    action: (g) => g.requestExit(),
  },
  // The way out sits last, where the controls page also puts it. `label` is what a
  // player reads; `name` stays the row's identity, which is what a pending
  // confirmation is remembered by.
  {
    name: "RESUME",
    label: (g) => (g.inSector() ? "RESUME" : "BACK"),
    action: (g) => g.toggleOptions(),
  },
]

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

// A one-off fitting. Buying it sets the flag and mounts whatever PLAYER_TYPE
// declares for that id, so an upgrade that only bolts a module on needs nothing
// but this entry.
const fitting = (id, name, desc, price, apply) => ({
  id,
  name,
  desc,
  cost: () => price,
  info: (g) => (g.upgrades[id] ? "INSTALLED" : "-"),
  maxed: (g) => g.upgrades[id],
  apply: (g) => {
    g.upgrades[id] = true
    g.fitUpgrade(id)
    if (apply) {
      apply(g)
    }
  },
})

export const SHOP = [
  // A spare ship and the powerups already carried are not part of the loadout the
  // rest of the page sells, so they head the list as their own group.
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
  levelled(
    "shield",
    "SHIELD PLATING",
    "Lv1 fits a shield, every level after drains less energy per hit.",
    CONFIG.SHIELD_EFFICIENCY.length - 1,
    (level) => 40 + level * 45,
    (g) => g.fitUpgrade("shield"),
  ),
  levelled(
    "laser",
    "LASER SYSTEM",
    "Lv1 charges faster, Lv2 costs less energy, Lv3 hits harder, Lv4 overdrive.",
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
    "A nose blaster that auto-fires on rivals that come close.",
    85,
  ),
  fitting("reverse", "REVERSE THRUST", "Forward thrusters: hold DOWN or S to back away.", 55),
]

// Where the shop's own rows sit among the purchases: the powerup slots follow
// EXTRA LIFE, and the gap under them sets that pair apart from the loadout below.
export const SHOP_LAYOUT = { slotsRow: 1, groupGap: 14 }

// ---------------------------------------------------------------------------
// SLOT MENU - the pop-over that opens on a powerup slot in the shop. One entry
// per row, in menu order, each taking the slot it was opened on. Fields:
//   name      the label
//   value     optional (game, slot) => text shown on the right
//   available optional (game, slot) => whether the row belongs on this slot
//   action    (game, slot) => run on ENTER / A
//   rows      optional (game, slot) => rows of the same shape, for a list that is
//             not known until the run is under way
// A slot whose rows all come to nothing does not open, so a slot with nothing to
// offer stays inert.
// ---------------------------------------------------------------------------
export const SLOT_MENU = [
  // A slot the ship has not been fitted with yet. Only the next one along can be
  // opened, so this appears on exactly one slot and the rest stay inert.
  {
    name: "UNLOCK SLOT",
    value: (g) => (g.devMode ? "FREE" : `${g.slotUnlockCost()} ore`),
    available: (g, slot) => slot === g.upgrades.slots && slot < MAX_SLOTS,
    action: (g, slot) => g.unlockSlot(slot),
  },
  {
    name: "SELL",
    value: (g, slot) => `+${g.slotSellValue(slot)} ore`,
    available: (g, slot) => g.slotItem(slot) !== null,
    action: (g, slot) => g.sellSlot(slot),
  },
  // One row per powerup an empty slot could be filled with: everything the run
  // has found, and everything at all in dev mode. A slot the ship has not been
  // fitted with yet has to be unlocked before it can hold anything.
  {
    rows: (game, slot) =>
      game.slotItem(slot) || slot >= game.upgrades.slots
        ? []
        : game.buyablePowerups().map((id) => ({
            name: POWERUP_TYPES[id].label,
            value: (g) => (g.devMode ? "FREE" : `${POWERUP_TYPES[id].cost} ore`),
            action: (g, at) => g.buyPowerup(at, id),
          })),
  },
]
