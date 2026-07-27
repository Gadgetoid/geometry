// Configuration and balance. Everything tuneable lives here.
//
// The combat model is uniform for every host (player, rival, asteroid):
//   * a host has an ENERGY pool (+ regen)
//   * WEAPONS are modules mounted on hardpoints; firing costs energy
//   * a SHIELD module means "incoming damage drains energy instead of hull
//     until energy hits zero, then the shield is down"
//   * a CONTROLLER decides when a mounted weapon fires
// New weapons/ships/shields/specials are added by editing the registries below.
// A registry entry may carry an `apply` function; it drives the effect through
// the public Game API so the whole definition stays in one place.

import { clamp, randRange } from "./math.js"
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
  // Top speed is the drive's and the turn rate the maneuvering thrusters', see
  // SHIP_SCALARS and THRUSTER_TYPES. Drag stays here: it is a control
  // aid rather than a property of the hull, and it is what makes the ship coast the
  // way it is flown.
  SPEED_DRAG: 0.85,
  // Hull points a second the lost part of the hull bar takes to recede. A hit shows as
  // red where the hull used to be and then shrinks away, so what just happened is
  // readable at a glance instead of being a bar that is quietly shorter than it was.
  HULL_LOSS_FADE: 26,
  THRUST_COST: 21, // energy/sec while thrusting
  INVIN_TIME: 2.5, // grace after arriving, counted from when the ship can be flown
  START_LIVES: 3,
  MAX_LIVES: 6,
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
  // What every hull sees without a radar to help it: a circle a little wider than
  // the view's half-diagonal of 604, so whatever is on screen is also in reach of
  // being noticed.
  SENSOR_FLOOR: 620,
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
  // A gun mounted on a rock is a target in its own right, and a forgiving one: a
  // beam passing within this of the mount takes it off, against a nub the view
  // draws at 3.4 with a barrel 10 long. Otherwise the only way to strip a rock's
  // guns was to cut it into pieces small enough to shatter, so a shot lined up
  // straight through a turret left it firing.
  AST_TURRET_HITBOX: 12,
  // And how far clear of a cut a mount has to be to ride on it. Inside this the nub
  // straddles the cut line, so it goes with it rather than surviving on the piece
  // its centre happened to fall on.
  AST_TURRET_CLEARANCE: 4,
  // Contact resolution between bodies: overlap below CONTACT_SLOP is left alone
  // so resting pairs do not jitter, and only CONTACT_BIAS of the rest is undone
  // each frame so a contact eases apart instead of snapping. The solver runs
  // CONTACT_ITERATIONS sweeps per frame, so a body wedged against two others is
  // separated from both instead of alternating between them.
  CONTACT_SLOP: 0.5,
  CONTACT_BIAS: 0.35,
  CONTACT_ITERATIONS: 4,
  // How hard a piece has to be hit before it comes apart instead of being shoved.
  // Priced in closing speed, as every other impact in the game is (see
  // ROCK_IMPACT_DAMAGE), so one number covers a splinter and a boulder alike: hit it
  // hard enough and it breaks.
  //
  // Rock is set above every hull's top speed, so an ordinary field never shatters
  // itself: rocks drift at 30 to 74 and the fastest rival manages 245. What does reach
  // it is the player at full tilt and a rock flung by a blast, both of which should
  // break something. A material states its own instead, and plating states far less,
  // which is what makes fast wreckage come apart on whatever it meets.
  ROCK_SHATTER_SPEED: 300,
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
  SPECIAL_LIFE: 26,
  // Seconds of flashing before an uncollected ore chunk or special goes, so the
  // last of a run at one is not a surprise.
  EXPIRY_WARN: 6,
  // How close the ship has to be for a loose special to name itself, when help
  // text is on.
  SPECIAL_LABEL_RANGE: 260,

  // camera, pacing and end-of-sector scoring
  CAMERA_FOLLOW: 6, // how quickly the view eases toward the ship
  CAMERA_MARGIN: 140, // how far inside the arena edge the view stops
  CLEAR_DELAY: 12, // failsafe cap on the ore sweep-up, if a chunk cannot reach the ship
  WARP_TIME: 0.85, // seconds for the ship to dissolve into or out of a warp
  WARP_ARRIVE_PAUSE: 0.35, // beat before the ship warps in at the start of a sector
  RESPAWN_PAUSE: 1.2, // longer beat after losing a life, to get your bearings
  // A ship warps in solid, so anything sitting on the spawn point is eased out of
  // this radius while it arrives. `RATE` is how much of what is left is undone per
  // second, and `PUSH` the acceleration that sends a rock on its way afterwards.
  SPAWN_CLEAR_RADIUS: 110,
  SPAWN_CLEAR_RATE: 3.5,
  SPAWN_CLEAR_SPEED: 130, // ceiling on that ease, so a deep overlap does not lurch
  SPAWN_CLEAR_PUSH: 45,
  CAMERA_WARP_FOLLOW: 2.6, // gentler camera while warping, so the pan reads as a pan
  CAMERA_MAX_PAN: 620, // units/sec ceiling on camera travel, so long pans glide
  TOAST_TIME: 2.6,
  ACCURACY_BONUS: 500, // scaled by hit fraction
  FLAWLESS_BONUS: 800, // for taking no damage
  CLEAR_BONUS_PER_SECTOR: 150,
  // What a special fetches when traded in, as a fraction of what it costs. One
  // number so no entry can be worth more sold than bought.
  SPECIAL_SELL_FRACTION: 0.35,
  // How long a slot button must be held before the special in it is thrown
  // overboard instead of used.
  SPECIAL_JETTISON_HOLD: 0.55,
  SPECIAL_JETTISON_SPEED: [110, 160], // how hard a jettisoned one is flung clear
  SPECIAL_JETTISON_DRAG: 0.25, // and how quickly it slows, so it lands within reach
  SPECIAL_ARM_TIME: 1.4, // how long before it can be picked up again

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

  // Overdrive: on a mark that has it, a beam held past full charge winds up over
  // LASER_OVERDRIVE_TIME seconds, drawing LASER_OVERDRIVE_COST energy a second as
  // it does. The charge glow fades from green to red across the wind-up and pulses
  // once it is there, so the guaranteed shatter is visible before the shot goes.
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
    // A confirms a menu and B backs out of one, as well as filling special slots.
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
// one's default binding per device. `slot` marks the special slots, so the code
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
    name: "SPECIAL 1",
    slot: 0,
    defaults: { keys: ["Digit1", "Numpad1"], buttons: 0 },
  },
  {
    id: "slot2",
    name: "SPECIAL 2",
    slot: 1,
    defaults: { keys: ["Digit2", "Numpad2"], buttons: 1 },
  },
  {
    id: "slot3",
    name: "SPECIAL 3",
    slot: 2,
    defaults: { keys: ["Digit3", "Numpad3"], buttons: 2 },
  },
  {
    id: "slot4",
    name: "SPECIAL 4",
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
//
// A run is 40 sectors long and everything here is paced to reach its ceiling at the far
// end of that rather than in the first ten: the rock field fills, the share of rocks
// carrying something climbs, and both the number of rivals alive and how fast they
// arrive keep moving the whole way. What arrives is paced by each type's own `spawn`
// block and what it carries by its `arms`, so timeline.html is the place to read the
// curve as a whole.
// ---------------------------------------------------------------------------
export const PROGRESSION = {
  // rock count: base + perSector * sector, rounded up, capped at max
  rocks: { base: 2, perSector: 0.3, max: 14 }, // the cap lands on sector 40, not before it
  // chance a rock carries a hazard trait, ramping from `fromSector`
  hazards: { fromSector: 3, base: 0.1, perSector: 0.014, max: 0.62 },
  // rivals alive at once: one from RIVALS_FROM_SECTOR, then one more every
  // `perSectors`. The gap between arrivals shortens as sectors advance.
  rivals: { perSectors: 9, max: 4, intervalBase: 30, intervalPerSector: 0.55, intervalMin: 10 },
  // where a sector's rocks start, and how fast
  spawn: {
    edgeMargin: 120, // keep a new rock this far inside the boundary
    clearRadius: 220, // and this far from the ship's arrival point
    placementTries: 50,
    radius: [0.72, 1], // fraction of AST_MAX_R
    speed: [30, 74],
    spin: [-0.6, 0.6],
  },
  specials: { fromSector: 5, firstDelay: [6, 10], interval: [12, 20], maxOnField: 2 },
}

// ---------------------------------------------------------------------------
// WEIGHTS - what an entry weighs against its siblings at a given sector, for
// every "which one turns up" roll in the game: which rival arrives, which hazard
// a rock carries, which gun it is armed with, which special drifts in.
//
//   fromSector      not in the running at all before this
//   weight          how much it weighs once it is, against its siblings (1)
//   weightPerSector how much heavier it gets for each sector past `fromSector`
//   weightCap       how heavy it is allowed to get
//
// A share is always one weight over the total of the eligible ones, so a number
// here can be read on its own and no entry's odds depend on where it sits in the
// list. Growth with nothing to stop it does not crowd the others out so much as
// delete them, and a thing nobody meets any more may as well not be in the game,
// which is what `weightCap` is for.
// ---------------------------------------------------------------------------
export function weightAt(entry, sector) {
  const from = entry.fromSector ?? 0
  if (sector < from) {
    return 0
  }
  const growth = (entry.weightPerSector ?? 0) * (sector - from)
  return Math.min((entry.weight ?? 1) + growth, entry.weightCap ?? Infinity)
}

// Hazard traits a rock can spawn with, spread across a run: something to blow up from
// sector 3, something that shrugs off a shot from 6, something that shoots back from 10,
// and both at once from 16. Armed rocks grow to a cap of 4, which is a little over half
// of what sector 40 rolls, and the share of rocks carrying anything at all is ramped
// separately by PROGRESSION.hazards.
//
// `gun` and `shield` name the modules to mount, so arming a rock differently is
// an edit here rather than in the Asteroid constructor. `explosive` is a property
// of the rock itself and mounts nothing.
// Guns are dealt an even share of the rock's circumference each. `jitter` is how
// far a gun may wander off its share, in radians, and `inset` how far out along
// its bearing it sits as a fraction of the distance to the outline.
//
// `guns` is the pool each turret is rolled from, one entry per kind of gun a rock
// may mount, in the same shape a loadout entry uses, and weighed the way every
// other pool is (see WEIGHTS). Every turret rolls on its own, so a rock can carry
// a mix. Both projectiles and beams work, since the controller fires whichever
// the entry names.
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
    {
      weapon: "autocannon",
      controller: "turret",
      fromSector: 15,
      weight: 0.4,
      weightPerSector: 0.04,
      weightCap: 1.4,
    },
    // A flak rock throws a stream, and a field of them is a wall rather than a hazard,
    // so it joins late and stays the rarest of the three however far a run goes.
    {
      weapon: "flakCannon",
      controller: "turret",
      fromSector: 20,
      weight: 0.15,
      weightPerSector: 0.015,
      weightCap: 0.45,
    },
  ],
  count: [1, 3],
  jitter: 0.3,
  inset: [0.35, 0.7],
}
const ROCK_SHIELD = { shield: "standard" }

export const HAZARD_TRAITS = [
  { traits: { explosive: true }, fromSector: 3 },
  { traits: { shield: ROCK_SHIELD }, fromSector: 6 },
  { traits: { gun: ROCK_TURRETS }, fromSector: 10, weightPerSector: 0.12, weightCap: 4 },
  { traits: { gun: ROCK_TURRETS, shield: ROCK_SHIELD }, fromSector: 16 },
]

// What to call a rock carrying each trait, for the dev page that offers one of each: a
// trait key is what the rock is built from and not a word to put in front of a player.
export const HAZARD_NAMES = { explosive: "EXPLOSIVE", shield: "SHIELDED", gun: "ARMED" }

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
    mass: 0.04,
    damage: CONFIG.DMG_AST_GUN,
    energy: 6,
    reload: 2.4,
    speed: CONFIG.BULLET_SPEED,
    colour: PALETTE.weapon.gun,
    survivesDebris: true,
  },
  autocannon: {
    kind: "projectile",
    mass: 0.08,
    damage: CONFIG.DMG_RIVAL_GUN,
    energy: 8,
    reload: [1.1, 1.9], // range so multiple turrets drift out of sync
    speed: CONFIG.BULLET_SPEED,
    colour: PALETTE.weapon.gun,
    survivesDebris: true,
  },
  minerLaser: {
    kind: "beam",
    mass: 0.02,
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
    mass: 0.1,
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
    mass: 0.04,
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
    mass: 0.08,
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
  // The turret's other option: a stream of light rounds instead of single heavy
  // ones. It comes out ahead on damage a second and gives most of its reach away
  // for it, so it is a choice about how close the fight is rather than an upgrade.
  // Its rate needs three barrels to cycle, and it is drawn with them.
  defenseFlak: {
    kind: "projectile",
    mass: 0.08,
    damage: 14,
    energy: 2,
    reload: 0.1,
    range: 240,
    speed: 380,
    colour: PALETTE.player.turret,
  },
  // ---------------------------------------------------------------------------
  // ALIEN GUNS. They fire through the same modules and controllers as anything else:
  // what sets them apart is that they do their damage by bending the space a hull is
  // in, which is why they are slow, quiet and hard to read.
  //
  // `shot` is how a projectile draws itself, so a gun's rounds look like its own
  // rounds: `radius` is the ball, `streak` how far it smears back along its travel
  // (0 for a ball that does not), and `pulse` how fast it breathes. A gun without one
  // draws the streak every gun used to draw.
  // ---------------------------------------------------------------------------
  // What the turrets throw: slow, heavy and dodgeable, which is what makes a hull
  // ringed with them a problem of approach rather than a problem of reflexes.
  warpOrb: {
    kind: "projectile",
    mass: 0.08,
    damage: 150,
    energy: 10,
    reload: [1.3, 2.1],
    speed: 130,
    // It leans after what it was fired at rather than flying where it was pointed,
    // gently enough that flying around it still works: at this speed and this turn it
    // takes four seconds to come about, and it does not live that long.
    homing: { turn: 0.8, reach: 700 },
    shot: { radius: 5.5, streak: 0, pulse: 9 },
    // What it does to the space it is travelling through, which is how it does its
    // damage: `radius` in world units, `strength` how hard the picture is drawn inward.
    warp: { radius: 46, strength: 0.32 },
    // It lands like something with weight behind it: a shower of green off the point of
    // contact, a ring going out with it and a good shove of the screen. A round that
    // reaches nothing still comes apart, rather than winking out of existence.
    impact: {
      particles: 26,
      colour: PALETTE.alien.shot,
      speed: [70, 280],
      ring: { count: 14, speed: 210 },
      shake: 13,
      // And it tears the picture where it landed: the aliens are working on the universe
      // rather than on the ship, so what their shots damage includes the fabric the game
      // is drawn on. Over full strength, because it bursts and falls away fast: the first
      // moments are as broken as the screen gets.
      glitch: { strength: 1.6, radius: 300, seconds: 0.34 },
    },
    colour: PALETTE.alien.shot,
    survivesDebris: true,
  },
  // The pincer's main gun, and the reason it is shaped the way it is. A third kind of
  // shot: not a round and not a beam but a well, let go of into the jaws.
  //
  // `generate` is the wind-up, which is the telegraph. The hunter controller already
  // gives every heavy gun a charge before it fires; this one spends that charge dragging
  // in the particles and the loose shots around the muzzle, so what is coming is obvious
  // to anyone watching the mouth of it. It never drags rock: a sector heaving toward a
  // point is mayhem, and the contact solver would not survive it.
  //
  // `well` is what it lets go of. `pull` is how hard it drags, `bite` how far in it does
  // real damage, `damage` a second on the gravity channel, which nothing blocks - a
  // bubble is no help against the space it is sitting in. `collapse` is the shove when it
  // goes out.
  singularityGun: {
    kind: "well",
    mass: 0.24,
    damage: 0, // it does its damage by existing, see well.damage
    // What one costs, spent over the wind-up rather than at the shot. There is no reload
    // behind it: the cell is the limit, so how often one can be thrown is how fast the
    // cell fills, and everything else the cell pays for goes short while one is held.
    energy: 380,
    // It drifts rather than flies, slow enough to be outrun by anything with a drive, so
    // it is a place to be away from rather than a thing to duck. And it stays: long enough
    // that a sector with two of them in it has to be flown around rather than through.
    speed: 80,
    life: 16,
    homing: { turn: 0.5, reach: 900 },
    length: 700, // how far off it will start winding up
    // The front half of the ship. It winds up at anything ahead of it rather than only at
    // what is dead in the jaws, and the well leans after the target once it is away, so a
    // shot that starts wide still arrives.
    arc: 1.57,
    chargeTime: 2.2, // a long tell, because the answer is to not be in front of it
    sound: "bigLaser",
    colour: PALETTE.alien.beam,
    generate: { radius: 240, pull: 260, motes: 40 },
    // It arrives as a point and opens out over `grow` seconds, so what it does grows with
    // it: a well is at its worst once it is fully there.
    well: {
      // The fastest one is ever seen to move. They pull each other, which is worth
      // watching, and left unbounded they wind each other up past anything the player
      // can fly away from: three times the speed one is thrown at is quick enough to
      // read as falling together and slow enough to still be a place to be away from.
      terminal: 240,
      radius: 210,
      bite: 120,
      pull: 340,
      damage: 260,
      collapse: 220,
      core: 17,
      grow: 0.9,
      motes: 26, // struck off the rim and thrown inward, so the accretion can be seen
      // How badly the whole picture holds up when the ship is inside one. Nothing at the
      // edge of its reach and this at the middle: not enough to fight through, enough that
      // being in there is unmistakable.
      nearGlitch: 0.3,
    },
    // And the space around it does not merely bend, it rings: the strongest distortion in
    // the game, and the only one that puts waves through what is behind it. Tighter than
    // the reach of the well itself, so what is bent is the hole rather than the room.
    warp: { radius: 130, strength: 0.55, wave: 0.4 },
  },
  // The alien seeker's: a snap, as its rival counterpart's is.
  warpNeedle: {
    kind: "beam",
    mass: 0.04,
    damage: 45,
    // It cuts by bending what it crosses, so the bend is the shot: close in along the
    // whole length of it, and gentle enough to be felt rather than looked at.
    warp: { radius: 26, strength: 0.16 },
    energy: 24,
    reload: [0.9, 1.4],
    length: 440,
    width: 3,
    glow: 16,
    arc: 0.35,
    chargeTime: 0.22,
    sound: "snapLaser",
    colour: PALETTE.alien.beam,
  },
  // And the alien scout's, which cuts rock for ore exactly as a miner's does. They
  // compete for the same sector.
  warpCutter: {
    kind: "beam",
    mass: 0.02,
    damage: 30,
    // It cuts by bending what it crosses, so the bend is the shot: close in along the
    // whole length of it, and gentle enough to be felt rather than looked at.
    warp: { radius: 30, strength: 0.2 },
    energy: 16,
    reload: [1.4, 2.6],
    length: [320, 520],
    width: 2.4,
    glow: 18,
    triggerRange: 420,
    colour: PALETTE.alien.beam,
  },
  // The player's cutting beam, in the marks the shop sells. Each states the whole
  // gun rather than a multiplier on the one below, so what a mark does is read off
  // its own entry instead of out of four tables indexed in parallel.
  //
  // Reach is the point of charging, so damage follows it only gently:
  // `chargeDamageMult` runs from the first entry at chargeMin to the second at
  // chargeMax. Set both to 1 to make charge buy reach alone.
  //
  // A Mk I shot at full charge lands 68, which no shielded rival loses its shield
  // to in one hit: 2 shots to strip a scout and a third to cut it, 4 to strip a
  // frigate and a fifth to cut it. Mk IV takes one shot off each of those.
  ...laserMarks({
    playerLaserMk1: {},
    playerLaserMk2: { chargeRate: 1044 },
    playerLaserMk3: { chargeRate: 1044, chargeCost: 83 },
    playerLaserMk4: { chargeRate: 1044, chargeCost: 83, damage: 57 },
    playerLaserMk5: { chargeRate: 1044, chargeCost: 83, damage: 57, canOverdrive: true },
  }),
}

// One mark of the player's beam: the shared gun with what this mark changes on top.
function laserMarks(marks) {
  const base = {
    kind: "beam",
    // Flat across the marks: a better beam is a better beam, not a bigger one.
    mass: 0.03,
    chargeable: true,
    damage: 38,
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
  }
  return Object.fromEntries(
    Object.entries(marks).map(([name, mark]) => [name, { ...base, ...mark }]),
  )
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
//
// `efficiency` is energy drained per point of damage, so a lower one is a better
// bubble. A number covers every channel the shield blocks; an object states it per
// channel, for a bubble braced against one kind of fire and poor against another.
// A channel a shield blocks but does not price drains a point for a point.
// ---------------------------------------------------------------------------
// A shield overloads (switches off) when energy falls to `dropAt` of the host's
// capacity, and only comes back once `recoverDelay` seconds have passed AND
// energy has recharged to `recoverAt`. The player's shield drops only at empty
// and recovers instantly, so its behaviour matches the old energy bar.
export const SHIELD_TYPES = {
  standard: {
    mass: 0.17,
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
    mass: 0.13,
    efficiency: 0.8,
    blocks: ["projectile"],
    sides: 6,
    colour: PALETTE.shield.deflector,
    dropAt: 0.12,
    recoverAt: 0.35,
    recoverDelay: 1,
  },
  // The frigate's: braced against small-arms fire and poor against a beam. What
  // shoots at a hull that size is mostly autocannon and the player's turret, and a
  // slab that a turret strips in a second and a half is not a siege ship. It pays
  // for that on the laser channel, so the answer to a frigate is the beam - which is
  // the weapon that cuts it in half in any case.
  //
  // Eight sides rather than six because it is the largest bubble in the game and the
  // one where the drawn shape parts company with the collided circle most; see
  // KNOWN_ISSUES.md.
  // What the aliens carry, and not a bubble at all. It leans on the rock and the loose
  // shot around the hull and pays for what it turns away, so a hull in open space runs
  // it for almost nothing and one backed into a rock field bleeds. A laser it absorbs
  // the way any shield does.
  //
  // `solid: false` is the difference between leaning on something and stopping it: a
  // rock is pushed rather than parked against a wall, and a rock pushing hard enough
  // arrives anyway. Nor does it block shot, so a fast round punches through what a
  // slow one is turned away from. Hulls are not repelled at all, so the pincer's mouth
  // is as dangerous as it looks.
  //
  // It holds down to almost nothing and takes four and a half seconds to come back,
  // which is the window a hull can be cut in. Twelve sides where everything else has
  // six, turning the other way and breathing faster: a surface being held there rather
  // than switched on. It is also much rounder, which matters most here - see
  // KNOWN_ISSUES.md.
  alienField: {
    mass: 0.1,
    solid: false,
    efficiency: { laser: 1.15 },
    blocks: ["laser"],
    repel: {
      // Rock is leant on, shot is turned away before it can arrive, and a hull is held
      // off: enough that the last stretch of an approach has to be earned, not enough
      // that it cannot be flown at all.
      force: { asteroids: 900, projectiles: 3600, player: 800, rivals: 800 },
      energyPerPush: 0.02,
    },
    // It stands well clear of the hull, because a field that pushes needs somewhere to
    // push in: at the bubble's own radius the pincer had 30 units of standoff against a
    // hull reaching 92, and a rock was through it before it had leant on anything.
    standoff: 1.4,
    sides: 12,
    spin: -0.5,
    pulseRate: 4.2,
    pulseDepth: 0.2,
    colour: PALETTE.alien.shield,
    dropAt: 0.08,
    recoverAt: 0.7,
    recoverDelay: 4.5,
  },
  bulwark: {
    mass: 0.5, // heavy even for a bubble, as one braced against shot should be
    efficiency: { projectile: 0.55, laser: 1.6 },
    blocks: ["laser", "projectile"],
    sides: 8,
    colour: PALETTE.shield.bulwark,
    dropAt: 0.18,
    recoverAt: 0.6,
    recoverDelay: 3,
  },
  // The player's, in the marks the shop sells. `efficiency` is energy drained per
  // point of damage, so a lower one is a better bubble; each mark states its own
  // rather than a table of multipliers being applied on top.
  ...playerShields({
    playerShieldMk1: { efficiency: 2 },
    playerShieldMk2: { efficiency: 1.44 },
    playerShieldMk3: { efficiency: 1 },
    playerShieldMk4: { efficiency: 0.64 },
  }),
}

// One mark of the player's bubble: the shared shield with its own efficiency.
function playerShields(marks) {
  const base = {
    // A bubble generator is the heaviest thing the shop sells, and the same weight at
    // every mark: a better one is a better emitter, not a bigger installation. A
    // shieldless run is a quarter lighter than a fitted one and handles like it.
    mass: 0.17,
    blocks: ["laser", "projectile"],
    sides: 6,
    colour: PALETTE.shield.standard,
    dropAt: 0.15,
    recoverAt: 0.35,
    recoverDelay: 1.2,
  }
  return Object.fromEntries(
    Object.entries(marks).map(([name, mark]) => [name, { ...base, ...mark }]),
  )
}

// ---------------------------------------------------------------------------
// ENGINE TYPES - what pushes a hull along. An engine is a module like a weapon or
// a shield: it mounts on a hardpoint, so how hard a ship accelerates follows from
// what is bolted to it and where, not from a number on the type.
//
//   thrust  what one of these puts out
//   reverseAmount
//           what it manages backwards, as a fraction of its thrust. Absent or
//           zero means it cannot reverse at all, which is most of them: a nozzle
//           pointed one way pushes one way. A separate `canReverse` flag would
//           only be `reverseAmount > 0` written twice, with room to disagree.
//   plume   the exhaust it draws. `rate` is plumes a second, `speed` how hard
//           they are thrown back (which is also how long each streak draws),
//           `life` how long they linger, `spread` how much they fan out and
//           `width` how wide the throat is, which spreads where a plume starts
//           rather than where it goes: a wide nozzle is already broad where it
//           leaves the hull. Omit `width` for a point emitter.
//   flame   the fire at the throat while the drive is lit, which is drawn rather
//           than thrown: `length` is how far it reaches back, `flicker` how much of
//           that it gains and loses frame to frame, `width` how wide it is at the
//           throat (the plume's, unless it says otherwise) and `colour` what it
//           burns (the plume's, unless it says otherwise). All in world units. Omit
//           the block for a drive that shows nothing but its plume.
//   colour  the plume's colour
//
// A main engine pushes along the hull's facing and cannot reverse, so a hull driven
// by these alone sweeps through a turn instead of pivoting in place. Turning on the
// spot is a maneuvering thruster's job, and they are core equipment: see
// THRUSTER_TYPES. Nothing a drive states has any bearing on how fast its hull comes
// about, so fitting a bigger one makes a ship faster and not nimbler.
// ---------------------------------------------------------------------------
export const ENGINE_TYPES = {
  // One broad nozzle, thrown wide and slow: a dart that scoots.
  pulseDrive: {
    thrust: 100,
    mass: 0.03,
    plume: { rate: 26, speed: 55, life: 0.4, spread: 20 },
    flame: { length: 6, flicker: 4, width: 6 },
    colour: PALETTE.rival.hull,
  },
  // A tight pair, cycling fast and barely fanning at all, so the seeker reads as
  // driven rather than blown along.
  ionDrive: {
    thrust: 75,
    mass: 0.02,
    plume: { rate: 40, speed: 30, life: 0.48, spread: 4 },
    flame: { length: 5, flicker: 3, width: 3 },
    colour: PALETTE.rival.hull,
  },
  // A long heavy plume: a single small stream read far too light for a hull the
  // size of a frigate.
  siegeDrive: {
    thrust: 100,
    mass: 0.16,
    plume: { rate: 44, speed: 150, life: 0.62, spread: 26, width: 9 },
    flame: { length: 16, flicker: 8 }, // as wide as the throat it comes out of
    colour: PALETTE.rival.hull,
  },
  // The aliens'. The same thrust as the rival drives of each tier, so the hulls handle as
  // they did, and nothing else about them is the same: green where everything else here is
  // orange, and a fire with a rounded throat and a long tail rather than a short hard V.
  swarmDrive: {
    thrust: 100,
    mass: 0.03,
    plume: { rate: 30, speed: 48, life: 0.55, spread: 14 },
    flame: { length: 13, flicker: 5, width: 7, round: true, colour: PALETTE.alien.exhaustFlame },
    colour: PALETTE.alien.exhaust,
  },
  stalkerDrive: {
    thrust: 75,
    mass: 0.02,
    plume: { rate: 42, speed: 34, life: 0.6, spread: 5 },
    flame: { length: 11, flicker: 4, width: 4, round: true, colour: PALETTE.alien.exhaustFlame },
    colour: PALETTE.alien.exhaust,
  },
  pincerDrive: {
    thrust: 100,
    mass: 0.16,
    plume: { rate: 46, speed: 120, life: 0.8, spread: 20, width: 9 },
    flame: { length: 34, flicker: 12, round: true, colour: PALETTE.alien.exhaustFlame },
    colour: PALETTE.alien.exhaust,
  },
  // The player's, and the one thing the hull starts with that can be replaced by
  // something better. It pushes one way, like every other engine here.
  minerDrive: {
    thrust: 270,
    mass: 0.05,
    plume: { rate: 30, speed: 60, life: 0.4, spread: 18, width: 4 },
    // Broader than the throat and paler than the plume: a yard drive run hot.
    flame: { length: 13, flicker: 8, width: 8, colour: PALETTE.player.exhaustFlame },
    colour: PALETTE.player.exhaust,
  },
  // Vanes that can turn the thrust around, at the cost of some of it: the plumbing
  // to point a nozzle backwards is mass and volume that is not making thrust. That
  // is the trade, and it is in the numbers rather than in a rule.
  vectoredDrive: {
    thrust: 225,
    // The same mass as the drive it replaces: the plumbing that turns the thrust
    // around is already paid for in thrust, and charging for it twice would make the
    // vanes a straight downgrade.
    mass: 0.05,
    reverseAmount: 0.6,
    plume: { rate: 30, speed: 60, life: 0.4, spread: 18, width: 4 },
    // Shorter than the miner drive's, since there is less thrust behind it, and
    // split around the vanes that turn it.
    flame: { length: 9, flicker: 6, width: 9, colour: PALETTE.player.exhaustFlame },
    colour: PALETTE.player.exhaust,
  },
}

// ---------------------------------------------------------------------------
// THRUSTER TYPES - the small nozzles set around a hull that bring it about, which
// is core equipment rather than something bolted to the outline: a ship has a set of
// them or it cannot steer at all.
//
// `torque` is what the set puts out. What that becomes in radians a second is the
// hull's business, since the same nozzles turn a dart smartly and barely trouble a
// slab: see SHIP_SCALARS.turnPerReach.
//
// This is deliberately separate from the drive. A frigate with a pair of siege
// engines has plenty of thrust and no way to use it sideways, so it sweeps through a
// long arc; the player pivots on the spot because the yard fitted a gimbal ring, not
// because the miner drive is strong.
// ---------------------------------------------------------------------------
export const THRUSTER_TYPES = {
  // Cold gas, cheap and adequate: what a working hull leaves the yard with.
  attitudeJets: { torque: 100, mass: 0.01 },
  // Vanes on a ring, the set that pivots rather than sweeps. The player's, and what
  // the controls were tuned against.
  gimbalRing: { torque: 150, mass: 0.02 },
  // The shop's other set. It is not simply better: on a keyboard a turn is held at
  // full deflection or not at all, so a fifth more torque is a fifth more overshoot
  // on a key held a beat too long. A stick gives everything in between and pays less
  // for it. The trade is in the control rather than in a number here.
  vectorJets: { torque: 180, mass: 0.02 },
  // Heavier nozzles for a heavier hull. More torque than either of the above and
  // nowhere near enough to make a slab handle: a frigate comes about in 18 seconds
  // with these, which is the point of a frigate.
  siegeJets: { torque: 200, mass: 0.1 },
}

// What a design's maneuvering thrusters add up to, which is what brings it about.
export function torqueOf(type) {
  let total = 0
  for (const entry of loadoutModules(type)) {
    if (entry.thruster) {
      total += THRUSTER_TYPES[entry.thruster].torque
    }
  }
  return total
}

// One mark of the player's survey set: everything it can pick out, at any range.
function surveyMarks(marks) {
  return Object.fromEntries(
    Object.entries(marks).map(([name, sees]) => [name, { mass: 0.01, sees }]),
  )
}

// What a design's engines add up to, which is what pushes it. A hull with none
// mounted does not move under its own power.
export function thrustOf(type) {
  let total = 0
  for (const entry of loadoutModules(type)) {
    if (entry.engine) {
      total += ENGINE_TYPES[entry.engine].thrust
    }
  }
  return total
}

// ---------------------------------------------------------------------------
// CORE TYPES - the power plant a hull is built around, and the room it has for
// the equipment that runs off it.
//
//   energy   the cell's capacity
//   regen    how fast it refills
//   shield   how many shields it will carry, normally one
//   radar    how many radar sets, normally one
//   thruster how many sets of maneuvering thrusters, normally one. A hull with none
//            fitted cannot come about at all, so every core has room for a set.
//   special  room for the equipment a run buys: the ore magnet to start with, and
//            whatever is found or bought after it
//
// `levels` is a core the shop can upgrade, one entry per level, each stating the
// whole plant rather than a delta. Energy and slots move together on purpose: a
// slot is only worth having if there is cell to run what goes in it, and the
// specials that drain take a fraction of the cell rather than a flat amount, so
// paying for room is also paying for the power to use it. A core without `levels`
// is what it is, which is every hull but the player's.
//
// Energy is not one of the slots. A hull without a cell is not a hull with an
// empty slot, it is a hull that does not work, so the core supplies it by being
// fitted at all and no design can fail to power itself. What is optional sits in
// the named slots, which is also what tells the editor which lists to offer.
//
// One core carries the lot, so a shield, a radar and a magnet need no hardpoints
// scattered over the hull to sit on.
// ---------------------------------------------------------------------------
export const CORE_TYPES = {
  // A dart's: barely enough to run a mining laser, with nothing spare.
  prospectorCore: {
    mass: 0.03,
    energy: 90,
    regen: 22,
    shield: 1,
    radar: 1,
    thruster: 1,
    special: 0,
  },
  // A hunter's: a deep cell, because a beam that snaps costs more than a gun.
  seekerCore: { mass: 0.08, energy: 300, regen: 34, shield: 1, radar: 1, thruster: 1, special: 0 },
  // A siege hull's: feeds four turrets and a cannon between them.
  siegeCore: { mass: 0.2, energy: 260, regen: 30, shield: 1, radar: 1, thruster: 1, special: 0 },
  // The aliens' own plants. They are larger than the rival cores of the same tier for a
  // reason that is in the machinery rather than in the fiction: a bubble only costs
  // energy when something hits it, while a repel field pays for everything it holds off,
  // and an alien arrives into a sector already thick with other people's fire. A pincer
  // on a siege core had its field stripped by five charged beam shots; on this it takes
  // sixteen, and eight from the mark the shop finishes with.
  swarmCore: { mass: 0.05, energy: 260, regen: 28, shield: 1, radar: 1, thruster: 1, special: 0 },
  stalkerCore: { mass: 0.12, energy: 420, regen: 32, shield: 1, radar: 1, thruster: 1, special: 0 },
  pincerCore: { mass: 0.3, energy: 800, regen: 34, shield: 1, radar: 1, thruster: 1, special: 0 },
  // The player's, and the only one the shop can improve. Each level is a bigger
  // cell, a faster refill and another slot to spend it through.
  minerCore: {
    // One mass for every level: a bigger cell is a denser one, not a larger plant, so
    // buying the next mark is never a handling downgrade.
    mass: 0.06,
    shield: 1,
    radar: 1,
    thruster: 1,
    // One level per slot, so every purchase earns room as well as cell. A fifth
    // level would be energy alone, which is the shape this replaced.
    levels: [
      {
        energy: 320,
        regen: 32,
        special: 1,
        name: "CORE MK I",
        desc: "The yard's cell. One special slot, and enough charge for a few shots.",
      },
      {
        energy: 630,
        regen: 60,
        special: 2,
        name: "CORE MK II",
        desc: "630 charge, refilling at 60 a second, and a second special slot.",
      },
      {
        energy: 950,
        regen: 88,
        special: 3,
        name: "CORE MK III",
        desc: "950 charge at 88 a second, and a third slot to spend it through.",
      },
      {
        energy: 1260,
        regen: 116,
        special: 4,
        name: "CORE MK IV",
        desc: "1260 charge at 116 a second, and the fourth slot: everything the hull will take.",
      },
    ],
  },
}

// A core as it stands at `level`: its own fields, with the level's on top. A core
// with no levels is the same at every level, which is what a rival's is.
export function coreAt(type, level = 0) {
  if (!type) {
    return null
  }
  if (!type.levels) {
    return type
  }
  return { ...type, ...type.levels[clamp(level, 0, type.levels.length - 1)] }
}

// The core a design is built around, which is where its energy comes from.
export function coreOf(type) {
  for (const entry of type.loadout || []) {
    if (entry.core) {
      return CORE_TYPES[entry.core]
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// RADAR TYPES - core equipment, and what a hull knows about the sector it is in.
// `sees` is an effective range per kind of thing: `ships`, `rocks`, `ore` and
// `specials`. A kind left out is one this set cannot pick up at all, beyond the
// floor below.
//
// Every hull, radar or not, sees whatever is close enough to be on screen. That
// floor is a circle a little larger than the view's half-diagonal, so a hull can
// always see what someone looking at it can, and a set is only worth carrying for
// what it finds beyond that.
//
// A range is what the hull knows, not what it can shoot: a gun still holds fire
// until its target is on screen.
// ---------------------------------------------------------------------------
export const RADAR_TYPES = {
  // The player's, in the marks the shop sells. Each adds a kind of thing to what the
  // set will pick out beyond the sensor floor, in the order a run comes to need
  // them: rock is the work, ore matters once something else is competing for it,
  // and hulls matter once they are worth avoiding.
  ...surveyMarks({
    surveyMk1: { rocks: Infinity },
    surveyMk2: { rocks: Infinity, ore: Infinity },
    surveyMk3: { rocks: Infinity, ore: Infinity, ships: Infinity },
    surveyMk4: { rocks: Infinity, ore: Infinity, ships: Infinity, specials: Infinity },
  }),
  // A hunter's: tuned for hulls and vague about the scenery. It loses the player
  // across the full width of the arena, which is 1720 corner to corner.
  huntingArray: {
    mass: 0.01,
    sees: { ships: 1000, rocks: 600 },
  },
  // A miner's: finds rock and ore a long way off and notices a hull late, which is
  // why a scout is so often surprised.
  prospectorArray: {
    mass: 0.01,
    sees: { rocks: 1200, ore: 900, ships: 600 },
  },
}

// ---------------------------------------------------------------------------
// FACTIONS - who shoots at whom. One entry per side, listing the sides it is
// hostile to, and Game.hostileTarget is the only thing that reads it: every gun
// and every hull that steers at something asks that one question, so no
// behaviour has to know which sides exist.
//
// A ship type states its own `faction` and defaults to `rival` without one, so a
// new hull is still a shape and three numbers. `hazard` is what everything else
// is: a rock, and the wreckage cut from a hull. Armed rocks shoot at the player
// and at nothing else, which is what they have always done, and keeping them off
// the rivals' backs is deliberate - a sector where the scenery fights the AI is a
// sector the player can sit out.
// ---------------------------------------------------------------------------
export const FACTIONS = {
  player: ["rival", "alien"],
  rival: ["player", "alien"],
  alien: ["player", "rival"],
  hazard: ["player"],
}

// ---------------------------------------------------------------------------
// SHIP STATS - how a ship's settings come out of what the ship is.
//
// An outline is in world units, as a rock's vertices are, so how big a hull is
// can be read off its own coordinates and two hulls can be compared by looking
// at them. A type then states two numbers a person can hold in their head:
//
//   mass    how heavy the hull is, on the scale a rock's mass is on
//   armour  plating quality, as hull points per unit of hull area
//
// and bolts engines to it, which is where its thrust comes from.
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
// `handling` is the exception that is meant to be reached for: a plain multiplier
// on the turn rate the shape implies, for a hull that should be more or less
// nimble than its geometry says. Nothing states one, so every hull turns as its
// shape and mass dictate.
// ---------------------------------------------------------------------------
export const SHIP_SCALARS = {
  // Top speed, as a multiple of acceleration. Taken from the player's hull, which
  // was flown at 340 on 270 of thrust long before any of this was derived: that
  // pair was tuned against the controls by hand, so it is the one measurement here
  // worth calibrating against. Rounded, which puts the player at 340.2.
  speedPerAccel: 1.26,
  // turnRate = torque * this / (mass * reach): nozzles set around the hull act at a
  // moment arm proportional to its reach, against a spin inertia that grows with
  // mass and with reach squared, so one power of the reach cancels. The torque is
  // the maneuvering thrusters' and has nothing to do with the drive.
  //
  // Taken from the player, as speedPerAccel is: 3.2 radians a second on a hull of
  // mass 1 reaching 18 units, with the gimbal ring's 150 behind it.
  turnPerReach: 0.384,
  dragPerMass: 0.39, // drag = 1 - this / mass: a heavy hull coasts, a light one bites
  shieldClearance: 1.33, // the bubble, as a multiple of how far the outline reaches
  hullWidthBase: 1.74, // outline weight, which grows a little with the hull
  hullWidthPerUnit: 0.0036, // per world unit of reach
  hullPerArea: 0.11, // hull = armour * hull area * this
  // rockContact is set so a full-speed ram costs about this much of the hull.
  // Rivals steer for ore and rocks and shoulder them aside constantly, so
  // charging them the player's flat rate kills them faster than they can do
  // anything interesting: at 1 a scout does not survive a single ram and a
  // rival's median life falls from 24s to 5s.
  ramSurvivability: 0.7,
  // How much of itself a hull has to keep to survive being cut. Under this it comes apart
  // as it always did; over it, the piece that was taken off drifts away burning and the
  // ship carries on with a flat edge where it used to be.
  //
  // The other half of the test is that what is left is still bigger than the smallest
  // piece its own material holds together in, which is what keeps this off the small
  // hulls: the whole of a scout is a sixth of that, so any cut at all still finishes one.
  cutSurvival: 0.72,
  // And a ceiling for the hulls that are tough or slow enough that a ram cannot
  // threaten them anyway, which the formula would otherwise put on the player's
  // full rate. The player is the one hull meant to fear a rock.
  maxRockContact: 0.6,
}

// Area the outline encloses, and how far it reaches from the origin. Both in world
// units, since that is what an outline is in.
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

// What the shape alone decides, for any hull including the player's. Both come out
// in world units, so nothing downstream has a scale left to apply.
function hullShape(type) {
  const reach = outlineReach(type.outline)
  return {
    // How far the hull reaches, which is how big the ship is. A hull can now be
    // sized against another by reading this rather than by multiplying two
    // numbers whose scales were not comparable.
    boundRadius: reach,
    bubbleRadius: reach * SHIP_SCALARS.shieldClearance,
    hullWidth: SHIP_SCALARS.hullWidthBase + reach * SHIP_SCALARS.hullWidthPerUnit,
  }
}

// Every module a design carries, whether mounted on a hardpoint or fitted inside the
// core. One walk, so nothing adding up a loadout has to remember that a shield might
// sit in a core rather than on the hull.
export function* loadoutModules(type) {
  for (const entry of type.loadout || []) {
    yield entry
    for (const [slot, name] of Object.entries(entry.fitted || {})) {
      yield { [slot]: name }
    }
  }
}

// Which registry each kind of module lives in, so an entry can be looked up without
// being asked what it is first.
const MODULE_REGISTRIES = {
  weapon: WEAPON_TYPES,
  shield: SHIELD_TYPES,
  engine: ENGINE_TYPES,
  radar: RADAR_TYPES,
  thruster: THRUSTER_TYPES,
  core: CORE_TYPES,
}

// What one module weighs, whichever kind it is. Equipment that states no mass weighs
// nothing, so a hull is never quietly heavier than its own numbers say.
export function moduleMass(entry) {
  let total = 0
  for (const [kind, registry] of Object.entries(MODULE_REGISTRIES)) {
    if (entry[kind]) {
      total += registry[entry[kind]].mass ?? 0
    }
  }
  return total
}

// What a design weighs with its loadout aboard: the bare hull plus everything on it.
export function ladenMass(type) {
  let total = type.mass
  for (const entry of loadoutModules(type)) {
    total += moduleMass(entry)
  }
  return total
}

// How a hull flies, from what it weighs and what is bolted to it. One place, so a
// type worked out at boot and a ship refitted in the shop cannot come to different
// answers about the same ship. `stated` is whatever the type wrote down itself,
// which always wins.
//
// Everything here divides by mass, so this is where equipment is felt: a hull is its
// own mass plus everything fitted, and fitting more costs acceleration, top speed,
// turn and bite in that order.
export function flightStats({ mass, reach, thrust, torque, handling = 1, hull = 0, stated = {} }) {
  const k = SHIP_SCALARS
  const given = (field, value) => (stated[field] !== undefined ? stated[field] : value)
  const accel = given("accel", thrust / mass)
  const maxSpeed = given("maxSpeed", accel * k.speedPerAccel)
  return {
    accel,
    maxSpeed,
    turnRate: given("turnRate", (torque * k.turnPerReach * handling) / (mass * reach)),
    drag: given("drag", clamp(1 - k.dragPerMass / mass, 0.05, 0.98)),
    // What a rock costs the hull, which follows from how much hull there is and how
    // fast it can arrive: a full-speed ram takes about `ramSurvivability` of it,
    // whatever the ship. It belongs here because it moves when either does, so a hull
    // refitted with a faster drive learns to fear a rock more.
    rockContact: given(
      "rockContact",
      clamp(
        (k.ramSurvivability * hull) / (maxSpeed * CONFIG.ROCK_IMPACT_DAMAGE),
        0.05,
        k.maxRockContact,
      ),
    ),
  }
}

// The flight settings, which a design may stand in front of by stating one.
const FLIGHT_FIELDS = ["accel", "maxSpeed", "turnRate", "drag", "rockContact"]

// Hull points: armour over the area the outline encloses, so a bigger hull of the same
// stuff takes more killing. Shared, because the player is a hull like any other and its
// own is worked out from its own shape.
export function hullPoints(type) {
  return Math.round(type.armour * outlineArea(type.outline) * SHIP_SCALARS.hullPerArea)
}

// Fill in everything a type has not stated for itself.
export function deriveShipStats(type) {
  const stated = (field, value) => (type[field] !== undefined ? type[field] : value)
  const reach = outlineReach(type.outline)
  const core = coreOf(type)
  const laden = ladenMass(type)
  const hull = stated("hull", hullPoints(type))
  const flight = flightStats({
    mass: laden,
    reach,
    thrust: thrustOf(type),
    torque: torqueOf(type),
    handling: type.handling ?? 1,
    hull,
    stated: type,
  })
  const shape = hullShape(type)
  // Which of the flight settings this design wrote down for itself. Kept apart
  // because a derived type and a design that stated the same value are otherwise
  // indistinguishable, and a ship refitted mid-run has to know the difference: it
  // recomputes what was derived and must leave what was stated alone.
  const flightOverrides = {}
  for (const field of FLIGHT_FIELDS) {
    if (type[field] !== undefined) {
      flightOverrides[field] = type[field]
    }
  }
  return {
    ...type,
    ...flight,
    flightOverrides,
    // What the hull weighs with its loadout aboard, which is the mass everything
    // else divides by. `mass` stays what the type stated: the bare hull.
    laden,
    hull,
    energyMax: stated("energyMax", core ? core.energy : 0),
    regen: stated("regen", core ? core.regen : 0),
    boundRadius: shape.boundRadius,
    bubbleRadius: stated("bubbleRadius", shape.bubbleRadius),
    hullWidth: stated("hullWidth", shape.hullWidth),
  }
}

// ---------------------------------------------------------------------------
// SHIP TYPES - a shape, three numbers, and what the simulation cannot work out
// for itself. `hardpoints` are attachment slots in local space (role is
// documentation); `loadout` mounts modules onto them by index. `arms` are
// optional modules the spawner rolls, each with a per-sector chance that ramps
// from the type's spawn sector up to its cap.
//
// The spawner reads `spawn`, which is weighed like every other pool (see
// WEIGHTS): a type joins the roll at its `fromSector` and takes a share of
// arrivals equal to its `weight` over the total of whatever else is eligible.
// `maxConcurrent` takes it out of the running while that many are already alive,
// and a type without one is always available, so at least one always is.
//
// The rest is what a type does rather than what it is made of, so no code tests
// a ship by name: `debris` sizes the explosion, `debrisMaterial` says what its
// wreckage is made of, and `hunts` says it steers for the player instead of for
// ore and rocks.
//
// Debris takes its mass from its area, being rock from then on, so wreckage
// weighs less than the ship it was cut from.
//
// What drives a hull and what turns it are both fitted rather than stated: engines
// on hardpoints (ENGINE_TYPES) and a set of maneuvering thrusters in the core
// (THRUSTER_TYPES). Every engine mounted emits, so two of them read as two streams.
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
  // A torn hull burns for a good while and is meant to be seen doing it. The rates are
  // particles a second at full heat, and the colours are what that fire, its falling
  // embers and its smoke are made of, so the material decides how a cut hull looks and
  // no drawing code holds a colour of its own.
  burn: {
    seconds: 16.0,
    rate: 44,
    smokeRate: 16,
    colour: PALETTE.fx.fire,
    ember: PALETTE.fx.ember,
    smoke: PALETTE.fx.smoke,
  },
  // A hull fragment is a shell rather than a boulder, so it comes apart at a fraction
  // of what rock takes: above the drift of a rock field and well under the speed a
  // wreck is thrown at, so a piece still carrying its ship's momentum bursts on the
  // first thing it meets and one that has slowed to a drift is shouldered aside.
  shatterAt: 120,
}

// What an alien hull is made of. The same stuff by the numbers, burning in their own
// colour, so a sector strewn with wreckage still reads at a glance as to whose it is.
export const ALIEN_PLATING = {
  ...SHIP_PLATING,
  burn: {
    ...SHIP_PLATING.burn,
    colour: PALETTE.alien.fire,
    ember: PALETTE.alien.ember,
    smoke: PALETTE.alien.smoke,
  },
}
// ---------------------------------------------------------------------------

const SHIP_DESIGNS = {
  seeker: {
    outline: [
      [18, 0],
      [0, -5],
      [-2, -8],
      [-12, -8],
      [-10, -5],
      [-8, -5],
      [-10, 0],
      [-8, 5],
      [-10, 5],
      [-12, 8],
      [-2, 8],
      [0, 5],
    ],
    colour: PALETTE.ore.body,
    mass: 0.48, // the bare hull: its loadout adds 0.32 on top, see ladenMass
    armour: 1.2,
    // Its shape and its thrusters would have it coming about faster than the player, which
    // is not a dart's job: it is quick in a straight line and has to commit to a turn.
    handling: 0.8,
    lifeTime: [26, 36],
    hardpoints: [
      { local: [18, 0], role: "nose" },
      { local: [-5, 0], role: "gun" },
      { local: [-1, 0], role: "core" },
      { local: [-11, 6.5], role: "engine" },
      { local: [-11, -6.5], role: "engine" },
    ],
    loadout: [
      // `hunter` is the behaviour, not the ship: line up, wind up briefly, fire.
      { hp: 0, weapon: "seekerLaser", controller: "hunter" },
      { hp: 3, engine: "ionDrive" },
      { hp: 4, engine: "ionDrive" },
      {
        hp: 2,
        core: "seekerCore",
        fitted: { shield: "deflector", radar: "huntingArray", thruster: "gimbalRing" },
      },
    ],
    arms: {
      gun: {
        hp: 1,
        weapon: "autocannon",
        controller: "turret",
        chancePerSector: 0.05,
        chanceCap: 0.85,
      },
    },
    spawn: { fromSector: 8, weight: 1, weightPerSector: 0.3, weightCap: 4, maxConcurrent: 1 },
    hunts: true,
    // A dart lines up, fires and leaves rather than closing to a knife fight it cannot win.
    // Half its own beam's reach is close enough, and it will not sit in front of a ship that
    // is pointed at it inside the reach of a charged one. `turn` is what it manages while it
    // is going: an arc out, rather than spinning on the spot and running the other way.
    breakOff: { near: 210, facing: 0.55, aimedWithin: 520, hold: 1.3, turn: 0.5 },
    debrisMaterial: SHIP_PLATING,
    debris: { particles: 26, speed: 260, ring: 19, shake: 10 },
    killScore: 420,
    blastScore: 200,
    oreDrop: 0,
  },
  scout: {
    outline: [
      [17, 0],
      [-11, -12],
      [-6, -3],
      [-6, 3],
      [-11, 12],
    ],
    colour: PALETTE.rival.hull,
    mass: 0.6, // a light dart, and 0.1 of kit on top of it
    armour: 1,
    lifeTime: [16, 26],
    hardpoints: [
      { local: [17, 0], role: "nose" },
      { local: [2, 0], role: "gun" },
      { local: [0, 0], role: "core" },
      // in the notch cut out of the tail, so the plume leaves through it
      { local: [-6, 0], role: "engine" },
    ],
    loadout: [
      { hp: 0, weapon: "minerLaser", controller: "miner" }, // always has a mining laser
      { hp: 3, engine: "pulseDrive" },
      {
        hp: 2,
        core: "prospectorCore",
        fitted: { radar: "prospectorArray", thruster: "attitudeJets" },
      },
    ],
    arms: {
      gun: {
        hp: 1,
        weapon: "autocannon",
        controller: "turret",
        chancePerSector: 0.05,
        chanceCap: 0.85,
      },
      shield: {
        hp: 2,
        slot: "shield",
        shield: "standard",
        chancePerSector: 0.04,
        chanceCap: 0.8,
      },
    },
    spawn: { fromSector: 2, weight: 6 }, // the common one, and the one always available
    debrisMaterial: SHIP_PLATING,
    debris: { particles: 26, speed: 240, ring: 18, shake: 10 },
    killScore: 400,
    blastScore: 200,
    oreDrop: 5,
  },
  frigate: {
    outline: [
      [62, 16],
      [60, 24],
      [22, 24],
      [18, 16],
      [-18, 16],
      [-22, 24],
      [-68, 24],
      [-68, 10],
      [-64, 6],
      [-64, -8],
      [-68, -12],
      [-68, -24],
      [-22, -24],
      [-18, -16],
      [18, -16],
      [22, -24],
      [60, -24],
      [62, -16],
      [70, -14],
      [70, 14],
    ],
    colour: PALETTE.rival.frigateHull,
    // A slab: heavy, hard to turn, and thick with it. A quarter of what it weighs is what
    // it carries: two siege drives, a braced bubble and five guns.
    //
    // 1012 of hull, which is seven seconds of the player's flak once the bubble is down.
    // At 0.6 it was 380 and under three, so a turret finished a siege hull about as fast as
    // it stripped the bubble in front of it: the beam is meant to be the answer to one of
    // these, and a beam kills it by cutting rather than by wearing it down.
    mass: 4.45,
    armour: 1.6,
    lifeTime: [34, 50],
    hardpoints: [
      { local: [68, 0], role: "nose" },
      { local: [45, -21], role: "gun" },
      { local: [-45, -21], role: "gun" },
      { local: [45, 21], role: "gun" },
      { local: [-45, 21], role: "gun" },
      { local: [0, 0], role: "core" },
      // set either side of the tail, so the pair sweeps the hull round rather
      // than pivoting it
      { local: [-71, -14], role: "engine" },
      { local: [-71, 14], role: "engine" },
    ],
    loadout: [
      { hp: 0, weapon: "cannonLaser", controller: "hunter" },
      { hp: 1, weapon: "autocannon", controller: "turret" },
      { hp: 2, weapon: "autocannon", controller: "turret" },
      { hp: 3, weapon: "autocannon", controller: "turret" },
      { hp: 4, weapon: "autocannon", controller: "turret" },
      { hp: 6, engine: "siegeDrive" },
      { hp: 7, engine: "siegeDrive" },
      {
        hp: 5,
        core: "siegeCore",
        fitted: { shield: "bulwark", radar: "huntingArray", thruster: "siegeJets" },
      },
    ],
    spawn: { fromSector: 14, weight: 0.8, weightPerSector: 0.25, weightCap: 3, maxConcurrent: 1 },
    hunts: true, // steers for the player rather than for ore and rocks
    debrisMaterial: SHIP_PLATING,
    debris: { particles: 40, speed: 300, ring: 26, shake: 14 },
    killScore: 900,
    blastScore: 500,
    oreDrop: 9,
  },
  // ---------------------------------------------------------------------------
  // The aliens. One per rival tier, so the spawn tables and the controllers carry
  // over: a hull is still a shape, two numbers and what is bolted to it, and being
  // alien is a faction, a colour and (to come) how it is drawn.
  //
  // They are held back to the last stretch of the run, from sector 20: the sectors
  // before that are the game the player has learnt, and they also share the rivals'
  // arrival budget until they have one of their own, so an alien turning up is a rival
  // that did not. `fromSector` is the one dial for both, per hull.
  // ---------------------------------------------------------------------------
  // A pincer, the same length as a frigate and three times as wide, with its mouth
  // facing forward and a spike down the middle of it. Nothing about the shape is
  // decoration: it is the collision outline, the thing a beam crosses and the thing a
  // cut divides, so the mouth is a real void a rock can sit in without touching
  // anything.
  //
  // The jaw guns are held to the front: a mount states how far off the hull's facing
  // it can be brought to bear, and one buried in a jaw covers what is ahead and
  // nothing behind. The pair at the back traverse freely and mind whatever comes at
  // it, which is what makes them the defensive ones.
  //
  // Still to come, see ROADMAP.md: the glitch it should be drawn with.
  alienFrigate: {
    outline: [
      [-20, 25],
      [-15, 35],
      [0, 45],
      [20, 45],
      [35, 35],
      [75, 35],
      [80, 45],
      [30, 70],
      [0, 75],
      [-25, 70],
      [-50, 50],
      [-70, 25],
      [-70, 15],
      [-65, 10],
      [-65, -10],
      [-70, -15],
      [-70, -25],
      [-50, -50],
      [-25, -70],
      [0, -75],
      [30, -70],
      [80, -45],
      [75, -35],
      [35, -35],
      [20, -45],
      [0, -45],
      [-15, -35],
      [-20, -25],
      [-15, -10],
      [15, -5],
      [15, 5],
      [-15, 10],
    ],
    colour: PALETTE.alien.hull,
    faction: "alien",
    // The biggest of them bends the most, and reaches past its own jaws.
    // Space is never quite still around one of these. The pull is what bends what is
    // behind it; the wave is the ring in it, kept low enough to be felt rather than seen.
    warp: { radius: 190, strength: 0.42, wave: 0.07 },
    // Twice the material of a frigate for the same laden 6, which is what a hull this wide
    // and this hollow comes to. Bare here: its plant, field, drives and five guns make up
    // the rest.
    //
    // Tougher than the frigate it answers, as everything else about it is: 1456 of hull
    // against 1012, which is ten seconds of flak rather than seven.
    mass: 4.61,
    armour: 1.2,
    // It comes round twice as fast as its mass and its reach say it should. A hull this
    // slow to turn is fought by standing behind it, which is no fight at all: this is the
    // one that is supposed to be able to answer.
    handling: 2,
    lifeTime: [34, 50],
    hardpoints: [
      // On the tip of the spike, which is where the singularity goes when there is
      // one: for now it is a cannon, and a beam draws its muzzle here.
      { local: [15, 0], role: "nose" },
      { local: [70, -40], role: "gun" }, // in the jaws, facing forward
      { local: [70, 40], role: "gun" },
      { local: [-50, -40], role: "gun" }, // at the back, traversing freely
      { local: [-50, 40], role: "gun" },
      { local: [-40, 0], role: "core" },
      { local: [-70, -20], role: "engine" },
      { local: [-70, 20], role: "engine" },
    ],
    loadout: [
      // In the jaws, where the shape was drawn for it.
      { hp: 0, weapon: "singularityGun", controller: "hunter" },
      // Just under a right angle either side, so a jaw gun covers the mouth and the
      // approach to it and cannot answer anything astern.
      { hp: 1, weapon: "warpOrb", controller: "turret", arc: 1.5 },
      { hp: 2, weapon: "warpOrb", controller: "turret", arc: 1.5 },
      { hp: 3, weapon: "warpOrb", controller: "turret" },
      { hp: 4, weapon: "warpOrb", controller: "turret" },
      { hp: 6, engine: "pincerDrive" },
      { hp: 7, engine: "pincerDrive" },
      {
        hp: 5,
        core: "pincerCore",
        fitted: { shield: "alienField", radar: "huntingArray", thruster: "siegeJets" },
      },
    ],
    spawn: { fromSector: 30, weight: 0.3, weightPerSector: 0.15, weightCap: 2.5, maxConcurrent: 1 },
    hunts: true,
    debrisMaterial: ALIEN_PLATING,
    debris: { particles: 40, speed: 300, ring: 26, shake: 14 },
    killScore: 900,
    blastScore: 500,
    oreDrop: 9,
  },
  // The alien answer to the scout: a swept arrowhead with the same reach and the same
  // drive, fatter through the body, so it takes about as much cutting as its rival
  // counterpart and comes apart into ore rather than wreckage.
  alienScout: {
    outline: [
      [2, 0],
      [4, -3],
      [13, -3],
      [14, -5],
      [4, -9],
      [-6, -11],
      [-11, -11],
      [-16, -3],
      [-16, 3],
      [-11, 11],
      [-6, 11],
      [4, 9],
      [14, 5],
      [13, 3],
      [4, 3],
    ],
    colour: PALETTE.alien.hull,
    faction: "alien",
    // Space bends around it. Read by the view, which turns it into a lens over whatever
    // is behind the hull, so a sector with one in it looks wrong before a shot is fired.
    warp: { radius: 70, strength: 0.3, wave: 0.05 },
    mass: 0.58, // bare hull; its loadout brings it to the 0.7 of the scout it answers
    armour: 1,
    lifeTime: [16, 26],
    hardpoints: [
      { local: [2, 0], role: "nose" },
      { local: [-11, 0], role: "gun" },
      { local: [-9, 0], role: "core" },
      { local: [-16, 0], role: "engine" },
    ],
    loadout: [
      { hp: 0, weapon: "warpCutter", controller: "miner" },
      {
        hp: 2,
        core: "swarmCore",
        fitted: { radar: "prospectorArray", thruster: "attitudeJets" },
      },
      { hp: 3, engine: "swarmDrive" },
    ],
    arms: {
      gun: {
        hp: 1,
        weapon: "warpOrb",
        controller: "turret",
        chancePerSector: 0.08,
        chanceCap: 0.85,
      },
      shield: {
        hp: 2,
        slot: "shield",
        shield: "alienField",
        chancePerSector: 0.06,
        chanceCap: 0.8,
      },
    },
    spawn: { fromSector: 20, weight: 0.6, weightPerSector: 0.2, weightCap: 4, maxConcurrent: 2 },
    debrisMaterial: ALIEN_PLATING,
    debris: { particles: 26, speed: 240, ring: 18, shake: 10 },
    killScore: 400,
    blastScore: 200,
    oreDrop: 5,
  },
  // And to the seeker: a narrow dart with a forked tail, near enough the same hull as
  // the one it answers and a little quicker round for being shorter.
  alienSeeker: {
    outline: [
      [4, 0],
      [2, -2],
      [16, -2],
      [14, -4],
      [-5, -7],
      [-8, -5],
      [-9, -5],
      [-11, 0],
      [-9, 5],
      [-8, 5],
      [-5, 7],
      [14, 4],
      [16, 2],
      [2, 2],
    ],
    colour: PALETTE.alien.hull,
    faction: "alien",
    warp: { radius: 66, strength: 0.28, wave: 0.05 },
    mass: 0.47, // bare hull; laden it matches the seeker at 0.8
    armour: 1.2,
    handling: 0.8, // as its rival counterpart: quick in a line, committed in a turn
    lifeTime: [26, 36],
    hardpoints: [
      { local: [4, 0], role: "nose" },
      { local: [-6, 0], role: "gun" },
      { local: [-2, 0], role: "core" },
      { local: [-9, 3], role: "engine" },
      { local: [-9, -3], role: "engine" },
    ],
    loadout: [
      { hp: 0, weapon: "warpNeedle", controller: "hunter" },
      {
        hp: 2,
        core: "stalkerCore",
        fitted: { shield: "alienField", radar: "huntingArray", thruster: "gimbalRing" },
      },
      { hp: 3, engine: "stalkerDrive" },
      { hp: 4, engine: "stalkerDrive" },
    ],
    arms: {
      gun: {
        hp: 1,
        weapon: "warpOrb",
        controller: "turret",
        chancePerSector: 0.08,
        chanceCap: 0.85,
      },
    },
    spawn: { fromSector: 25, weight: 0.4, weightPerSector: 0.18, weightCap: 3, maxConcurrent: 1 },
    hunts: true,
    // A dart lines up, fires and leaves rather than closing to a knife fight it cannot win.
    // Half its own beam's reach is close enough, and it will not sit in front of a ship that
    // is pointed at it inside the reach of a charged one. `turn` is what it manages while it
    // is going: an arc out, rather than spinning on the spot and running the other way.
    breakOff: { near: 210, facing: 0.55, aimedWithin: 520, hold: 1.3, turn: 0.5 },
    debrisMaterial: ALIEN_PLATING,
    debris: { particles: 26, speed: 260, ring: 19, shake: 10 },
    killScore: 420,
    blastScore: 200,
    oreDrop: 0,
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
    [18, 0],
    [-10, -11],
    [-5, 0],
    [-10, 11],
  ],
  colour: PALETTE.player.hull,
  faction: "player",
  // Hull, like any other ship: what a hit that no bubble took gets through to. 70 points
  // off 253 of outline, which is a rock bump survived with care, a beam hit survived
  // once and a rival's autocannon round still fatal, so a shield stays the first thing
  // worth buying. See hullPoints.
  armour: 2.5,
  // The bare hull. What the shop fits adds 0.17 at launch, which puts the ship at
  // the 1 every other hull's mass is quoted against, and a fully fitted one a
  // little over it.
  mass: 0.83,
  // What the ship is confined by, which is less than the hull's own reach of 18.2:
  // see KNOWN_ISSUES.md, "A hull crosses the drawn arena ring".
  confineRadius: 13,
  // One core, carrying the cell and the room for what runs off it: see CORE_TYPES.
  hardpoints: [
    { local: [18, 0], role: "nose" },
    { local: [0, 0], role: "core" },
    { local: [3, 0], role: "aux" }, // filled by a fitting, see below
    { local: [-10, 0], role: "engine" },
  ],
  // The nose and the engine are filled from EQUIPMENT, since what is in them is the
  // run's to choose; the core is the hull's own.
  // The core is the hull's own. What goes in it, like what goes on the nose and in
  // the tail, is the run's: see EQUIPMENT.
  loadout: [{ hp: 1, core: "minerCore" }],
  // What the ship is fitted with before anything is bought, one id per slot. The
  // magnet is here rather than in the shop because a ship that cannot pick ore up
  // is not a ship: it can be ejected, which is a choice, not a starting state.
  startingSpecials: ["oreMagnet"],
}

export const PLAYER_TYPE = {
  ...PLAYER_DESIGN,
  ...hullShape(PLAYER_DESIGN),
  hull: hullPoints(PLAYER_DESIGN),
}

// ---------------------------------------------------------------------------
// EQUIPMENT - what the shop fits to the player's ship, slot by slot.
//
// A slot lists what can go in it. Buying an option is permanent and swapping
// between what the run already owns is free, so ore buys capability and never a
// decision: a drive bought for one sector is still there to swap back to in the
// next. That is the difference between this and a levelled upgrade, where the
// level below the one you bought stops existing.
//
//   label   what the shop calls the slot
//   roles   the hardpoint roles it fills, in the hull's own terms rather than by index,
//           so the same slot finds its mounts on any hull. Every mount with one of
//           these roles is filled, which is what makes a drive the ship's rather than
//           one nozzle's
//   perMount  each of those mounts holds its own choice, and a mount nothing has been
//             said about keeps whatever the hull came with
//   slot    for equipment the core carries, the core slot it goes in
//   removable  whether the slot may be left empty. A shield, a radar and a turret
//              are additions, so a run can be flown without them and some players
//              will want to. A laser and a drive are what make the hull a ship, the
//              way the core is: there is no run without them, so they cannot come
//              off and are not marked.
//   options in the order the shop lists them:
//             id    the registry entry it fits
//             name  what the shop calls it
//             desc  what it does, in a line, shown against the selected row
//             cost  ore. Zero is what the hull came with, so it is owned from the
//                   start and is what a swap falls back to.
//             locked  not sold at all, and not owned until a run finds one. It is what
//                   another hull carries, so the yard has nothing to say about it until
//                   there is one to look at; once found it swaps like anything else.
// ---------------------------------------------------------------------------
export const EQUIPMENT = {
  // No mark costs nothing, so a run starts with the slot empty: a shield is bought,
  // not issued. It sits in the core, which is what carries it.
  shield: {
    label: "SHIELD",
    desc: "An energy bubble. Damage drains the cell instead of the hull, until it runs out.",
    removable: true,
    roles: ["core"],
    mount: "shield",
    slot: "shield",
    ladder: true,
    options: [
      {
        id: "playerShieldMk1",
        name: "SHIELD MK I",
        desc: "A bubble at last. Turns damage into energy drain until the cell gives out.",
        cost: 40,
      },
      {
        id: "playerShieldMk2",
        name: "SHIELD MK II",
        desc: "Drains 1.44 energy a point instead of 2, so the same cell soaks more.",
        cost: 85,
      },
      {
        id: "playerShieldMk3",
        name: "SHIELD MK III",
        desc: "A point of damage costs a point of energy.",
        cost: 130,
      },
      {
        id: "playerShieldMk4",
        name: "SHIELD MK IV",
        desc: "0.64 a point: the cell goes three times as far against fire as Mk I.",
        cost: 175,
      },
      // Found rather than sold: what another hull carries. See `locked`.
      {
        id: "bulwark",
        name: "BULWARK",
        desc: "A frigate's braced bubble. It shrugs off shot and hates beams.",
        cost: 0,
        locked: true,
      },
      {
        id: "alienField",
        name: "REPEL FIELD",
        desc: "Alien. It pushes rocks and shot away instead of stopping them, and pays for it.",
        cost: 0,
        locked: true,
      },
    ],
  },
  // The set comes with the hull, seeing rock and nothing else beyond what is on
  // screen. Each mark adds a kind of thing, so a quiet early sector needs none of
  // them and a crowded late one wants the lot. It sits in the core.
  radar: {
    label: "RADAR",
    desc: "What the ship picks out beyond the screen. Everything close by shows regardless.",
    removable: true,
    roles: ["core"],
    mount: "radar",
    slot: "radar",
    ladder: true,
    options: [
      {
        id: "surveyMk1",
        name: "RADAR MK I",
        desc: "Finds rock anywhere in the sector, which is the job.",
        cost: 0,
      },
      {
        id: "surveyMk2",
        name: "RADAR MK II",
        desc: "Adds loose ore, so a rival cannot quietly clear up behind you.",
        cost: 60,
      },
      {
        id: "surveyMk3",
        name: "RADAR MK III",
        desc: "Adds hulls, so what is hunting you is on the edge of the screen before it arrives.",
        cost: 110,
      },
      {
        id: "surveyMk4",
        name: "RADAR MK IV",
        desc: "Adds specials, so nothing drifting past is missed.",
        cost: 160,
      },
      // Found rather than sold: what another hull carries. See `locked`.
      {
        id: "prospectorArray",
        name: "PROSPECTOR ARRAY",
        desc: "It sees rock and ore a long way off, and ships poorly.",
        cost: 0,
        locked: true,
      },
      {
        id: "huntingArray",
        name: "HUNTING ARRAY",
        desc: "It sees ships first and rock second, which is the point of it.",
        cost: 0,
        locked: true,
      },
    ],
  },
  // What brings the ship about, in the core beside the cell that runs it. No ladder:
  // the quicker set is not the better one, and which suits depends on what is being
  // flown with. A hull cannot steer without a set, so this cannot come off.
  thruster: {
    label: "THRUSTERS",
    desc: "The nozzles that turn the ship. How fast it comes about, and how finely.",
    roles: ["core"],
    mount: "thruster",
    slot: "thruster",
    options: [
      {
        id: "gimbalRing",
        name: "GIMBAL RING",
        desc: "The yard's set. Slow and precise.",
        cost: 0,
      },
      {
        id: "vectorJets",
        name: "VECTOR JETS",
        desc: "Fast but harder to master.",
        cost: 70,
      },
      // Found rather than sold: what another hull carries. See `locked`.
      {
        id: "attitudeJets",
        name: "ATTITUDE JETS",
        desc: "The least a hull can turn on, and it weighs almost nothing.",
        cost: 0,
        locked: true,
      },
      {
        id: "siegeJets",
        name: "SIEGE JETS",
        desc: "Twice the turn and ten times the weight, for a slab.",
        cost: 0,
        locked: true,
      },
    ],
  },
  // Two guns for the aux mount, at the same price: neither is the better one, so
  // there is no ladder to climb. Nothing is owned to begin with, so a run starts
  // without a turret at all.
  turret: {
    label: "TURRET",
    desc: "A gun that minds the ship on its own while the laser is busy elsewhere.",
    removable: true,
    // Every mount that takes one, each holding its own: a hull with four of them can
    // be armed four different ways, and one with a gun of its own keeps it until a
    // mount is given something else.
    roles: ["aux", "gun"],
    perMount: true,
    mount: "weapon",
    controller: "defense",
    options: [
      {
        id: "defenseBlaster",
        name: "BLASTER",
        desc: "Single heavy rounds out to 340. Reaches a rival before it reaches you.",
        cost: 85,
      },
      {
        id: "defenseFlak",
        name: "FLAK",
        desc: "A stream of light rounds, harder hitting but only out to 240.",
        cost: 85,
      },
      // Found rather than sold: what another hull carries. See `locked`.
      {
        id: "autocannon",
        name: "AUTOCANNON",
        desc: "The heavy rounds a rival's ring of guns throws.",
        cost: 0,
        locked: true,
      },
      {
        id: "warpOrb",
        name: "WARP ORB",
        desc: "Alien. A slow ball of bent space that falls toward what it was thrown at.",
        cost: 0,
        locked: true,
      },
    ],
  },
  laser: {
    label: "LASER",
    desc: "The cutting beam. Hold to charge: reach is what charge buys, damage follows gently.",
    roles: ["nose"],
    mount: "weapon",
    controller: "manual",
    // A ladder: each mark is the one below it and more, so they are bought in order
    // and there is never a reason to go back down. Slots without this are a choice
    // rather than a climb.
    ladder: true,
    options: [
      { id: "playerLaserMk1", name: "BEAM MK I", desc: "The yard's cutting beam.", cost: 0 },
      {
        id: "playerLaserMk2",
        name: "BEAM MK II",
        desc: "Charges half again as fast, so a full shot comes round sooner.",
        cost: 45,
      },
      {
        id: "playerLaserMk3",
        name: "BEAM MK III",
        desc: "A charge costs 83 energy instead of 150, so the cell goes further.",
        cost: 90,
      },
      {
        id: "playerLaserMk4",
        name: "BEAM MK IV",
        desc: "Hits for 57 rather than 38: one shot fewer to strip a shield and cut a hull.",
        cost: 135,
      },
      {
        id: "playerLaserMk5",
        name: "BEAM MK V",
        desc: "Overdrive: hold past full charge to wind up a shot that shatters a rock.",
        cost: 180,
      },
      // Found rather than sold: what another hull carries. See `locked`.
      {
        id: "minerLaser",
        name: "PROSPECTOR CUTTER",
        desc: "A rock cutter. It barely scratches a hull, and was never meant to.",
        cost: 0,
        locked: true,
      },
      {
        id: "cannonLaser",
        name: "SIEGE LANCE",
        desc: "What a frigate leads with: one enormous hit, and a long wait for the next.",
        cost: 0,
        locked: true,
      },
      {
        id: "seekerLaser",
        name: "DART BEAM",
        desc: "A light beam a dart fires on the move, made for passes rather than duels.",
        cost: 0,
        locked: true,
      },
      {
        id: "warpCutter",
        name: "WARP CUTTER",
        desc: "Alien. It cuts by bending the space a hull is sitting in.",
        cost: 0,
        locked: true,
      },
      {
        id: "warpNeedle",
        name: "WARP NEEDLE",
        desc: "Alien. A thin beam that distorts whatever is behind what it crosses.",
        cost: 0,
        locked: true,
      },
      {
        id: "singularityGun",
        name: "SINGULARITY GUN",
        desc: "Alien. It winds up, draws in what is loose, and throws a well that eats it.",
        cost: 0,
        locked: true,
      },
    ],
  },
  engine: {
    label: "ENGINE",
    desc: "What pushes the ship, and whether it can push backwards.",
    roles: ["engine"],
    mount: "engine",
    options: [
      {
        id: "minerDrive",
        name: "MINER DRIVE",
        desc: "The yard's own. Pushes one way, hard.",
        cost: 0,
      },
      {
        id: "vectoredDrive",
        name: "VECTORED DRIVE",
        desc: "Backs away under DOWN or S. Less thrust, so less speed and less push.",
        cost: 55,
      },
      // Found rather than sold: what another hull carries. See `locked`.
      {
        id: "pulseDrive",
        name: "PULSE DRIVE",
        desc: "A scout's drive. Light, and pushes one way only.",
        cost: 0,
        locked: true,
      },
      {
        id: "ionDrive",
        name: "ION DRIVE",
        desc: "A dart's drive: the lightest thing that will move a hull.",
        cost: 0,
        locked: true,
      },
      {
        id: "siegeDrive",
        name: "SIEGE DRIVE",
        desc: "What it takes to move a frigate, and it weighs like it.",
        cost: 0,
        locked: true,
      },
      {
        id: "swarmDrive",
        name: "SWARM DRIVE",
        desc: "Alien. A scout's drive, and it burns green.",
        cost: 0,
        locked: true,
      },
      {
        id: "stalkerDrive",
        name: "STALKER DRIVE",
        desc: "Alien. Light and quiet, for a hull meant to arrive unnoticed.",
        cost: 0,
        locked: true,
      },
      {
        id: "pincerDrive",
        name: "PINCER DRIVE",
        desc: "Alien. What moves a pincer, which is a great deal of hull.",
        cost: 0,
        locked: true,
      },
    ],
  },
}

// What a run owns to begin with: everything that costs nothing.
// What the yard actually offers for a slot: everything except what is only there to be
// found on another hull. Two lists in one, so anything asking "what can be bought" says
// so rather than walking the options and hoping.
export function yardOptions(slot) {
  return EQUIPMENT[slot].options.filter((option) => !option.locked)
}

export function freshEquipment() {
  const owned = {}
  const fitted = {}
  for (const [slot, spec] of Object.entries(EQUIPMENT)) {
    // What the hull came with, which is everything free that is also on offer: a locked
    // option costs nothing because it is not for sale, not because it is issued.
    owned[slot] = yardOptions(slot)
      .filter((option) => !option.cost)
      .map((option) => option.id)
    // A per-mount slot holds one entry per mount, and starts saying nothing about any of
    // them: a hull that came with guns of its own keeps them until one is given something
    // else. Empty is not the same as untouched, which is why this is not a row of nulls.
    fitted[slot] = spec.perMount ? [] : (owned[slot][0] ?? null)
  }
  return { owned, fitted }
}

// ---------------------------------------------------------------------------
// SPECIAL TYPES - one entry per collectable. Fields:
//   label   name shown in the pickup toast
//   short   name shown in the active-buff list (omit to reuse `label`)
//   icon    single character drawn on the pickup and in the inventory slot
//   colour   pickup outline, inventory slot and buff text
//   cost     ore price in the shop, once the run has found one
//   buyable  whether the shop will ever stock it; one that is not can still be
//            found in a sector, it just cannot be bought
//   mode     how using it works, one of:
//              passive always on for as long as it is fitted. There is nothing to
//                     press, no cooldown and no cost at the moment of use; what it
//                     costs, if anything, is `drain`. Sold, ejected and found in
//                     the field like any other.
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
// A special is equipment, not ammunition: using one leaves it in its slot and
// starts its cooldown. Its ongoing effect is declared here as a field the
// gameplay code looks up by name through PlayerShip.buffField, so nothing tests
// for a special by id. The fields the simulation currently reads off an active
// effect:
//   beamOffsets     parallel beam positions either side of the nose
//   beamLengthMult  multiplies the charged beam's reach
//   freeCharge      charging the laser costs no energy
//   collisionImmune asteroid contact does no damage
//   pull            ore attraction strength
//   pullRange       how far that attraction reaches, or the whole sector without one
//   tintsShip       the hull and the energy bar take this entry's `colour`
//   invisible       nothing hunting the player can see it, see Game.visiblePlayer
//   hullAlpha       the hull is drawn this solid
//   endsOnFire      firing the main laser switches the effect off
// Adding a field means reading it at one gameplay site; adding a special that
// reuses existing fields means editing nothing but this registry.
// ---------------------------------------------------------------------------
export const SPECIAL_TYPES = {
  // Shoves what is around the ship clear. `range` keeps it to the immediate
  // neighbourhood, so it is a way out of a squeeze and not a way to sweep the
  // sector; a rock counts as in range when its surface is.
  repel: {
    fromSector: 5,
    label: "REPEL",
    desc: "A shove that throws rocks and shot clear of the ship. A way out of a squeeze, not a way to sweep a sector.",
    icon: "R",
    colour: PALETTE.special.repel,
    cost: 90,
    buyable: true,
    mode: "pulse",
    energy: 0.22,
    cooldown: 4,
    range: 240,
    impulse: 300,
    apply: (game, player, type) => {
      // A rock counts as in range when its surface is; a shot when its centre is.
      game.applyRadialForce({
        centre: player,
        radius: type.range,
        include: ["asteroids"],
        toSurface: true,
        visit: (asteroid, { dir }) => {
          asteroid.vx += dir.x * type.impulse
          asteroid.vy += dir.y * type.impulse
          asteroid.spin += randRange(-3, 3)
        },
      })
      game.applyRadialForce({
        centre: player,
        radius: type.range,
        include: ["projectiles"],
        visit: (bullet, { dir }) => {
          const speed = Math.max(CONFIG.BULLET_SPEED, Math.hypot(bullet.vx, bullet.vy))
          bullet.vx = dir.x * speed
          bullet.vy = dir.y * speed
        },
      })
      game.ring(player.x, player.y, 40, type.colour, type.range, 0.7)
      game.screenShake = 9
    },
  },
  // The one special that cannot be paid for in energy, being made of it, so it is
  // spent instead: a full cell once, and the slot is empty again.
  refuel: {
    fromSector: 8,
    label: "REFUEL",
    desc: "Fills the cell in one go, and is gone with it.",
    icon: "F",
    colour: PALETTE.special.refuel,
    cost: 70,
    buyable: true,
    mode: "single",
    energy: 0,
    apply: (game, player, type) => {
      player.energy = game.maxEnergy()
      game.ring(player.x, player.y, 24, type.colour, 150, 0.6)
    },
  },
  booster: {
    fromSector: 15,
    label: "BOOSTER",
    desc: "Charged shots reach further and cost nothing, and rocks are shouldered aside unharmed.",
    short: "BOOST",
    icon: "B",
    colour: PALETTE.special.booster,
    cost: 140,
    buyable: true,
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
    fromSector: 19,
    label: "MULTI-LASER",
    desc: "Three beams instead of one, thrown either side of the nose.",
    short: "MULTI",
    icon: "L",
    colour: PALETTE.special.multi,
    cost: 130,
    buyable: true,
    mode: "timed",
    energy: 0.44,
    cooldown: 75,
    seconds: 9,
    beamOffsets: [-28, 0, 28], // parallel beams either side of the nose
  },
  // The one the ship leaves the yard with. It runs for nothing, which is what
  // makes it worth keeping in a slot that could hold something louder; ejecting it
  // for a stealth field is a real trade rather than an obvious one.
  oreMagnet: {
    fromSector: 11,
    label: "ORE MAGNET",
    desc: "Draws loose ore in from across the ship, without being switched on.",
    short: "MAGNET",
    icon: "M",
    colour: PALETTE.special.magnet,
    cost: 100,
    buyable: true,
    mode: "passive",
    pull: CONFIG.ORE_PASSIVE_PULL,
    pullRange: 190,
  },
  // Held on rather than triggered: it costs energy for as long as it runs, and
  // firing the main laser gives the position away and drops it.
  stealth: {
    fromSector: 25,
    label: "STEALTH",
    desc: "Nothing hunting the ship can see it. It runs on the cell, and firing gives the position away.",
    icon: "S",
    colour: PALETTE.special.stealth,
    cost: 160,
    buyable: true,
    mode: "toggle",
    drain: 0.2,
    cooldown: 2,
    invisible: true,
    hullAlpha: 0.35,
    endsOnFire: true,
  },
}

export const SPECIAL_IDS = Object.keys(SPECIAL_TYPES)

// Maximum special slots the ship can be fitted with.
export const MAX_SLOTS = 4

export function freshUpgrades() {
  return { core: 0, ...freshEquipment() }
}

// Sizes the in-game HUD can be drawn at, in menu order. The menus themselves are
// not scaled: they already fill the page, and there is nowhere for them to grow.
export const UI_SCALES = [1, 1.5, 2]

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
// ---------------------------------------------------------------------------
// DEV MENU - a page of the pause menu, offered only on a build where DEV_VISIBLE is
// true. Everything here exists to get at a part of the game without playing up to it:
// spawn the hull that is being worked on, own the equipment that would take a run to
// afford, or drop into an arena with nothing in it and no way to win.
//
// Rows are the pause menu's own shape, so the cursor, the confirms and the drawing are
// all the ones already there. `rows` generates a group from a registry, which is how
// "spawn any of them" stays true as hulls are added.
// ---------------------------------------------------------------------------
// What a dev-spawned hull turns up carrying: the design alone, whatever the spawner would
// roll for it in this sector, or every arm it could ever have.
export const DEV_ARMS = ["normal", "rolled", "all"]

// An arrow is what a row that leads somewhere shows, so a row that simply does something
// when it is pressed shows nothing and is not mistaken for a page.
export const DEV_MENU = [
  {
    name: "TESTING ARENA",
    value: (g) => (g.sandbox ? "IN ONE" : ""),
    action: (g) => g.enterSandbox(),
  },
  { name: "CLEAR SECTOR", action: (g) => g.clearSectorNow() },
  { name: "OWN EVERYTHING", action: (g) => g.devOwnEverything() },
  { name: "FULLY UPGRADE", action: (g) => g.devMaxOut() },
  { name: "SPAWN", value: () => ">", action: (g) => g.openPausePage("devSpawn") },
  {
    name: "SHIP",
    value: (g) => (g.player ? g.playerTypeName() : ">"),
    action: (g) => g.openPausePage("devShip"),
  },
  // Not "back": in a testing arena this page is what ESCAPE opens, so there is nothing
  // behind it. The options are a row of it, the way it is a row of them.
  { name: "OPTIONS", value: () => ">", action: (g) => g.openPausePage("root") },
]

// The ship page: fly any hull in the game. The shop finds its mounts by role, so a hull
// it can fit is a hull that can be flown; what that feels like is the point of the page.
export const DEV_SHIP_MENU = [
  {
    rows: (g) =>
      [
        { name: "PLAYER", key: "player" },
        ...Object.keys(g.spawnableTypes()).map((name) => ({
          name: name.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase(),
          key: name,
        })),
      ].map((entry) => ({
        name: entry.name,
        value: (game) => (game.playerTypeName() === entry.name ? "FLYING" : ""),
        action: (game) => game.devFlyShip(entry.key),
      })),
  },
  { name: "BACK", action: (g) => g.openPausePage("dev") },
]

// The spawn page: a row per hull, a row per kind of rock, and both lists generated, so
// adding either to its registry puts it on the page.
//
// A hull row carries its own choice of what to arm it with rather than the page holding
// one setting for all of them, since the interesting spawn is usually one hull rolled
// against a plain one. Rolling at the sector the run is in gives almost nothing early on,
// which is the least useful of the three for looking at a hull, so all three are offered.
export const DEV_SPAWN_MENU = [
  {
    rows: (g) =>
      Object.keys(g.spawnableTypes()).map((name) => ({
        name: name.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase(),
        choices: (game) => ({
          options: DEV_ARMS.map((arms) => arms.toUpperCase()),
          at: game.devArmsFor(name),
        }),
        action: (game) => game.devSpawn(name),
        adjust: (game, step) => game.stepDevArms(name, step),
      })),
  },
  {
    rows: (g) =>
      g.devRockKinds().map((kind) => ({
        name: kind.name,
        action: (game) => game.devSpawnRock(kind),
      })),
  },
  { name: "BACK", action: (g) => g.openPausePage("dev") },
]

// What is on offer once the last ship is gone. The ore in the hold is worth nothing
// after a run ends, so spending it on another ship is the choice worth putting here;
// the price is the shop's, read through the game so the two cannot drift apart.
export const OVER_MENU = [
  {
    name: "CONTINUE",
    value: (g) => (g.devMode ? "FREE" : `${g.continueCost()} ore`),
    action: (g) => g.continueRun(),
  },
  { name: "NEW RUN", action: (g) => g.startNewGame() },
]

export const PAUSE_MENU = [
  // First, because on a build that has it, it is what the menu is most often opened for.
  // Only where the dev buttons show at all, so a published build has no way in.
  {
    name: "DEV TOOLS",
    value: () => ">",
    available: () => DEV_VISIBLE,
    action: (g) => g.openPausePage("dev"),
  },
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
  {
    name: "HUD SIZE",
    value: (g) => `${g.settings.uiScale}x`,
    action: (g) => g.stepUiScale(1),
    adjust: (g, step) => g.stepUiScale(step),
  },
  {
    name: "HELP TEXT",
    value: (g) => (g.settings.help ? "ON" : "OFF"),
    action: (g) => g.setHelp(!g.settings.help),
    adjust: (g, step) => g.setHelp(step > 0),
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
// A levelled upgrade that reads like a slot: the row reports the level it is at and
// opens a pop-over of the ladder, each step saying what it buys. The steps are
// bought in order, so only the next one along has a price.
const levelRow = (id, name, desc, spec) => ({
  id,
  name,
  desc,
  levels: spec.levels,
  levelCost: spec.cost,
  levelApply: spec.apply,
  max: spec.levels.length - 1,
  cost: (g) => spec.cost(g.upgrades[id]),
  info: (g) => spec.levels[g.upgrades[id]].name,
  maxed: (g) => g.upgrades[id] >= spec.levels.length - 1,
})

// A slot whose options are owned rather than levelled: the row reports what is
// fitted and opens a pop-over of everything that could be. Buying and swapping
// both happen in there, so the row itself has no action of its own.
const equipmentRow = (slot, inset = false) => ({
  id: slot,
  equipment: slot,
  inset,
  name: EQUIPMENT[slot].label,
  desc: EQUIPMENT[slot].desc,
  info: (g) => g.equipmentName(slot),
  cost: () => 0,
  maxed: (g) => g.ownsEveryOption(slot),
})

export const SHOP = [
  // A spare ship and the specials already carried are not part of the loadout the
  // rest of the page sells, so they head the list as their own group.
  {
    id: "life",
    name: "LIVES",
    desc: "One more spare ship.",
    info: (g) => `${g.lives} / ${CONFIG.MAX_LIVES}`,
    cost: () => 60,
    maxed: (g) => g.lives >= CONFIG.MAX_LIVES,
    apply: (g) => {
      g.lives++
    },
  },
  levelRow(
    "core",
    "CORE",
    "The cell every system draws on. A bigger one holds more and refills faster.",
    {
      levels: CORE_TYPES.minerCore.levels,
      cost: (level) => 45 + level * 55,
      apply: (g) => {
        if (g.player) {
          g.player.energyMax = g.maxEnergy()
          g.player.energy = g.player.energyMax
        }
      },
    },
  ),
  equipmentRow("shield", true),
  equipmentRow("radar", true),
  equipmentRow("thruster", true),
  equipmentRow("laser"),
  equipmentRow("turret"),
  equipmentRow("engine"),
]

// Where the shop's own rows sit among the purchases, and how the page is grouped.
// The specials row is the last thing the core carries, so it follows the shield, the
// radar and the thrusters under it, and `groupGap` sets that group apart from the
// loadout below. Adding another core slot to SHOP moves this down with it.
export const SHOP_LAYOUT = { slotsRow: 5, groupGap: 14, insetBy: 18 }

// ---------------------------------------------------------------------------
// SLOT MENU - the pop-over that opens on a special slot in the shop. One entry
// per row, in menu order, each taking the slot it was opened on. There is no row
// for unlocking one: slots come with the power core, since a slot without the cell
// to run it is not worth selling. Fields:
//   name      the label
//   desc      optional line about what the row does, shown under the menu. A string, or
//             (game, slot) => text where it depends on what the slot holds
//   value     optional (game, slot) => text shown on the right
//   available optional (game, slot) => whether the row belongs on this slot
//   action    (game, slot) => run on ENTER / A
//   rows      optional (game, slot) => rows of the same shape, for a list that is
//             not known until the run is under way
// A slot whose rows all come to nothing does not open, so a slot with nothing to
// offer stays inert.
// ---------------------------------------------------------------------------
export const SLOT_MENU = [
  {
    name: "SELL",
    desc: (g, slot) => {
      const item = g.slotItem(slot)
      return item ? SPECIAL_TYPES[item.id].desc : ""
    },
    value: (g, slot) => `+${g.slotSellValue(slot)} ore`,
    available: (g, slot) => g.slotItem(slot) !== null,
    action: (g, slot) => g.sellSlot(slot),
  },
  // One row per special an empty slot could be filled with: everything the run
  // has found, and everything at all in dev mode. A slot the ship has not been
  // fitted with yet has to be unlocked before it can hold anything.
  {
    rows: (game, slot) =>
      game.slotItem(slot) || slot >= game.specialSlots()
        ? []
        : game.buyableSpecials().map((id) => ({
            name: SPECIAL_TYPES[id].label,
            desc: SPECIAL_TYPES[id].desc,
            value: (g) => (g.devMode ? "FREE" : `${SPECIAL_TYPES[id].cost} ore`),
            action: (g, at) => g.buySpecial(at, id),
          })),
  },
]
