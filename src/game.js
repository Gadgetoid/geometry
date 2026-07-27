// The Game owns all mutable state and orchestrates the simulation: update,
// level flow, the shop, and beam resolution. Painting lives in GameView
// (view.js), which reads this state. Entities receive the game instance and
// read / mutate its public fields; nothing here reaches for module globals.

import {
  DEV_ARMS,
  SHIP_SCALARS,
  DEV_MENU,
  VIEW_W,
  VIEW_H,
  ARENA,
  TAU,
  CONFIG,
  PROGRESSION,
  HAZARD_TRAITS,
  FACTIONS,
  coreAt,
  weightAt,
  SHIP_TYPES,
  PAUSE_MENU,
  SHOP,
  SHOP_LAYOUT,
  EQUIPMENT,
  SLOT_MENU,
  SPECIAL_TYPES,
  SPECIAL_IDS,
  MAX_SLOTS,
  UI_SCALES,
  SHIELD_SPARK,
  GAMEPAD,
  BINDABLE_CONTROLS,
  BINDING_DEVICES,
  RESERVED_KEYS,
  RESERVED_BUTTONS,
  freshBindings,
  freshUpgrades,
  freshEquipment,
  PLAYER_TYPE,
} from "./config.js"
import {
  randRange,
  randInt,
  weightedPick,
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
  segmentPolygonEntry,
  segmentCircleEntry,
  rayExitDistance,
  distanceTo,
} from "./math.js"
import { Sound } from "./audio.js"
import { PALETTE } from "./palette.js"
import { Backdrop } from "./background.js"
import {
  loadBest,
  saveBest,
  loadRun,
  saveRun,
  clearRun,
  loadSettings,
  saveSettings,
  loadBindings,
  saveBindings,
} from "./persistence.js"
import {
  Asteroid,
  Ore,
  Special,
  PlayerShip,
  RivalShip,
  oreFromFragment,
  resolveShipPair,
  shapeContact,
} from "./entities.js"

const PARTICLE_LIFE = 5 // global lifetime multiplier
const PARTICLE_DRAG = 0.4 // velocity retained per second
const MAX_PARTICLES = 1200
// The first sector any rival appears in: the earliest spawn gate across the
// ship types.
// Phases where a sector is live and the simulation runs. Around them sit
// title, shop and over. `arriving` and `departing` are the warp bookends: the
// world keeps moving but the ship is not under control and not solid.
//   title -> arriving -> play -> clearing -> departing -> shop -> arriving ...
// Losing a life drops back to `arriving` in place, so the pause and warp-in are
// the same code as the start of a sector.
const SECTOR_PHASES = new Set(["arriving", "play", "clearing", "departing"])

// Phases where the player flies the ship. Weapons key off the same set, so the
// sector is never one-sided: nothing shoots at a ship that cannot answer.
// Clearing is included, so the sweep-up lap is still flown; the warp bookends
// are not, because the ship is not really there.
const FLYING_PHASES = new Set(["play", "clearing"])

// Phases a sector can be walked out of. Once the last rock is gone the shop is
// coming anyway, so there is nothing to bail out of and throwing the clear away by
// accident would be a poor thing to allow.
const EXITABLE_PHASES = new Set(["arriving", "play"])

// A key code as a player would recognise it on their keyboard.
function keyLabel(code) {
  if (code.startsWith("Key")) {
    return code.slice(3)
  }
  if (code.startsWith("Digit")) {
    return code.slice(5)
  }
  if (code.startsWith("Numpad")) {
    return `NUM ${code.slice(6)}`
  }
  if (code.startsWith("Arrow")) {
    return code.slice(5).toUpperCase()
  }
  return code.toUpperCase()
}

const RIVALS_FROM_SECTOR = Math.min(
  ...Object.values(SHIP_TYPES).map((type) => type.spawn.fromSector),
)

export class Game {
  constructor() {
    this.phase = "title" // see SECTOR_PHASES for the in-sector run
    this.asteroids = []
    this.oreChunks = []
    this.projectiles = []
    this.specialPickups = []
    this.rivals = []
    this.particles = []
    this.laserShots = []
    this.glitches = [] // short-lived tears in the picture, see glitchAt
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
    this.shopSlot = 0 // which special slot the cursor is on, along the slots row
    this.slotMenu = null // the open pop-over: { slot, selection }
    this.seenSpecials = new Set() // kinds the run has found, which the shop then sells
    // How long each slot button has been held, and whether that hold has already
    // thrown the special overboard. A tap uses the slot on release; a hold
    // jettisons as it passes the threshold, and the release then does nothing.
    this.slotHeld = new Array(MAX_SLOTS).fill(0)
    this.slotDown = new Array(MAX_SLOTS).fill(false)
    this.slotSpent = new Array(MAX_SLOTS).fill(false)
    this.pauseSelection = 0
    this.pauseConfirming = null // a row waiting to be confirmed a second time
    // Settings live here rather than on the things they affect, so one place holds
    // them and main.js applies whatever changes. Loaded below.
    this.settings = { volume: 0.8, sound: true, crt: true, help: true, uiScale: 1 }
    // Control bindings, and the row waiting for a key or button when one is being
    // rebound. Menu navigation is never in here; see BINDABLE_CONTROLS.
    this.bindings = freshBindings()
    this.rebinding = null
    this.pausePage = "root"
    this.savedRun = null // the run left behind by a previous session, if any
    this.exitRequested = false // main.js closes the window when this is set
    // Whether closing the window is even possible. main.js decides, since only it can
    // see what kind of window this is; a tab cannot be closed by script.
    this.canExit = false
    this.toast = null
    this.devMode = false
    // A sector that never counts as cleared, so a dev arena stays put. See enterSandbox.
    this.sandbox = false
    this.devArms = 0 // what a dev-spawned hull carries, an index into DEV_ARMS
    this.paused = false
    this.gameTime = 0
    this.screenShake = 0
    this.oreVacuum = false
    this.specialTimer = 0
    this.rivalTimer = 0
    this.clearTimer = 0
    this.pressedKeys = new Set()
    // Which device the player last used, so the HUD can name the right controls.
    this.inputMode = "keyboard"
    // Input a gamepad cannot express as a key: analog steering, an absolute
    // turret bearing, and held controls that must not disturb pressedKeys (a
    // keyboard player holding the same key would otherwise have it cleared).
    // The ship takes whichever of the two is asking for more.
    this.padInput = this.blankPadInput()
    this.viewCenter = { x: ARENA.cx, y: ARENA.cy } // world point the camera follows

    this.backdrop = new Backdrop()
    loadSettings().then((stored) => {
      if (stored) {
        this.settings = { ...this.settings, ...stored }
        this.applySound()
      }
    })
    loadBindings().then((stored) => {
      if (stored) {
        // Merge over the defaults, so a binding added to the registry after this
        // was saved still has one rather than being absent.
        for (const device of BINDING_DEVICES) {
          Object.assign(this.bindings[device.id], stored[device.id] || {})
        }
      }
    })
    loadRun().then((run) => {
      if (run && !this.player) {
        this.savedRun = run
      }
    })
    // The stored best arrives asynchronously, which can land after a run has
    // already beaten it, so take the higher of the two rather than the loaded
    // one outright.
    loadBest().then((value) => {
      if (value) {
        this.best = {
          score: Math.max(this.best.score, value.score || 0),
          sector: Math.max(this.best.sector, value.sector || 1),
        }
      }
    })
  }

  // Is a sector live at all, warp bookends included?
  inSector() {
    return SECTOR_PHASES.has(this.phase)
  }

  // Is the ship being flown? Movement, firing and item use all follow this.
  canFly() {
    return FLYING_PHASES.has(this.phase)
  }

  // Is there a sector to walk out of?
  canExitSector() {
    return EXITABLE_PHASES.has(this.phase)
  }

  blankStats() {
    return { shots: 0, hits: 0, damage: 0, ore: 0, mined: 0 }
  }
  blankPadInput() {
    return {
      turn: 0,
      thrust: false,
      reverse: false,
      charging: false,
      turretAim: null,
      turretFire: false,
    }
  }
  // The cell the fitted core supplies at the level it has been bought to. Read
  // through the core rather than off a table, so a hull carrying a different one
  // answers for itself.
  playerCore() {
    if (!this.player) {
      return null
    }
    for (const module of this.player.modules()) {
      if (module.kind === "core") {
        return coreAt(module.type, this.upgrades.core)
      }
    }
    return null
  }
  maxEnergy() {
    const core = this.playerCore()
    return core ? core.energy : 0
  }
  // ---- equipment -------------------------------------------------------
  // What a slot holds, what the run owns for it, and what it would cost to own
  // the rest. Buying is permanent and swapping between what is owned is free, so
  // these are two different questions and stay two different methods.
  equipmentOption(slot, id) {
    return EQUIPMENT[slot].options.find((option) => option.id === id) ?? null
  }
  fittedEquipment(slot) {
    return this.upgrades.fitted[slot] ?? null
  }
  equipmentName(slot) {
    const option = this.equipmentOption(slot, this.fittedEquipment(slot))
    return option ? option.name : "-"
  }
  ownsEquipment(slot, id) {
    return (this.upgrades.owned[slot] ?? []).includes(id)
  }
  ownsEveryOption(slot) {
    return EQUIPMENT[slot].options.every((option) => this.ownsEquipment(slot, option.id))
  }

  // Fit something the run already owns. Free, and it re-mounts the module.
  fitEquipment(slot, id) {
    if (!this.ownsEquipment(slot, id) || this.fittedEquipment(slot) === id) {
      return
    }
    this.upgrades.fitted[slot] = id
    if (this.player) {
      this.player.fitEquipment(this)
    }
    this.rememberRun()
    Sound.power()
  }

  // Take what is fitted off, for a slot that will go without. Nothing is sold: it
  // stays owned and goes back on whenever it is wanted, so this is a choice about how
  // to fly rather than a refund.
  removeEquipment(slot) {
    if (!EQUIPMENT[slot].removable || !this.fittedEquipment(slot)) {
      return
    }
    this.upgrades.fitted[slot] = null
    if (this.player) {
      this.player.fitEquipment(this)
    }
    this.rememberRun()
    Sound.power()
  }

  // Buy one, which also fits it: nobody buys a drive to leave in the hold.
  buyEquipment(slot, id) {
    const option = this.equipmentOption(slot, id)
    if (!option || this.ownsEquipment(slot, id)) {
      return
    }
    if (!this.devMode) {
      if (this.oreBalance < option.cost) {
        Sound.hit()
        return
      }
      this.oreBalance -= option.cost
    }
    this.upgrades.owned[slot].push(id)
    this.upgrades.fitted[slot] = id
    if (this.player) {
      this.player.fitEquipment(this)
    }
    this.rememberRun()
    Sound.power()
  }

  // The pop-over's rows for an equipment slot: everything it could hold, with what
  // it costs, or that it is already owned or already in.
  equipmentRows(slot) {
    const spec = EQUIPMENT[slot]
    const rows = spec.options.map((option, index) => {
      // A ladder is climbed in order, so a mark is out of reach until the one below
      // it is owned. Everything else is a straight choice.
      const locked =
        spec.ladder && index > 0 && !this.ownsEquipment(slot, spec.options[index - 1].id)
      return {
        name: option.name,
        desc: option.desc,
        value: (g) => {
          if (g.fittedEquipment(slot) === option.id) {
            return "FITTED"
          }
          if (g.ownsEquipment(slot, option.id)) {
            return "SWAP"
          }
          if (locked) {
            return "-"
          }
          return g.devMode ? "FREE" : `${option.cost} ore`
        },
        // Something to spend on, as opposed to something already owned or still out of
        // reach up a ladder.
        buyable: (g) => !locked && !g.ownsEquipment(slot, option.id),
        action: (g) => {
          if (g.ownsEquipment(slot, option.id)) {
            g.fitEquipment(slot, option.id)
          } else if (!locked) {
            g.buyEquipment(slot, option.id)
          }
        },
      }
    })
    // Under the options, for a slot that will go without: flying with no shield is a
    // way to play rather than a mistake, so it is offered rather than merely possible.
    if (spec.removable) {
      rows.push({
        name: "NONE",
        desc: "Fly without one. It stays bought, and goes back on whenever you like.",
        value: (g) => (g.fittedEquipment(slot) ? "REMOVE" : "FITTED"),
        action: (g) => g.removeEquipment(slot),
      })
    }
    return rows
  }

  // How many specials the ship has room for, which the power core decides.
  specialSlots() {
    const core = this.playerCore()
    return Math.min(core ? (core.special ?? 0) : 0, MAX_SLOTS)
  }
  // Mount the module an upgrade pays for, if the ship exists yet. The shop can be
  // reached before one does (the dev shop), so this is where the check lives.
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

  spawnSpecial() {
    const type = weightedPick(SPECIAL_IDS, (id) => weightAt(SPECIAL_TYPES[id], this.level))
    if (!type) {
      return
    }
    // just beyond a screen edge near the camera, drifting in toward the player
    const c = this.viewCenter
    const angle = randRange(0, TAU)
    const x = c.x + Math.cos(angle) * (VIEW_W / 2 + 30)
    const y = c.y + Math.sin(angle) * (VIEW_H / 2 + 30)
    const dir = normalize(subtract(c, { x, y }))
    this.specialPickups.push(
      new Special(x, y, dir.x * randRange(30, 50), dir.y * randRange(30, 50), type),
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

  // Bring a rival in from beyond the boundary on the given bearing. It starts
  // where a departing one is dropped, which is the only place it can start
  // without being seen to appear: clear of the ring by its own reach, and clear
  // of the view by the same margin that lets one vanish. The arena is smaller
  // than the camera's reach, so clearing the ring alone is not enough - with the
  // player out at the rim, the far side of the ring is on screen.
  //
  // It is faced inward and already under way: nothing sets a heading otherwise,
  // and a frigate turning at 0.17 rad/s would spend a third of its life coming
  // about before it ever reached the sector.
  #enterRival(name, bearing, loadout) {
    const ship = new RivalShip(0, 0, name, loadout)
    const ux = Math.cos(bearing),
      uy = Math.sin(bearing)
    const margin = ship.boundRadius + CONFIG.RIVAL_DESPAWN_MARGIN
    const distance = Math.max(
      ARENA.radius + ship.boundRadius + CONFIG.RIVAL_ENTRY_MARGIN,
      rayExitDistance(
        { x: ARENA.cx, y: ARENA.cy },
        ux,
        uy,
        this.viewCenter,
        VIEW_W / 2 + margin,
        VIEW_H / 2 + margin,
      ),
    )
    ship.x = ARENA.cx + ux * distance
    ship.y = ARENA.cy + uy * distance
    ship.angle = bearing + Math.PI
    ship.vx = Math.cos(ship.angle) * ship.maxSpeed
    ship.vy = Math.sin(ship.angle) * ship.maxSpeed
    this.rivals.push(ship)
  }

  // What a type weighs in this sector's arrivals: nothing while as many are
  // already out there as it is allowed, and its weight at this sector otherwise.
  spawnWeight(name) {
    const { spawn } = SHIP_TYPES[name]
    if (spawn.maxConcurrent !== undefined && this.countRivals(name) >= spawn.maxConcurrent) {
      return 0
    }
    return weightAt(spawn, this.level)
  }

  spawnRival() {
    const name = weightedPick(Object.keys(SHIP_TYPES), (n) => this.spawnWeight(n))
    if (!name) {
      return
    }
    this.#enterRival(name, randRange(0, TAU), this.rollLoadout(SHIP_TYPES[name]))
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

  // Everything a blast, a repel pulse or a gravity well does to what is around
  // it: walk the bodies in reach and hand each one to `visit` with which way it
  // lies and how strongly it was caught. What to do about it stays the caller's
  // business, so a pulse that only shoves and a blast that also damages share the
  // traversal without having to share an effect.
  //
  // `include` names the collections to walk. `toSurface` measures range to a
  // body's near surface instead of its centre, which is what a rock wants: a
  // boulder with its face against the centre is next to it however far off its own
  // middle sits. `skip` leaves one body alone, for whatever set the effect off.
  applyRadialForce({ centre, radius, include, visit, toSurface = false, skip = null }) {
    for (const name of include) {
      const bodies = name === "player" ? (this.player ? [this.player] : []) : this[name]
      for (const body of bodies) {
        if (body === skip || body.dead) {
          continue
        }
        const offset = subtract(body, centre)
        const away = Math.hypot(offset.x, offset.y)
        // A body with no extent of its own is its own surface. A loose shot is one, and
        // subtracting the reach it has not got put NaN into its velocity, which a
        // comparison against the radius then waved through.
        const reach = toSurface ? (body.boundRadius ?? 0) : 0
        const distance = Math.max(0, away - reach)
        if (distance > radius) {
          continue
        }
        visit(body, { dir: normalize(offset), distance, falloff: 1 - distance / radius })
      }
    }
  }

  // ---- beam resolution -------------------------------------------------
  // A single beam from `attacker` (via `weapon`), carrying `damage` for this
  // shot (the player's charged laser scales it, everything else passes its
  // type's). Cuts unshielded rocks, drains energy from anything with a
  // laser-blocking shield, damages ships within the beam's width, and never
  // harms the attacker. Returns didHit.
  // Where a beam first touches a bare hull, or null. The enclosing circle is only
  // a broadphase reject here; the answer comes from the outline, widened by the
  // beam's own half-width so the shot is as thick to the simulation as it is on
  // screen.
  #hullEntry(beam, ship, halfWidth) {
    const reach = halfWidth + ship.boundRadius
    const along = (ship.x - beam.a.x) * beam.dir.x + (ship.y - beam.a.y) * beam.dir.y
    if (along < 0) {
      return null
    }
    const cx = beam.a.x + beam.dir.x * along,
      cy = beam.a.y + beam.dir.y * along
    if (Math.hypot(ship.x - cx, ship.y - cy) >= reach) {
      return null
    }
    return segmentPolygonEntry(beam.a, beam.b, ship.worldOutline(), halfWidth)
  }

  applyBeam(beam, attacker, weapon, damage = weapon.type.damage) {
    let didHit = false
    let shatterDrawn = false // one overdrive effect beam per shot, not per rock
    // The beam is a capsule this thick either side of its centreline, which is
    // the bright core the view draws. Every surface it can strike is grown by it,
    // so a shot that visibly laps a target is a shot that connects.
    const halfWidth = (weapon.type.width || 2.4) / 2

    // Every ship the beam reaches, nearest first. Each is struck on its outermost
    // real surface: the shield bubble while one is raised, and the hull outline
    // when none is. Both are the shape the view draws, so a shot that looks like
    // it connected is the shot that does. A bubble is round, so a circle is its
    // shape rather than a proxy for it; a hull is not, and a circle around one
    // registers on the empty space beside it while leaving the nose unhittable.
    const fullLen = Math.hypot(beam.b.x - beam.a.x, beam.b.y - beam.a.y)
    const reached = []
    const considerShip = (e) => {
      // A shield only stands in the way of the channels it blocks. A deflector
      // stops shots and not lasers, so a beam reaches the hull inside it, which
      // is the same answer a shielded rock gives.
      const bubble = e.blockingRadius("laser")
      const entry =
        bubble > 0
          ? segmentCircleEntry(beam.a, beam.b, e, bubble + halfWidth)
          : this.#hullEntry(beam, e, halfWidth)
      if (entry !== null) {
        reached.push({ ship: e, entry })
      }
    }
    // A body that is not really in the sector is passed straight through: it
    // cannot be cut and cannot be damaged, so it must not truncate the beam
    // either. That covers a rival still flying in and a player mid-warp alike.
    for (const rival of this.rivals) {
      if (rival !== attacker && !rival.dead && rival.inPlay()) {
        considerShip(rival)
      }
    }
    if (this.player && attacker !== this.player && this.player.inPlay()) {
      considerShip(this.player)
    }
    reached.sort((a, b) => a.entry - b.entry)

    // A beam passes through every hull it can sever, exactly as it passes through
    // every rock it can cut, and stops at the first one it cannot. As for a rock,
    // severing means passing through: the beam must cross the outline at least
    // twice, so clipping the tip of a hull scorches it instead of severing its
    // whole length along a line the shot never reached. A shield that blocks the
    // channel is what stops a beam; a hull about to come apart is not.
    const severed = []
    let blockDist = fullLen
    let blockShip = null
    for (const { ship, entry } of reached) {
      const cuttable =
        ship.severable &&
        ship.blockingRadius("laser") === 0 &&
        countBeamCrossings(beam, ship.worldOutline()) >= 2
      if (!cuttable) {
        blockShip = ship
        blockDist = entry
        break
      }
      severed.push({ ship, entry })
    }
    if (blockShip) {
      beam.b.x = beam.a.x + beam.dir.x * blockDist
      beam.b.y = beam.a.y + beam.dir.y * blockDist
    }

    const survivors = []
    for (const asteroid of this.asteroids) {
      if (asteroid === attacker) {
        survivors.push(asteroid)
        continue
      }
      // A shielded rock is struck on its bubble, as a shielded hull is: what the
      // view draws around it is what the shot has to reach. An unshielded one has
      // to be passed through to be cut, which is the crossing rule.
      const bubble = asteroid.blockingRadius("laser")
      // The guns first, and on their own terms: a mount near the beam is taken out
      // whether or not the shot passes through the rock, which is what makes a
      // turret on a boulder something that can be shot at rather than something
      // that has to be cut apart. A raised shield covers them as it covers the rock.
      if (bubble <= 0 && asteroid.strikeTurrets(beam, halfWidth, this)) {
        this.screenShake = Math.max(this.screenShake, 3)
        didHit = true
      }
      const reached =
        bubble > 0
          ? segmentCircleEntry(beam.a, beam.b, asteroid.center, bubble + halfWidth) !== null
          : countBeamCrossings(beam, asteroid.vertices) >= 2
      if (!reached) {
        survivors.push(asteroid)
        continue
      }
      if (bubble > 0) {
        // Drained through takeDamage, as a hull's shield is, so how much a shield
        // loses to a hit is answered in one place. The flash and the spark land on
        // the side facing the shooter.
        const toShooter = Math.atan2(beam.a.y - asteroid.center.y, beam.a.x - asteroid.center.x)
        const struck = {
          x: asteroid.center.x + Math.cos(toShooter) * bubble,
          y: asteroid.center.y + Math.sin(toShooter) * bubble,
        }
        asteroid.takeDamage(damage, this, "laser", 0, struck)
        this.burst(struck.x, struck.y, 4, SHIELD_SPARK, 30, 120, 0.3)
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
      if (attacker === this.player && attacker.overdriven) {
        this.shatterToOre(asteroid)
        didHit = true
        this.score += CONFIG.SLICE_SCORE
        // One effect beam for the shot, the whole length of it, however many rocks
        // it goes on to shatter.
        if (!shatterDrawn) {
          shatterDrawn = true
          this.laserShots.push({
            beams: [
              { a: { x: beam.a.x, y: beam.a.y }, b: { x: beam.b.x, y: beam.b.y }, dir: beam.dir },
            ],
            age: 0,
            color: PALETTE.ore.shatterBeam,
            width: 5.5,
            glow: 26,
            life: 0.5,
          })
        }
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

    // Now the hulls, after the rocks, so wreckage this shot makes is not then cut
    // by the same shot. Damage a ship on its shooter-facing side.
    const fromPlayer = attacker === this.player
    const strike = (ship, at) => {
      const scoreOnKill = fromPlayer && ship !== this.player ? ship.type.killScore : 0
      ship.takeDamage(damage, this, "laser", scoreOnKill, at)
      this.burst(at.x, at.y, randInt(3, 6), weapon.type.colour, 30, 130, 0.35)
      didHit = true
    }
    // Every hull the beam passed through comes apart. A cut that will not split
    // cleanly scorches instead, where the beam met it.
    for (const { ship, entry } of severed) {
      if (this.sliceHull(ship, beam, fromPlayer)) {
        didHit = true
      } else {
        strike(ship, { x: beam.a.x + beam.dir.x * entry, y: beam.a.y + beam.dir.y * entry })
      }
    }
    // And the one that stopped it takes the hit at the end of the beam, which is
    // its own near surface.
    if (blockShip) {
      strike(blockShip, { x: beam.b.x, y: beam.b.y })
    }
    return didHit
  }

  // Cut an unshielded hull along the beam, exactly as a rock is cut. A piece big
  // enough for the hull's material becomes drifting wreckage carrying whichever
  // turrets fall inside it, so it keeps firing and can be cut again with ordinary
  // rock handling; anything smaller goes to ore.
  //
  // A hull that leaves no wreckage at all was too small to come apart, and is
  // simply destroyed where it stood - which is what a scout does, and what a
  // rock below AST_MIN_AREA does. Nothing here asks which ship it is; the
  // material's minArea decides, so a type sized between the two splits or
  // shatters according to how big its halves come out.
  //
  // Returns false if the beam only grazes it (no clean split).
  sliceHull(ship, beam, fromPlayer) {
    const cutNormal = perpendicular(beam.dir)
    // slice the real (concave) hull outline; the slicer handles it directly and
    // may return more than two pieces
    const parts = slicePolygon(ship.worldOutline(), beam.a, cutNormal)
    if (parts.length < 2) {
      return false
    }
    const material = ship.type.debrisMaterial || null
    const debrisMinArea = (material && material.minArea) || CONFIG.AST_MIN_AREA
    // the modules that keep working as wreckage, in world space, to hand to the
    // pieces; WEAPON_TYPES decides which those are
    const guns = []
    for (const hp of ship.hardpoints) {
      const m = hp.module
      if (m && m.kind === "weapon" && m.type.survivesDebris) {
        const w = ship.mountWorld(hp.local)
        guns.push({ x: w.x, y: w.y, module: m })
      }
    }
    // Does it survive being cut? The piece it would keep is the biggest one, and it stays
    // a ship if that is most of what it was and is still bigger than the smallest piece its
    // material holds together in. The second half is what keeps this off the small hulls:
    // the whole of a scout is a fraction of that area, so any cut at all still finishes one.
    const whole = polygonArea(ship.worldOutline())
    const biggest = parts.reduce((best, p) => (polygonArea(p) > polygonArea(best) ? p : best))
    const keptArea = polygonArea(biggest)
    const survives = keptArea >= whole * SHIP_SCALARS.cutSurvival && keptArea >= debrisMinArea
    // Sort the pieces before anything is spawned, so "did this hull leave any
    // wreckage?" is answered over the whole cut rather than one piece at a time.
    const wreckage = []
    const slivers = []
    for (const partVerts of parts) {
      if (survives && partVerts === biggest) {
        continue // this piece is still the ship
      }
      const centre = polygonCentroid(partVerts)
      const side = dot(subtract(centre, beam.a), cutNormal) > 0 ? 1 : -1
      const drift = {
        vx: ship.vx + cutNormal.x * side * CONFIG.SPLIT_IMPULSE,
        vy: ship.vy + cutNormal.y * side * CONFIG.SPLIT_IMPULSE,
      }
      // assign turrets to the piece that actually contains them (side-of-line
      // is ambiguous once a concave cut yields more than two pieces)
      const mine = guns.filter((g) => pointInPolygon(g, partVerts))
      // a gunless sliver just becomes ore; a piece with turrets survives as a
      // gun-rock so it can keep firing, even if small
      const area = polygonArea(partVerts)
      if (area < debrisMinArea && mine.length === 0) {
        slivers.push({ centre, drift, area })
      } else {
        wreckage.push({ partVerts, centre, drift, mine })
      }
    }

    if (!survives && !wreckage.length) {
      // Too small to leave anything: destroyed outright, and worth what shooting
      // it down was worth.
      ship.destroy(this, fromPlayer ? ship.type.killScore : 0)
      return true
    }

    for (const piece of wreckage) {
      // burning debris at the cut end
      this.burst(piece.centre.x, piece.centre.y, randInt(10, 16), PALETTE.fx.fire, 40, 190, 0.75)
      this.burst(piece.centre.x, piece.centre.y, randInt(6, 10), PALETTE.fx.ember, 30, 130, 0.5)
      this.asteroids.push(
        new Asteroid({
          vertices: piece.partVerts,
          vx: piece.drift.vx,
          vy: piece.drift.vy,
          spin: randRange(-1.2, 1.2),
          hardpoints: piece.mine,
          tint: ship.colour, // keep the hull's colour on the debris
          material, // plating: survives smaller, and burns where it is torn
          burnFrom: { point: beam.a, normal: cutNormal },
        }),
      )
    }
    for (const sliver of slivers) {
      this.burst(sliver.centre.x, sliver.centre.y, randInt(10, 16), PALETTE.fx.fire, 40, 190, 0.75)
      // by area, as a rock fragment is: a splinter off a nose was paying the same
      // as half a hull
      for (let k = 0; k < oreFromFragment(sliver.area); k++) {
        this.spawnOre(
          sliver.centre.x + randRange(-12, 12),
          sliver.centre.y + randRange(-12, 12),
          sliver.drift.vx,
          sliver.drift.vy,
        )
      }
    }
    this.ring(ship.x, ship.y, 16, PALETTE.fx.flash, 190, 0.6)
    this.screenShake = Math.max(this.screenShake, 9)
    Sound.explode()
    if (survives) {
      // Still flying, with a flat edge where the corner used to be. Nothing is paid for a
      // graze: the ship is still there to be shot at.
      ship.reshape(
        biggest,
        parts.filter((part) => part !== biggest),
        { point: beam.a, normal: cutNormal },
      )
      return true
    }
    if (fromPlayer) {
      this.score += ship.type.blastScore
    }
    ship.dead = true
    return true
  }

  // ---- level / sector flow --------------------------------------------
  // Which hazard a rock carries, weighed the way every pool is: see WEIGHTS.
  rollHazardTraits(sector) {
    const hazard = weightedPick(HAZARD_TRAITS, (entry) => weightAt(entry, sector))
    return hazard ? this.#traitsForSector(hazard.traits, sector) : {}
  }

  // Which of a gun trait's pool a sector may arm a rock from, and what each of
  // them weighs there. Each kind joins at its own sector, so a late sector arms
  // its rocks from a broader mix than an early one without arming any more of
  // them.
  gunsForSector(gun, sector) {
    return gun.guns
      .map((entry) => ({ ...entry, weight: weightAt(entry, sector) }))
      .filter((entry) => entry.weight > 0)
  }

  // A rock is built without knowing which sector it is in, so the pool it is
  // handed is cut to size and weighed here, where the sector is known.
  #traitsForSector(traits, sector) {
    const rolled = { ...traits }
    if (rolled.gun && rolled.gun.guns) {
      rolled.gun = { ...rolled.gun, guns: this.gunsForSector(rolled.gun, sector) }
    }
    return rolled
  }

  planLevel(sector) {
    const { rocks, hazards, rivals, spawn, specials } = PROGRESSION
    const count = Math.min(rocks.base + Math.ceil(sector * rocks.perSector), rocks.max)
    const hazardChance =
      sector < hazards.fromSector
        ? 0
        : clamp(hazards.base + (sector - hazards.fromSector) * hazards.perSector, 0, hazards.max)
    const spawns = []
    for (let i = 0; i < count; i++) {
      spawns.push({
        traits: Math.random() < hazardChance ? this.rollHazardTraits(sector) : {},
        radius: randRange(CONFIG.AST_MAX_R * spawn.radius[0], CONFIG.AST_MAX_R * spawn.radius[1]),
      })
    }
    return {
      spawns,
      specials: sector >= specials.fromSector,
      rivals:
        sector < RIVALS_FROM_SECTOR
          ? 0
          : Math.min(1 + Math.floor((sector - RIVALS_FROM_SECTOR) / rivals.perSectors), rivals.max),
      rivalInterval: clamp(
        rivals.intervalBase - sector * rivals.intervalPerSector,
        rivals.intervalMin,
        rivals.intervalBase,
      ),
    }
  }

  startLevel(sector) {
    this.level = sector
    this.plan = this.planLevel(sector)
    this.backdrop.regenSector(sector) // seeded backdrop for this sector's vibe
    this.asteroids = []
    this.oreChunks = []
    this.projectiles = []
    this.specialPickups = []
    this.rivals = []
    this.laserShots = []
    this.glitches = []
    this.particles = []
    this.stats = this.blankStats()
    this.summaryData = null
    this.oreVacuum = false

    const place = PROGRESSION.spawn
    for (const spawn of this.plan.spawns) {
      // scatter across the arena disc, clear of the ship spawn at the centre
      let x,
        y,
        tries = 0
      do {
        const a = randRange(0, TAU),
          rr = Math.sqrt(Math.random()) * (ARENA.radius - place.edgeMargin)
        x = ARENA.cx + Math.cos(a) * rr
        y = ARENA.cy + Math.sin(a) * rr
        tries++
      } while (
        Math.hypot(x - ARENA.cx, y - ARENA.cy) < place.clearRadius &&
        tries < place.placementTries
      )
      const angle = randRange(0, TAU),
        speed = randRange(place.speed[0], place.speed[1])
      this.asteroids.push(
        new Asteroid({
          x,
          y,
          radius: spawn.radius,
          traits: spawn.traits,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          spin: randRange(place.spin[0], place.spin[1]),
        }),
      )
    }

    this.specialTimer = randRange(
      PROGRESSION.specials.firstDelay[0],
      PROGRESSION.specials.firstDelay[1],
    )
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
    this.seenSpecials = new Set()
    this.player = new PlayerShip(this)
    // What the hull came with counts as met, so a magnet thrown overboard can be
    // bought back rather than being gone for the run.
    for (const item of this.player.items) {
      if (item) {
        this.findSpecial(item.id)
      }
    }
    this.startLevel(1)
  }

  // Arriving at the shop, however the sector ended. Clearing it sweeps up the loose
  // ore, pays the end-of-sector bonuses and offers the next sector. Walking out of
  // one does none of that: the ore still on the field is left where it lies, nothing
  // is paid, and the launch offers the same sector again, so the trip to the shop
  // buys a better loadout for another attempt rather than skipping it.
  enterShop(cleared = true) {
    this.sandbox = false // whatever the dev arena was for, it is over once the shop opens
    this.oreVacuum = false
    if (cleared) {
      const remaining = this.oreChunks.length
      this.score += remaining * CONFIG.ORE_SCORE
      this.stats.ore += remaining
      this.oreBalance += remaining
    }
    this.oreChunks.length = 0

    // No shots means no accuracy to reward. Reading it as a perfect 1 paid the
    // whole bonus for clearing a sector without firing.
    const accuracy = this.stats.shots ? this.stats.hits / this.stats.shots : 0
    const accuracyBonus = cleared ? Math.round(accuracy * CONFIG.ACCURACY_BONUS) : 0
    const flawlessBonus = cleared && this.stats.damage <= 0 ? CONFIG.FLAWLESS_BONUS : 0
    const clearBonus = cleared ? this.level * CONFIG.CLEAR_BONUS_PER_SECTOR : 0
    const totalBonus = accuracyBonus + flawlessBonus + clearBonus
    this.score += totalBonus
    this.summaryData = {
      level: this.level,
      bailed: !cleared,
      accuracy,
      mined: this.stats.mined,
      ore: this.stats.ore,
      damage: Math.round(this.stats.damage),
      accuracyBonus,
      flawlessBonus,
      clearBonus,
      totalBonus,
    }
    this.shopSelection = 0
    this.shopSlot = 0
    this.slotMenu = null
    this.shopSector = cleared ? this.level + 1 : this.level
    this.recordBest()
    this.rememberRun()
    this.phase = "shop"
  }

  // Walk out of a sector that is more than the ship can handle, and come back to it
  // with whatever the shop can sell you.
  exitSector() {
    if (!this.canExitSector()) {
      return
    }
    this.paused = false
    this.pausePage = "root"
    this.rebinding = null
    Sound.setThruster(false)
    this.enterShop(false)
  }

  // The shop's page in cursor order: the purchases, with the special slots at the
  // row SHOP_LAYOUT names, then the launch line. Everything that walks or draws
  // the shop takes its indices from here, so the layout is stated once.
  get slotsRow() {
    return SHOP_LAYOUT.slotsRow
  }
  get launchRow() {
    return SHOP.length + 1
  }
  get optionsRow() {
    return SHOP.length + 2
  }

  // The upgrade a row is selling, or null for one of the rows the shop adds.
  shopItem(row) {
    if (row === this.slotsRow || row > SHOP.length) {
      return null
    }
    return SHOP[row < this.slotsRow ? row : row - 1]
  }

  // What is held in a special slot, or null for an empty one.
  slotItem(slot) {
    return (this.player && this.player.items[slot]) || null
  }

  // The registry entry for what is in a slot, or null.
  slotType(slot) {
    const item = this.slotItem(slot)
    return item ? SPECIAL_TYPES[item.id] : null
  }

  // A special fetches a fixed fraction of what it costs, so none is worth more
  // sold than bought.
  specialSellValue(id) {
    return Math.round(SPECIAL_TYPES[id].cost * CONFIG.SPECIAL_SELL_FRACTION)
  }
  slotSellValue(slot) {
    const item = this.slotItem(slot)
    return item ? this.specialSellValue(item.id) : 0
  }

  // Trade a carried special back in for ore. The slot is emptied where it stands:
  // a slot's index is its identity, so the ones beside it do not shuffle along.
  sellSlot(slot) {
    const item = this.slotItem(slot)
    if (!item) {
      return
    }
    this.oreBalance += this.specialSellValue(item.id)
    this.player.items[slot] = null
    this.closeSlotMenu()
    this.rememberRun()
    Sound.collect()
  }

  // Fit a bought special into an empty slot.
  buySpecial(slot, id) {
    if (this.slotItem(slot) || slot >= this.specialSlots()) {
      return
    }
    const cost = SPECIAL_TYPES[id].cost
    if (!this.devMode) {
      if (this.oreBalance < cost) {
        Sound.hit()
        return
      }
      this.oreBalance -= cost
    }
    this.player.equip(slot, id)
    this.closeSlotMenu()
    this.rememberRun()
    Sound.power()
  }

  // The pop-over's rows for one slot: what can be done with what is in it, then
  // what could be put in it. An entry that declares `rows` stands in for a list
  // that is not known until the run has found something.
  // What the pop-over is titled, asked of the game rather than worked out by the
  // view: only here knows whether it was opened on a slot, on a piece of equipment
  // or on a ladder of levels.
  slotMenuTitle() {
    const menu = this.slotMenu
    if (!menu) {
      return ""
    }
    if (menu.equipment) {
      return EQUIPMENT[menu.equipment].label
    }
    if (menu.levels) {
      return this.shopRowById(menu.levels).name
    }
    const spec = this.slotType(menu.slot)
    if (spec) {
      return spec.label
    }
    return menu.slot < this.specialSlots() ? "EMPTY" : "LOCKED"
  }

  // The colour a title is drawn in, which is a special's own and nothing else's.
  slotMenuColour() {
    const menu = this.slotMenu
    const spec = menu && !menu.equipment && !menu.levels ? this.slotType(menu.slot) : null
    return spec ? spec.colour : null
  }

  shopRowById(id) {
    return SHOP.find((entry) => entry.id === id)
  }

  // One step of a levelled upgrade per row, each saying what it buys. Only the next
  // one along has a price: a ladder is climbed in order.
  levelRows(id) {
    const row = this.shopRowById(id)
    const at = this.upgrades[id]
    return row.levels.map((step, level) => ({
      name: step.name,
      desc: step.desc,
      value: (g) => {
        if (level === g.upgrades[id]) {
          return "FITTED"
        }
        if (level < g.upgrades[id]) {
          return "-"
        }
        return level === g.upgrades[id] + 1
          ? g.devMode
            ? "FREE"
            : `${row.levelCost(at)} ore`
          : "-"
      },
      // The one step there is anything to spend on: the next one up.
      buyable: (g) => level === g.upgrades[id] + 1,
      action: (g) => {
        if (level !== g.upgrades[id] + 1) {
          return
        }
        const cost = row.levelCost(g.upgrades[id])
        if (!g.devMode) {
          if (g.oreBalance < cost) {
            Sound.hit()
            return
          }
          g.oreBalance -= cost
        }
        g.upgrades[id]++
        if (row.levelApply) {
          row.levelApply(g)
        }
        g.rememberRun()
        Sound.power()
      },
    }))
  }

  // The rows the pop-over shows. A shop row naming an equipment slot lists that
  // slot's options, one naming a levelled upgrade lists its steps, and the specials
  // row lists what a special slot can do.
  slotMenuRows(slot) {
    const menu = this.slotMenu
    if (menu && menu.equipment) {
      return this.equipmentRows(menu.equipment)
    }
    if (menu && menu.levels) {
      return this.levelRows(menu.levels)
    }
    const rows = []
    for (const entry of SLOT_MENU) {
      if (entry.rows) {
        rows.push(...entry.rows(this, slot))
      } else if (!entry.available || entry.available(this, slot)) {
        rows.push(entry)
      }
    }
    return rows
  }

  openSlotMenu(slot) {
    if (!this.slotMenuRows(slot).length) {
      return
    }
    this.slotMenu = { slot, selection: 0 }
  }

  // Open the pop-over on an equipment slot rather than on a special slot, on the row
  // there is anything to do with: the first thing worth buying, or what is fitted when
  // the slot is already full up. Same as a levelled row, which opens on its next step.
  openEquipmentMenu(slot) {
    const rows = this.equipmentRows(slot)
    const wanted = rows.findIndex((row) => row.buyable && row.buyable(this, 0))
    const fitted = EQUIPMENT[slot].options.findIndex(
      (option) => option.id === this.fittedEquipment(slot),
    )
    this.slotMenu = {
      slot: 0,
      equipment: slot,
      selection: wanted >= 0 ? wanted : Math.max(0, fitted),
    }
  }

  // Or on the ladder of a levelled upgrade, starting on the next step rather than on
  // the one already fitted: that is the row there is anything to do with.
  openLevelMenu(id) {
    const row = this.shopRowById(id)
    const next = Math.min(this.upgrades[id] + 1, row.levels.length - 1)
    this.slotMenu = { slot: 0, levels: id, selection: next }
  }

  closeSlotMenu() {
    this.slotMenu = null
  }

  // Work the open pop-over: move the cursor, or run the highlighted row.
  // Move the open pop-over to the box beside it. A slot with nothing to offer is
  // stepped over rather than opened empty, and running out of boxes leaves it where it
  // is: the row is a row of boxes, not a loop.
  #slotMenuAcross(step) {
    const direction = Math.sign(step)
    for (let slot = this.shopSlot + direction; slot >= 0 && slot < MAX_SLOTS; slot += direction) {
      if (this.slotMenuRows(slot).length) {
        this.shopSlot = slot
        this.slotMenu = { slot, selection: 0 }
        Sound.bump()
        return
      }
    }
  }

  #slotMenuMove(delta) {
    const rows = this.slotMenuRows(this.slotMenu.slot).length
    this.slotMenu.selection = (this.slotMenu.selection + delta + rows) % rows
  }
  #slotMenuConfirm() {
    const { slot, selection } = this.slotMenu
    const row = this.slotMenuRows(slot)[selection]
    if (!row) {
      return
    }
    const wasBuyable = !!row.buyable && row.buyable(this, slot)
    row.action(this, slot)
    // A row that was a purchase and is not one any more is a purchase that went
    // through: one too dear to afford stays buyable, and the cursor stays on it.
    if (this.slotMenu && wasBuyable && !row.buyable(this, slot)) {
      this.#landOnNextPurchase()
    }
  }

  // Land on the next row there is something to spend on, so a ladder can be climbed
  // without walking back up it after every purchase. Nothing left to buy leaves the
  // cursor where it is.
  #landOnNextPurchase() {
    const { slot, selection } = this.slotMenu
    const rows = this.slotMenuRows(slot)
    for (let step = 1; step <= rows.length; step++) {
      const at = (selection + step) % rows.length
      if (rows[at].buyable && rows[at].buyable(this, slot)) {
        this.slotMenu.selection = at
        return
      }
    }
  }

  doShopAction() {
    if (this.shopSelection === this.slotsRow) {
      this.openSlotMenu(this.shopSlot)
      return
    }
    if (this.shopSelection === this.launchRow) {
      this.startLevel(this.shopSector)
      return
    }
    if (this.shopSelection === this.optionsRow) {
      this.toggleOptions()
      return
    }
    const item = this.shopItem(this.shopSelection)
    // An equipment row has nothing to buy of its own: it opens on what its slot
    // could hold, and the buying and swapping happen in there.
    if (item.equipment) {
      this.openEquipmentMenu(item.equipment)
      return
    }
    if (item.levels) {
      this.openLevelMenu(item.id)
      return
    }
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

  // Ease anything sitting where the ship is about to appear out of the way while
  // it arrives. A ship warps in solid, and a rock that has drifted over the spawn
  // point would otherwise be inside it. The whole warp is spent clearing the space,
  // so a rock drifts aside as though the arrival's ripples were moving it, rather
  // than jumping. Returns whether anything was in the way.
  clearSpawnArea(dt, x, y) {
    const radius = CONFIG.SPAWN_CLEAR_RADIUS
    let clearing = false
    for (const asteroid of this.asteroids) {
      const dx = asteroid.center.x - x,
        dy = asteroid.center.y - y
      const distance = Math.hypot(dx, dy)
      const overlap = radius + asteroid.boundRadius - distance
      if (overlap <= 0) {
        continue
      }
      // A rock centred exactly on the spawn point has no direction to be pushed
      // in, so pick one.
      const bearing = distance > 1e-6 ? Math.atan2(dy, dx) : randRange(0, TAU)
      const ux = Math.cos(bearing),
        uy = Math.sin(bearing)
      // Undo a share of what is left each frame, so it eases out and slows as it
      // goes, and give it enough of a push to keep drifting once it is clear. An
      // exponential ease moves fastest on its first frame, which over a deep
      // overlap is a lurch, so the speed is capped as the camera's pan is.
      const step = Math.min(overlap * CONFIG.SPAWN_CLEAR_RATE, CONFIG.SPAWN_CLEAR_SPEED) * dt
      asteroid.translate(ux * step, uy * step)
      asteroid.vx += ux * CONFIG.SPAWN_CLEAR_PUSH * dt
      asteroid.vy += uy * CONFIG.SPAWN_CLEAR_PUSH * dt
      clearing = true
    }
    return clearing
  }

  playerLoseLife() {
    this.lives--
    Sound.explode()
    this.burst(this.player.x, this.player.y, 40, PALETTE.player.hull, 60, 260, 1.0)
    this.ring(this.player.x, this.player.y, 20, PALETTE.text.bright, 200, 0.8)
    this.screenShake = 14
    if (this.lives <= 0) {
      this.recordBest()
      this.forgetRun() // the run is over; nothing to come back to
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
    p.hull = PLAYER_TYPE.hull // a fresh ship, as the lives count says
    p.invincible = CONFIG.INVIN_TIME
    p.mainWeapon.release()
    p.beginWarpIn(CONFIG.RESPAWN_PAUSE)
    this.phase = "arriving"
    this.clearInput()
  }

  // Use what is in a slot. A special is equipment: it stays in its slot and the
  // slot goes on cooldown, so what limits its use is the cell and the wait.
  // A toggle switches off again from here, which is the same press.
  useSpecialSlot(index) {
    const player = this.player,
      item = player.items[index]
    if (!item) {
      return
    }
    const type = SPECIAL_TYPES[item.id]
    if (item.active) {
      player.stopSlot(index)
      this.showToast(`${type.label} OFF`)
      return
    }
    if (item.cooldown > 0) {
      Sound.hit()
      return
    }
    const cost = (type.energy ?? 0) * player.energyMax
    if (player.energy < cost) {
      Sound.hit()
      this.showToast(`${type.label} NEEDS ${Math.ceil(cost)} ENERGY`)
      return
    }
    player.energy -= cost
    Sound.power()
    this.showToast(`${type.label} ACTIVATED`)
    if (type.mode === "toggle") {
      item.active = true
    } else if (type.seconds) {
      player.grantBuff(item.id, type.seconds) // its cooldown starts when it runs out
    } else {
      item.cooldown = type.cooldown ?? 0 // a pulse is over as it happens
    }
    if (type.apply) {
      type.apply(this, player, type)
    }
    if (type.mode === "single") {
      player.items[index] = null // spent, not recharging
    }
  }

  // Throw the special in a slot overboard. It is flung clear of the nose and
  // arms before it can be picked up, so letting go of the button does not
  // immediately take it back.
  jettisonSlot(index) {
    const player = this.player,
      item = player && player.items[index]
    if (!item || !this.canFly()) {
      return
    }
    const type = SPECIAL_TYPES[item.id]
    player.stopSlot(index) // whatever it was doing stops with it
    player.items[index] = null
    // Out of the tail, at its own speed and not the ship's, so flying on leaves it
    // behind instead of dragging it along or overtaking it.
    const bearing = player.angle + Math.PI + randRange(-0.5, 0.5)
    const speed = randRange(CONFIG.SPECIAL_JETTISON_SPEED[0], CONFIG.SPECIAL_JETTISON_SPEED[1])
    const pickup = new Special(
      player.x + Math.cos(bearing) * (player.boundRadius + 10),
      player.y + Math.sin(bearing) * (player.boundRadius + 10),
      Math.cos(bearing) * speed,
      Math.sin(bearing) * speed,
      item.id,
    )
    pickup.arming = CONFIG.SPECIAL_ARM_TIME
    pickup.drag = CONFIG.SPECIAL_JETTISON_DRAG
    this.specialPickups.push(pickup)
    this.showToast(`${type.label} JETTISONED`)
    Sound.bump()
  }

  // The player as anything hunting it can see it, or null when nothing should be
  // able to. Every site that steers toward, aims at or shoots at the player asks
  // through this, so one answer hides it from all of them.
  //
  // Two things hide it. A special that declares `invisible`, and simply not being
  // reachable: a ship still warping in, or inside the grace period that follows,
  // cannot be harmed, and anything allowed to keep shooting at it would only be
  // stacking up rounds to land the moment the grace runs out.
  visiblePlayer() {
    if (!this.player || this.player.untouchable) {
      return null
    }
    return this.player.buffField("invisible", false) ? null : this.player
  }

  // The nearest body of `bodies` to a point, as { target, distance }, or null when
  // nothing qualifies. Only what can actually be shot at counts: `inPlay` is the
  // question every weapon already asks before it can hit anything, and a body
  // killed earlier in the frame stays in its list until the frame ends. `within`
  // bounds the search, so a caller wanting only targets in range says so instead
  // of measuring afterwards.
  #nearest(bodies, from, within = Infinity) {
    let found = null,
      closest = within
    for (const body of bodies) {
      if (body.dead || !body.inPlay()) {
        continue
      }
      const away = distanceTo(from, body)
      if (away < closest) {
        closest = away
        found = body
      }
    }
    return found ? { target: found, distance: closest } : null
  }

  // The nearest of each kind. The collections live here, so the question is
  // answered here, the way visiblePlayer() answers for the player.
  nearestRival(from, within) {
    return this.#nearest(this.rivals, from, within)
  }
  nearestAsteroid(from, within) {
    return this.#nearest(this.asteroids, from, within)
  }
  nearestOre(from, within) {
    return this.#nearest(this.oreChunks, from, within)
  }

  // What `host` would shoot at: the nearest body of a faction its own is hostile
  // to, measured from `from` (a gun asks from its own hardpoint, a hull from
  // itself) and no further than `within`.
  //
  // This is the only question a weapon or a hunting hull asks about targets, so
  // adding a side is an edit to FACTIONS and nothing else. Being seen at all is
  // part of the answer and not a separate test the callers could forget: the
  // player is the one body that can hide, and visiblePlayer is where that lives.
  hostileTarget(host, from = host, within = Infinity) {
    const hostile = FACTIONS[host.faction]
    if (!hostile) {
      return null
    }
    // A target has to be found before it can be shot at, so the search is bounded
    // by what the host's radar reaches as well as by whatever the caller asked for.
    const reach = host.sensorRange ? host.sensorRange("ships") : Infinity
    const candidates = []
    if (hostile.includes("player")) {
      const player = this.visiblePlayer()
      if (player && player !== host) {
        candidates.push(player)
      }
    }
    for (const rival of this.rivals) {
      if (rival !== host && hostile.includes(rival.faction)) {
        candidates.push(rival)
      }
    }
    return this.#nearest(candidates, from, Math.min(within, reach))
  }

  // Specials the run has met. A kind has to be found in a sector before the shop
  // will sell it, so the shop's stock is a record of what the run has seen.
  findSpecial(id) {
    this.seenSpecials.add(id)
  }

  // What the shop can put in an empty slot. Dev mode waives having found one, so
  // a new special can be tried without hunting for it, but not the registry's own
  // say on whether it is for sale at all.
  buyableSpecials() {
    return SPECIAL_IDS.filter(
      (id) => SPECIAL_TYPES[id].buyable && (this.devMode || this.seenSpecials.has(id)),
    )
  }

  // ---- per-frame update ------------------------------------------------
  update(dt) {
    this.#tickSlotHolds(dt)
    if (this.toast) {
      this.toast.life -= dt
      if (this.toast.life <= 0) {
        this.toast = null
      }
    }

    if (this.phase === "play") {
      if (this.plan.specials) {
        this.specialTimer -= dt
        if (
          this.specialTimer <= 0 &&
          this.specialPickups.length < PROGRESSION.specials.maxOnField
        ) {
          this.spawnSpecial()
          this.specialTimer = randRange(
            PROGRESSION.specials.interval[0],
            PROGRESSION.specials.interval[1],
          )
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

    // Arriving is when the space is made: the ship is not solid yet, so a rock can
    // be moved out from under it without a collision.
    if (this.player.warpTarget === 1 && this.player.warp < 1) {
      this.clearSpawnArea(dt, this.player.x, this.player.y)
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
    for (const pickup of this.specialPickups) {
      pickup.update(dt, this)
    }
    this.specialPickups = this.specialPickups.filter((p) => !p.dead)
    for (const rival of this.rivals) {
      rival.update(dt, this)
    }
    this.resolveShipCollisions()
    this.rivals = this.rivals.filter((r) => !r.dead)
    this.updateParticles(dt)
    for (let i = this.glitches.length - 1; i >= 0; i--) {
      this.glitches[i].life -= dt
      if (this.glitches[i].life <= 0) {
        this.glitches.splice(i, 1)
      }
    }
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
    } else if (this.phase === "play" && this.asteroids.length === 0 && !this.sandbox) {
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
  // outlines as convex parts. Overlap is eased out over a few frames rather
  // than corrected in one step, so a contact settles instead of flicking apart,
  // and a small slop is tolerated so resting rocks do not jitter.
  //
  // The response is mass-weighted from each rock's area and uses
  // ROCK_RESTITUTION, so a boulder shrugs off a chip instead of swapping
  // velocities with it, and a pair settles instead of bouncing forever.
  // Several sweeps run per frame, so a rock wedged between two others is
  // separated from both.
  resolveAsteroidCollisions() {
    const list = this.asteroids
    for (let sweep = 0; sweep < CONFIG.CONTACT_ITERATIONS; sweep++) {
      let touched = false
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (this.#resolveRockPair(list[i], list[j], sweep === 0)) {
            touched = true
          }
        }
      }
      if (!touched) {
        return
      }
    }
  }

  // Draw the loose particles near a point toward it. Particles are not bodies and have
  // no collections of their own to walk, so this is the one place that reaches into them:
  // a well pulling what is drifting past is the whole of what a wind-up looks like.
  drawInParticles(centre, radius, pull, dt) {
    for (const p of this.particles) {
      const dx = centre.x - p.x,
        dy = centre.y - p.y
      const away = Math.hypot(dx, dy)
      if (away > radius || away < 1) {
        continue
      }
      const falloff = 1 - away / radius
      p.vx += (dx / away) * pull * falloff * dt
      p.vy += (dy / away) * pull * falloff * dt
    }
  }

  // Tear the picture at a world point: a short-lived, local failure of the screen
  // itself, for a hit that should feel like it reached out of the game. The view turns
  // these into the sources the composite pass reads; nothing in the simulation depends
  // on them, so a renderer that cannot show them simply does not.
  glitchAt(x, y, strength = 1, radius = 150, seconds = 0.28) {
    this.glitches.push({ x, y, strength, radius, life: seconds, maxLife: seconds })
  }

  // A piece hit harder than it holds together comes apart where it was struck, rather
  // than being shoved. What decides it is the closing speed and the piece's own
  // material, so nothing here knows what wreckage is: a hull fragment still carrying
  // its ship's momentum bursts on the first thing it meets, the same fragment once it
  // has slowed to a drift is shouldered aside, and a rock takes a great deal more
  // either way. Called from every contact that measures a closing speed.
  impactShatter(asteroid, closing) {
    if (asteroid.dead || closing <= asteroid.shatterAt) {
      return false
    }
    this.shatterToOre(asteroid)
    asteroid.dead = true
    // What it looked like when it went, which the ore puff alone does not carry: the
    // bigger the piece and the harder it was hit, the more comes off it. A piece that
    // burns is throwing fire as well as debris, so plating breaking up reads differently
    // from rock giving way.
    const heft = clamp(asteroid.area / CONFIG.ORE_PER_ROCK_AREA, 0.4, 2.5)
    const force = clamp(closing / asteroid.shatterAt, 1, 2.5)
    const at = asteroid.center
    this.burst(at.x, at.y, Math.round(16 * heft * force), PALETTE.rock.impact, 60, 240 * force, 0.6)
    this.ring(at.x, at.y, Math.round(10 * heft), PALETTE.fx.flash, 180 * force, 0.45)
    if (asteroid.burnSpec) {
      this.burst(at.x, at.y, Math.round(14 * heft), PALETTE.fx.fire, 40, 190 * force, 0.75)
      this.burst(at.x, at.y, Math.round(6 * heft), PALETTE.fx.ember, 30, 120, 0.9)
    }
    this.screenShake = Math.max(this.screenShake, 4 + 4 * heft)
    Sound.explode()
    return true
  }

  // One rock pair. `spark` gates the impact effect to the first sweep, so a
  // contact does not emit particles once per iteration.
  #resolveRockPair(a, b, spark) {
    if (a.dead || b.dead) {
      return false // a rock already shattered this frame pushes nothing
    }
    const dx = b.center.x - a.center.x,
      dy = b.center.y - a.center.y
    const reach = a.contactReach() + b.contactReach()
    if (dx * dx + dy * dy >= reach * reach) {
      return false
    }
    const contact = shapeContact(a.contactShape(), b.contactShape())
    if (!contact) {
      return false
    }
    const ux = contact.nx,
      uy = contact.ny
    const massA = a.mass,
      massB = b.mass
    const total = massA + massB
    const push = Math.max(0, contact.depth - CONFIG.CONTACT_SLOP) * CONFIG.CONTACT_BIAS
    if (push > 0) {
      // the lighter rock gives way, in inverse proportion to mass
      a.translate((-ux * push * massB) / total, (-uy * push * massB) / total)
      b.translate((ux * push * massA) / total, (uy * push * massA) / total)
    }
    const closing = (b.vx - a.vx) * ux + (b.vy - a.vy) * uy
    if (closing < 0) {
      // Either of them may be hit harder than it holds together. Checked before the
      // bounce, so a piece that comes apart does so where it struck rather than being
      // flung off first, and checked for both, so which one was moving does not matter.
      const broke = this.impactShatter(a, -closing) || this.impactShatter(b, -closing)
      if (broke) {
        return true
      }
      const j = (-(1 + CONFIG.ROCK_RESTITUTION) * closing) / (1 / massA + 1 / massB)
      a.vx -= (j * ux) / massA
      a.vy -= (j * uy) / massA
      b.vx += (j * ux) / massB
      b.vy += (j * uy) / massB
      if (spark && -closing > 60) {
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
    return true
  }

  // Hull against hull: every ship pair, the player included. Without this a
  // rival could be flown straight through, and two rivals could sit inside one
  // another indefinitely.
  resolveShipCollisions() {
    const ships = this.player && this.player.solid ? [this.player, ...this.rivals] : this.rivals
    for (let sweep = 0; sweep < CONFIG.CONTACT_ITERATIONS; sweep++) {
      if (!this.#shipSweep(ships, sweep === 0)) {
        return
      }
    }
  }

  // One pass over every ship pair. `spark` gates the impact effect to the first
  // sweep so a contact does not flare once per iteration.
  #shipSweep(ships, spark) {
    let touched = false
    for (let i = 0; i < ships.length; i++) {
      for (let j = i + 1; j < ships.length; j++) {
        if (ships[i].dead || ships[j].dead) {
          continue
        }
        const closing = resolveShipPair(ships[i], ships[j])
        if (closing > 0) {
          touched = true
        }
        if (spark && closing > 60) {
          this.burst(
            (ships[i].x + ships[j].x) / 2,
            (ships[i].y + ships[j].y) / 2,
            4,
            PALETTE.rival.hullSpark,
            30,
            110,
            0.3,
          )
          this.screenShake = Math.max(this.screenShake, 4)
        }
      }
    }
    return touched
  }

  // ---- settings --------------------------------------------------------
  // Every setter keeps the value, tells whatever needs to know, and writes the lot
  // back to storage. The renderer is main.js's business, so `crt` is only recorded
  // here and picked up from there.
  setVolume(value) {
    this.settings.volume = clamp(Math.round(value * 10) / 10, 0, 1)
    this.applySound()
    // A blip at the level just set, so the slider can be heard and not only read.
    // After applySound, or it would play at the level being left behind.
    Sound.power()
    this.rememberSettings()
  }
  setSound(on) {
    const was = this.settings.sound
    this.settings.sound = !!on
    this.applySound()
    // Switching it on plays a tone, which is the only way the setting can show what
    // it did. Switching it off cannot, and re-confirming a setting that has not
    // moved would blip on every keypress along a menu row.
    if (this.settings.sound && !was) {
      Sound.power()
    }
    this.rememberSettings()
  }
  setCrt(on) {
    this.settings.crt = !!on
    this.rememberSettings()
  }
  setHelp(on) {
    this.settings.help = !!on
    this.rememberSettings()
  }
  // Step the HUD's scale along the sizes offered, wrapping, so one row works
  // whether it is pressed or nudged left and right.
  setUiScale(value) {
    const nearest = UI_SCALES.reduce((best, size) =>
      Math.abs(size - value) < Math.abs(best - value) ? size : best,
    )
    this.settings.uiScale = nearest
    this.rememberSettings()
  }
  stepUiScale(step) {
    const at = UI_SCALES.indexOf(this.settings.uiScale)
    const next = (at + (step > 0 ? 1 : -1) + UI_SCALES.length) % UI_SCALES.length
    this.setUiScale(UI_SCALES[next])
  }
  applySound() {
    Sound.enabled = this.settings.sound
    Sound.setVolume(this.settings.volume)
  }
  rememberSettings() {
    saveSettings({ ...this.settings })
  }

  // Ask to be closed. main.js does the closing, since the window is its business.
  requestExit() {
    Sound.setThruster(false)
    this.exitRequested = true
  }

  // ---- the run in progress ---------------------------------------------
  // Snapshotted at the shop, which is the one moment nothing is in flight: no
  // asteroids mid-cut, no ore drifting, no rival halfway across the sector.
  rememberRun() {
    this.savedRun = {
      level: this.level,
      // Where the run carries on from, which is the sector after the one just
      // cleared, or the same one again when it was walked out of.
      next: this.shopSector,
      bailed: !!(this.summaryData && this.summaryData.bailed),
      score: this.score,
      lives: this.lives,
      oreBalance: this.oreBalance,
      rivalScore: this.rivalScore,
      upgrades: {
        ...this.upgrades,
        // Copied rather than shared: a shallow spread would leave the saved run
        // pointing at the live tables and drifting with them.
        owned: Object.fromEntries(
          Object.entries(this.upgrades.owned).map(([slot, ids]) => [slot, ids.slice()]),
        ),
        fitted: { ...this.upgrades.fitted },
      },
      // Carried specials are part of the loadout the shop sends you out with, so
      // they survive a session the way the upgrades do. So does the record of
      // what the run has found, which is what the shop will sell.
      items: this.player ? this.player.items.map((item) => (item ? item.id : null)) : [],
      seen: [...this.seenSpecials],
    }
    saveRun(this.savedRun)
  }

  forgetRun() {
    this.savedRun = null
    clearRun()
  }

  // The sector a saved run carries on into. A run is snapshotted at the shop,
  // once its sector is already cleared, so it resumes into the one after that.
  // Everything that names the saved run to the player goes through this, so the
  // title, the pause menu and the shop cannot disagree about which sector it is.
  resumeSector() {
    if (!this.savedRun) {
      return 1
    }
    // `next` was added after the first saves were written, so fall back to the old
    // meaning: a run was only ever snapshotted after clearing its sector.
    return this.savedRun.next ?? this.savedRun.level + 1
  }

  // Pick up where a previous session left off, at the shop before the sector that
  // was next. Falls back to a fresh run if there is nothing to resume.
  // What a saved run owns and has fitted, checked against the registry: a slot
  // added since the save keeps its defaults, and an option removed since is
  // dropped rather than mounted.
  #restoredEquipment(run) {
    const fresh = freshEquipment()
    const saved = run.upgrades || {}
    for (const slot of Object.keys(EQUIPMENT)) {
      const known = (id) => !!this.equipmentOption(slot, id)
      for (const id of (saved.owned && saved.owned[slot]) || []) {
        if (known(id) && !fresh.owned[slot].includes(id)) {
          fresh.owned[slot].push(id)
        }
      }
      // A slot saved as empty was emptied on purpose, so it is not quietly refilled
      // with whatever came free with the hull.
      const stated = saved.fitted && slot in saved.fitted
      const wanted = stated ? saved.fitted[slot] : undefined
      if (wanted === null && EQUIPMENT[slot].removable) {
        fresh.fitted[slot] = null
      } else if (known(wanted) && fresh.owned[slot].includes(wanted)) {
        fresh.fitted[slot] = wanted
      }
    }
    return fresh
  }

  resumeRun() {
    const run = this.savedRun
    if (!run) {
      this.startNewGame()
      return
    }
    this.score = run.score
    this.rivalScore = run.rivalScore || 0
    this.lives = run.lives
    this.oreBalance = run.oreBalance
    this.upgrades = { ...freshUpgrades(), ...run.upgrades, ...this.#restoredEquipment(run) }
    this.level = run.level
    this.player = new PlayerShip(this)
    // Anything the registry no longer knows is dropped, so an old save cannot put
    // a special that has since been removed into a slot or onto the shop's shelf.
    ;(run.items || []).forEach((id, slot) => {
      if (SPECIAL_TYPES[id] && slot < MAX_SLOTS) {
        this.player.equip(slot, id)
      }
    })
    this.seenSpecials = new Set((run.seen || []).filter((id) => SPECIAL_TYPES[id]))
    this.stats = this.blankStats()
    this.asteroids = []
    this.oreChunks = []
    this.projectiles = []
    this.specialPickups = []
    this.rivals = []
    this.particles = []
    this.laserShots = []
    this.glitches = []
    this.summaryData = { level: run.level, bailed: !!run.bailed, resumed: true }
    this.shopSelection = 0
    this.shopSlot = 0
    this.slotMenu = null
    this.shopSector = this.resumeSector()
    this.phase = "shop"
  }

  // Back to the title with nothing kept but the best score.
  resetProgress() {
    this.forgetRun()
    this.player = null
    this.paused = false
    this.phase = "title"
    this.pauseSelection = 0
  }

  // ---- control bindings ------------------------------------------------
  // Every ship control is read through here rather than by naming a key code or a
  // button index at the point of use, so rebinding one is a change to this table
  // and nothing else.

  // Is anything bound to this action currently held on the keyboard?
  holding(action) {
    const codes = this.bindings.keys[action]
    if (codes) {
      for (const code of codes) {
        if (this.pressedKeys.has(code)) {
          return true
        }
      }
    }
    return false
  }

  // The control a key code is bound to, or null. Used for the presses that act
  // once rather than being held.
  controlForKey(code) {
    for (const control of BINDABLE_CONTROLS) {
      const codes = this.bindings.keys[control.id]
      if (codes && codes.includes(code)) {
        return control
      }
    }
    return null
  }

  // What to press for a special slot, as the HUD should name it. It follows the
  // live binding, so a rebound slot is not still labelled with the button it used
  // to be on.
  slotLabel(index) {
    const control = BINDABLE_CONTROLS.find((entry) => entry.slot === index)
    if (!control) {
      return String(index + 1)
    }
    if (this.inputMode === "gamepad") {
      const button = this.bindings.buttons[control.id]
      if (button === undefined) {
        return "-"
      }
      return GAMEPAD.slotLabels[button] ?? `B${button}`
    }
    const codes = this.bindings.keys[control.id]
    return codes && codes.length ? keyLabel(codes[0]) : "-"
  }

  // How a binding reads in the menu.
  bindingLabel(device, action) {
    const bound = this.bindings[device][action]
    if (bound === undefined) {
      return "-"
    }
    return device === "keys" ? bound.map(keyLabel).join(" / ") : `BUTTON ${bound}`
  }

  rememberBindings() {
    saveBindings({ keys: { ...this.bindings.keys }, buttons: { ...this.bindings.buttons } })
  }

  resetBindings() {
    this.bindings = freshBindings()
    this.rebinding = null
    this.rememberBindings()
  }

  // Wait for the next key or button and give it to this control.
  beginRebind(device, action) {
    this.rebinding = { device, action }
  }
  cancelRebind() {
    this.rebinding = null
  }

  // Take the key or button a waiting row was after. Returns whether the input was
  // consumed, so the caller knows not to act on it as a control or a menu press as
  // well. A row that refuses an input keeps waiting rather than binding nothing.
  captureBinding(device, input) {
    const pending = this.rebinding
    if (!pending) {
      return false
    }
    // ESCAPE abandons a wait on either device, since a keyboard is always to hand
    // and a pad has no obvious cancel of its own beyond BACK.
    if (device === "keys" && input === "Escape") {
      this.rebinding = null
      return true
    }
    if (pending.device !== device) {
      return false
    }
    const reserved = device === "keys" ? RESERVED_KEYS : RESERVED_BUTTONS
    if (reserved.has(input)) {
      return true
    }
    const table = this.bindings[device]
    // One key or button drives one control. Binding it here takes it off whatever
    // held it before, since otherwise a single press would work two controls at
    // once and the player would have no way to see why.
    for (const id of Object.keys(table)) {
      if (id === pending.action) {
        continue
      }
      if (device === "keys") {
        const kept = table[id].filter((code) => code !== input)
        if (kept.length !== table[id].length) {
          table[id] = kept
        }
      } else if (table[id] === input) {
        delete table[id]
      }
    }
    table[pending.action] = device === "keys" ? [input] : input
    this.rebinding = null
    this.rememberBindings()
    return true
  }

  // ---- input intents ---------------------------------------------------
  // What a device asks the game to do, rather than which control was used, so a
  // keyboard and a gamepad drive exactly the same code. Each is safe to call in
  // any phase; the guards live here and not at the call site.

  // The pause rows that belong here. A row can rule itself out, so the menu does not
  // offer anything that would do nothing when pressed.
  pauseMenu() {
    if (this.pausePage === "controls") {
      return this.controlRows()
    }
    if (this.pausePage === "dev") {
      return this.devRows()
    }
    return PAUSE_MENU.filter((row) => !row.available || row.available(this))
  }

  // The dev page. An entry with `rows` stands for a group generated from a registry, so
  // the list grows with the game rather than having to be kept level with it.
  devRows() {
    const rows = []
    for (const entry of DEV_MENU) {
      if (entry.rows) {
        rows.push(...entry.rows(this))
      } else if (!entry.available || entry.available(this)) {
        rows.push(entry)
      }
    }
    return rows
  }

  // Every hull the spawner could send in, which is what the dev page offers one row each
  // of. The player's own type is not among them: it is never spawned.
  spawnableTypes() {
    return SHIP_TYPES
  }

  // Walk the choice of what a spawned hull carries.
  stepDevArms(step) {
    const count = DEV_ARMS.length
    this.devArms = (this.devArms + (step > 0 ? 1 : count - 1)) % count
  }

  // What a dev-spawned hull turns up with: nothing beyond its design, what the spawner
  // would roll for it here, or every arm it could ever carry.
  devLoadout(type) {
    const arms = Object.values(type.arms || {})
    if (DEV_ARMS[this.devArms] === "all") {
      return [...(type.loadout || []), ...arms]
    }
    if (DEV_ARMS[this.devArms] === "rolled") {
      return this.rollLoadout(type)
    }
    return type.loadout || []
  }

  // Put one in the sector, in front of the ship rather than out beyond the boundary: the
  // point of asking for it is to look at it.
  //
  // And clear of whatever is already there. Asking for six of something used to stack all
  // six on the same spot, where the contact solver would spend the next second shoving them
  // apart and they would scatter as a shower. The place in front is tried first, then a ring
  // of places around it, each one further out.
  devSpawn(name) {
    if (!this.player) {
      return
    }
    const type = SHIP_TYPES[name]
    const ahead = this.player.angle
    const at = this.#clearSpawnSpot(this.player, ahead, 260 + type.boundRadius, type.boundRadius)
    const ship = new RivalShip(at.x, at.y, name, this.devLoadout(type))
    ship.angle = ahead + Math.PI
    ship.arrived = true // it is already here; nothing to fly in from
    this.rivals.push(ship)
    Sound.power()
  }

  // Somewhere a hull of `reach` fits without touching anything already in the sector, or the
  // first place tried if the sector is too full to be fussy about it.
  #clearSpawnSpot(from, bearing, away, reach) {
    const first = { x: from.x + Math.cos(bearing) * away, y: from.y + Math.sin(bearing) * away }
    for (let ring = 0; ring < 5; ring++) {
      const spread = away + ring * (reach * 2 + 40)
      const places = ring === 0 ? 1 : 6
      for (let i = 0; i < places; i++) {
        const angle = bearing + (i / places) * TAU
        const at = { x: from.x + Math.cos(angle) * spread, y: from.y + Math.sin(angle) * spread }
        const fromCentre = Math.hypot(at.x - ARENA.cx, at.y - ARENA.cy)
        if (!this.#crowdedAt(at, reach) && fromCentre + reach < ARENA.radius) {
          return at
        }
      }
    }
    return first
  }

  // Is anything already close enough to be touching a hull of `reach` put here?
  #crowdedAt(at, reach) {
    for (const other of this.rivals) {
      if (Math.hypot(other.x - at.x, other.y - at.y) < reach + other.boundRadius + 30) {
        return true
      }
    }
    for (const rock of this.asteroids) {
      if (Math.hypot(rock.center.x - at.x, rock.center.y - at.y) < reach + rock.boundRadius + 20) {
        return true
      }
    }
    return false
  }

  // End the sector the way clearing it would, which is what the dev button used to do on
  // its own.
  clearSectorNow() {
    this.paused = false
    this.enterShop()
  }

  // Own one of everything, at no cost: every option in every slot and every special the
  // shop will sell, so anything can be tried without a run to pay for it.
  devOwnEverything() {
    for (const [slot, spec] of Object.entries(EQUIPMENT)) {
      this.upgrades.owned[slot] = spec.options.map((option) => option.id)
    }
    for (const id of SPECIAL_IDS) {
      this.findSpecial(id)
    }
    this.oreBalance += 5000
    this.rememberRun()
    Sound.power()
  }

  // And fit the best of it: the top of every ladder, the last core, a full set of
  // specials and a spare ship or two.
  devMaxOut() {
    this.devOwnEverything()
    for (const [slot, spec] of Object.entries(EQUIPMENT)) {
      // The top of a ladder is the best of it. A slot that is a choice rather than a climb
      // has no best, so it takes the one the yard fits: the alternatives are trades, and
      // picking the last of them by position would just mean the slowest drive.
      const wanted = spec.ladder ? spec.options[spec.options.length - 1] : spec.options[0]
      this.fitEquipment(slot, wanted.id)
    }
    for (const row of SHOP) {
      if (row.levels) {
        this.upgrades[row.id] = row.levels.length - 1
        if (row.levelApply) {
          row.levelApply(this)
        }
      }
    }
    this.lives = CONFIG.MAX_LIVES
    if (this.player) {
      this.player.hull = PLAYER_TYPE.hull
      this.player.hullShown = PLAYER_TYPE.hull
      // A slot each for the specials that are worth having in front of you.
      const wanted = SPECIAL_IDS.filter((id) => SPECIAL_TYPES[id].buyable)
      for (let slot = 0; slot < this.specialSlots(); slot++) {
        this.player.equip(slot, wanted[slot % wanted.length])
      }
    }
    this.rememberRun()
  }

  // An arena with nothing in it and no way to win: the sector never counts as cleared, so
  // whatever is spawned here can be watched for as long as it is wanted.
  enterSandbox() {
    this.sandbox = true
    this.devMode = true
    this.paused = false
    this.pausePage = "root"
    this.startLevel(Math.max(1, this.level))
    this.asteroids = []
    this.rivals = []
    this.projectiles = []
    Sound.power()
  }

  // Move between pages of the pause menu, landing the cursor at the top.
  openPausePage(page) {
    this.pausePage = page
    this.pauseSelection = 0
    this.pauseConfirming = null
    this.rebinding = null
  }

  // One row per bindable control per device, each carrying its device as a section
  // so the view can head the groups without the cursor having to land on a heading.
  // A control with no default for a device is not offered there.
  controlRows() {
    const rows = []
    for (const device of BINDING_DEVICES) {
      for (const control of BINDABLE_CONTROLS) {
        if (control.defaults[device.id] === undefined) {
          continue
        }
        rows.push({
          section: device.name,
          name: control.name,
          waiting: () =>
            this.rebinding &&
            this.rebinding.device === device.id &&
            this.rebinding.action === control.id
              ? device.prompt
              : null,
          value: (g) => g.bindingLabel(device.id, control.id),
          action: (g) => g.beginRebind(device.id, control.id),
        })
      }
    }
    // These two share the line below the columns, BACK under the left one and RESET
    // under the right, so left and right move between them as they do above.
    rows.push({ name: "BACK", action: (g) => g.openPausePage("root") })
    rows.push({
      name: "RESET TO DEFAULTS",
      confirm: "RESTORE EVERY CONTROL?",
      action: (g) => g.resetBindings(),
    })
    return rows
  }

  // Which list the cursor is in. The pause menu sits over a live sector, so it wins
  // wherever both could apply.
  menuRows() {
    if (this.paused) {
      return this.pauseMenu().length
    }
    // the purchases, the SPECIALS row among them, then LAUNCH and SETTINGS
    return this.phase === "shop" ? SHOP.length + 3 : 0
  }

  // Move the cursor, wrapping at both ends. A row waiting for a key or button holds
  // it still, so the input that lands is the binding and not a cursor move.
  menuMove(delta) {
    const rows = this.menuRows()
    if (this.slotMenu) {
      this.#slotMenuMove(delta)
      return
    }
    if (!rows || this.rebinding) {
      return
    }
    if (this.paused) {
      this.pauseConfirming = null // moving away abandons a pending confirmation
      this.pauseSelection = (this.pauseSelection + delta + rows) % rows
    } else {
      this.shopSelection = (this.shopSelection + delta + rows) % rows
    }
  }

  // Act on the highlighted row: buy, launch, start a run, or work the pause menu.
  // A row carrying `confirm` asks once and acts on the second press.
  menuConfirm() {
    if (this.slotMenu) {
      this.#slotMenuConfirm()
      return
    }
    if (this.paused) {
      const row = this.pauseMenu()[this.pauseSelection]
      if (!row || !row.action) {
        return
      }
      if (row.confirm && this.pauseConfirming !== row.name) {
        this.pauseConfirming = row.name
        return
      }
      this.pauseConfirming = null
      row.action(this)
      // No sound for working a menu row. The only tones in here are the ones that
      // are themselves the answer: how loud the game is, and whether it is audible
      // at all. Anything else and BACK would blip at you.
      return
    }
    if (this.phase === "shop") {
      this.doShopAction()
    } else if (this.phase === "title" || this.phase === "over") {
      // Enter carries on from where a previous session stopped, if it left anything.
      if (this.phase === "title" && this.savedRun) {
        this.resumeRun()
      } else {
        this.startNewGame()
      }
    }
  }

  // LEFT / RIGHT. In the pause menu it works the highlighted row's scale; in the dev
  // shop it steps the sector. Returns whether it did anything, so a caller can stop.
  menuAdjust(step) {
    if (this.slotMenu) {
      // On a special slot, sideways walks to the next box and the pop-over follows,
      // so the four can be worked through without closing and reopening it. A menu
      // opened from a shop row has nothing beside it, and the shop behind it must not
      // move either way.
      if (!this.slotMenu.equipment && !this.slotMenu.levels) {
        this.#slotMenuAcross(step)
      }
      return true
    }
    if (this.paused) {
      if (this.rebinding) {
        return true // a waiting row swallows it, as it does a cursor move
      }
      const rows = this.pauseMenu()
      const row = rows[this.pauseSelection]
      if (row && row.adjust) {
        this.pauseConfirming = null
        row.adjust(this, step)
        return true
      }
      // A page laid out in columns crosses between them instead, since a binding
      // row has no scale to work.
      if (row && row.section) {
        return this.#stepColumn(rows, step)
      }
      // The loose rows sit two to a line only beneath such columns. A page that
      // is one column all the way down has no line to move along, so a sideways
      // press on a row with no scale does nothing at all - it must not walk the
      // cursor down the page, least of all onto a row that throws a run away.
      return rows.some((entry) => entry.section) ? this.#stepPair(rows, step) : false
    }
    if (this.#slotStep(step)) {
      return true
    }
    if (this.devSectorStep(step)) {
      return true
    }
    return this.#shopSideStep(step)
  }

  // The special slots sit side by side on one row, so left and right walk along
  // them. It stops at each end: the row is a row of boxes, not a loop.
  #slotStep(step) {
    if (this.phase !== "shop" || this.shopSelection !== this.slotsRow) {
      return false
    }
    // Every box is reachable, fitted or not: an empty one is where the next slot
    // is bought, so the cursor has to be able to land on it.
    this.shopSlot = clamp(this.shopSlot + Math.sign(step), 0, MAX_SLOTS - 1)
    return true
  }

  // LAUNCH and SETTINGS share the shop's bottom line, SETTINGS to the left, so left
  // and right move between them. Up and down reach them too, in index order.
  #shopSideStep(step) {
    if (this.phase !== "shop") {
      return false
    }
    if (step < 0 && this.shopSelection === this.launchRow) {
      this.shopSelection = this.optionsRow
      return true
    }
    if (step > 0 && this.shopSelection === this.optionsRow) {
      this.shopSelection = this.launchRow
      return true
    }
    return false
  }

  // The rows below the columns sit two to a line, so left and right move along it.
  #stepPair(rows, step) {
    const loose = rows.map((row, index) => ({ row, index })).filter(({ row }) => !row.section)
    const at = loose.findIndex(({ index }) => index === this.pauseSelection)
    if (at < 0) {
      return false
    }
    const next = loose[at + (step > 0 ? 1 : -1)]
    if (!next) {
      return false
    }
    this.pauseSelection = next.index
    this.pauseConfirming = null
    return true
  }

  // Move to the same place in the neighbouring column: the nth row here becomes the
  // nth row there. The columns are different lengths, so a shorter one lands on its
  // last row.
  #stepColumn(rows, step) {
    const sections = [...new Set(rows.map((row) => row.section).filter(Boolean))]
    const from = rows[this.pauseSelection]
    const target = sections[sections.indexOf(from.section) + (step > 0 ? 1 : -1)]
    if (target === undefined) {
      return false
    }
    const within = rows.filter((row) => row.section === from.section).indexOf(from)
    const landing = rows.filter((row) => row.section === target)
    this.pauseSelection = rows.indexOf(landing[Math.min(within, landing.length - 1)])
    this.pauseConfirming = null
    return true
  }

  // Dev-only sector jump from the shop. Returns whether it handled the input, so
  // a caller can stop rather than also moving the cursor.
  // Dev mode walks the sector to launch to. Only from the row that shows it: a
  // sideways press anywhere else in the shop was quietly moving it, so the number
  // on the launch line changed while the cursor was somewhere else entirely.
  //
  // A press that would not move it is declined rather than swallowed, which is
  // what leaves LAUNCH's own left press free to reach OPTIONS beside it once the
  // sector is already at the floor.
  devSectorStep(step) {
    if (this.phase !== "shop" || !this.devMode || this.shopSelection !== this.launchRow) {
      return false
    }
    const next = Math.max(1, this.shopSector + step)
    if (next === this.shopSector) {
      return false
    }
    this.shopSector = next
    return true
  }

  // Where the options menu can be opened: over a live sector, where it also freezes
  // it, and over the shop, where there is nothing to freeze but the same options
  // should still be reachable. `settings` on this object is the stored values the
  // menu edits; OPTIONS is the menu itself.
  canOpenOptions() {
    return this.inSector() || this.phase === "shop"
  }

  // Back out one step: off the shop's slot pop-over, off a sub page of the options
  // menu, then out of the menu itself. ESCAPE on a keyboard and B on a pad, so the
  // two cannot drift apart.
  menuBack() {
    if (this.slotMenu) {
      this.closeSlotMenu()
      return
    }
    if (!this.paused) {
      return
    }
    if (this.pausePage === "root") {
      this.toggleOptions()
    } else {
      this.openPausePage("root")
    }
  }

  // ESCAPE, which opens the menu when it is closed and backs out of it when it is
  // not, so one key does the whole journey in and out.
  escape() {
    if (this.paused || this.slotMenu) {
      this.menuBack()
    } else {
      this.toggleOptions()
    }
  }

  // START on a pad. Pausing is something done during play, so it opens the options
  // menu in a sector and confirms everywhere else: it starts a run from the title
  // and launches from the shop, both of which it has always done and the prompts
  // still say it does. The options menu is reachable over the shop by BACK, by
  // ESCAPE, and by its own row on the launch line.
  padStart() {
    if (this.inSector()) {
      this.toggleOptions()
    } else {
      this.menuConfirm()
    }
  }

  toggleOptions() {
    if (!this.canOpenOptions()) {
      return
    }
    this.paused = !this.paused
    this.slotMenu = null
    // A testing arena opens on the dev page, since that is the only reason to be in one and
    // the options are a row of it. Anywhere else, the options are what pausing is for.
    this.pausePage = this.sandbox ? "dev" : "root"
    this.pauseSelection = 0
    this.pauseConfirming = null
    this.rebinding = null
    if (this.paused) {
      Sound.setThruster(false)
    }
  }

  // A slot button going down. Nothing happens yet: a tap uses the slot when it
  // comes back up, and a hold throws the special overboard before then.
  slotDownAt(index) {
    if (index < 0 || index >= MAX_SLOTS) {
      return
    }
    this.slotDown[index] = true
    this.slotHeld[index] = 0
    this.slotSpent[index] = false
  }

  // ...and coming back up, which uses the slot unless the hold already spent it.
  slotUpAt(index) {
    if (index < 0 || index >= MAX_SLOTS) {
      return
    }
    this.slotDown[index] = false
    const spent = this.slotSpent[index]
    this.slotHeld[index] = 0
    this.slotSpent[index] = false
    if (!spent && this.canFly() && !this.paused) {
      this.useSpecialSlot(index)
    }
  }

  #tickSlotHolds(dt) {
    for (let index = 0; index < MAX_SLOTS; index++) {
      if (!this.slotDown[index] || this.slotSpent[index]) {
        continue
      }
      this.slotHeld[index] += dt
      if (this.slotHeld[index] >= CONFIG.SPECIAL_JETTISON_HOLD) {
        this.slotSpent[index] = true
        this.jettisonSlot(index)
      }
    }
  }

  // Let a held charge go. Firing is on release, so this is what actually shoots.
  releaseFire() {
    if (!this.player) {
      return
    }
    if (this.canFly() && !this.paused) {
      this.player.fireLaser(this)
    }
    this.player.mainWeapon.release()
  }

  // ---- keyboard --------------------------------------------------------
  onKeyDown(e) {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) {
      e.preventDefault()
    }
    this.inputMode = "keyboard"

    // A row waiting for a key takes the next one and nothing else sees it, or the
    // key would be bound and act on the menu in the same press.
    if (this.rebinding && this.captureBinding("keys", e.code)) {
      return
    }

    const left = e.code === "ArrowLeft" || e.code === "KeyA"
    const right = e.code === "ArrowRight" || e.code === "KeyD"
    if (left || right) {
      const step = this.pressedKeys.has("ShiftLeft") || this.pressedKeys.has("ShiftRight") ? 10 : 1
      if (this.menuAdjust(right ? step : -step)) {
        this.pressedKeys.add(e.code)
        return
      }
    }
    if (e.repeat) {
      this.pressedKeys.add(e.code)
      return
    }

    if (e.code === "ArrowUp" || e.code === "KeyW") {
      this.menuMove(-1)
    } else if (e.code === "ArrowDown" || e.code === "KeyS") {
      this.menuMove(1)
    } else if (e.code === "Enter") {
      this.menuConfirm()
    } else if (e.code === "Escape") {
      this.escape()
    }
    if (e.code === "KeyP") {
      this.toggleOptions()
    }
    const control = this.controlForKey(e.code)
    if (control && control.slot !== undefined) {
      this.slotDownAt(control.slot)
    }
    this.pressedKeys.add(e.code)
  }

  onKeyUp(e) {
    this.pressedKeys.delete(e.code)
    // Firing is on release: the key is held to charge and the shot goes when it
    // comes back up.
    const control = this.controlForKey(e.code)
    if (control && control.id === "fire") {
      this.releaseFire()
    }
    if (control && control.slot !== undefined) {
      this.slotUpAt(control.slot)
    }
  }

  onBlur() {
    this.clearInput()
  }

  // Drop held keys and any accumulated laser charge. Used on focus loss and at
  // the start of a level so input never carries across a phase transition.
  clearInput() {
    this.pressedKeys.clear()
    this.slotDown.fill(false)
    this.slotHeld.fill(0)
    this.slotSpent.fill(false)
    this.padInput = this.blankPadInput()
    Sound.setThruster(false)
    if (this.player) {
      this.player.mainWeapon.charge = 0
    }
  }

  // What the DEV button asks for: the dev page, over whatever is happening. It used to
  // end the sector and open the shop, which is one of the things the page now offers
  // rather than the only thing the button could do.
  openDevMenu() {
    if (!this.player || this.phase === "title" || this.phase === "over") {
      this.startNewGame()
    }
    this.devMode = true
    this.paused = true
    this.openPausePage("dev")
  }

  // Advance the simulation one step. Rendering is the view's job; main.js
  // paints via GameView after this returns.
  advance(dt) {
    this.gameTime += dt
    // A screen effect settles wherever it was started. Losing the last life throws
    // the shake and ends the sector in the same breath, and decaying it only while
    // a sector is running left the game-over screen shaking for good.
    if (this.screenShake > 0) {
      this.screenShake = Math.max(0, this.screenShake - dt * 22)
    }
    // the backdrop only parallaxes against a ship that is actually flying
    const flying = this.player && this.canFly()
    this.backdrop.update(dt, flying ? this.player.vx : 0, flying ? this.player.vy : 0)
    if (this.phase === "title") {
      this.backdrop.updateMenu(dt)
    } else if (this.inSector() && !this.paused) {
      this.update(dt)
    }
  }
}
