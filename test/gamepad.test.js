// Gamepad mapping tests. readPad is pure and GamepadInput.apply takes a sample
// directly, so the whole mapping is testable without a browser or a device.
//
// Buttons are addressed through GAMEPAD rather than by number, so remapping a
// control in config.js does not break these.

import test from "node:test"
import assert from "node:assert/strict"

import { Game } from "../src/game.js"
import { Asteroid } from "../src/entities.js"
import { GamepadInput, applyDeadzone, padInUse, readPad } from "../src/gamepad.js"
import { ARENA, CONFIG, GAMEPAD, SHOP, freshBindings } from "../src/config.js"

// A pad with everything at rest. `set` takes { buttons: {index: value}, axes: {index: value} }.
function pad({ buttons = {}, axes = {} } = {}) {
  const buttonList = Array.from({ length: 17 }, (_, i) => ({
    pressed: (buttons[i] ?? 0) >= 0.5,
    value: buttons[i] ?? 0,
  }))
  const axisList = Array.from({ length: 4 }, (_, i) => axes[i] ?? 0)
  return { buttons: buttonList, axes: axisList, connected: true }
}

const B = GAMEPAD.buttons // the fixed menu buttons
const D = freshBindings().buttons // and the default binding of each ship control
const A = GAMEPAD.axes

// A live sector with a solid ship. One rock is left in the field, well clear of
// the ship: an empty sector counts as cleared and runs on to the shop within two
// frames, which takes the phase out of canFly() and stops the ship answering.
function liveGame() {
  const game = new Game()
  game.startNewGame()
  game.phase = "play"
  game.asteroids = [
    new Asteroid({ x: ARENA.cx + 700, y: ARENA.cy, radius: 40, vx: 0, vy: 0, spin: 0 }),
  ]
  game.rivals = []
  const player = game.player
  player.warp = 1
  player.warpTarget = 1
  player.warpHold = 0
  player.invincible = 0
  return game
}

// ---- deadzone -------------------------------------------------------------

test("applyDeadzone ignores travel inside the zone", () => {
  assert.equal(applyDeadzone(0, 0.2), 0)
  assert.equal(applyDeadzone(0.19, 0.2), 0)
  assert.equal(applyDeadzone(-0.19, 0.2), 0)
})

test("applyDeadzone rescales travel beyond the zone to a full range", () => {
  assert.ok(applyDeadzone(0.2001, 0.2) > 0, "just past the zone still moves")
  assert.ok(applyDeadzone(0.2001, 0.2) < 0.01, "and moves only a little")
  assert.equal(applyDeadzone(1, 0.2), 1)
  assert.equal(applyDeadzone(-1, 0.2), -1)
})

// ---- reading a pad --------------------------------------------------------

test("a pad at rest asks for nothing", () => {
  const state = readPad(pad())
  assert.equal(state.turn, 0)
  assert.equal(state.thrust, false)
  assert.equal(state.fire, false)
  assert.equal(state.turretAim, null)
  assert.equal(padInUse(state), false, "a resting pad must not claim the prompts")
})

test("the left stick gives a proportional turn", () => {
  assert.ok(readPad(pad({ axes: { [A.turn]: 1 } })).turn > 0.9, "full right")
  assert.ok(readPad(pad({ axes: { [A.turn]: -1 } })).turn < -0.9, "full left")
  const half = readPad(pad({ axes: { [A.turn]: 0.6 } })).turn
  assert.ok(half > 0 && half < 0.9, `partial deflection gives a partial turn, got ${half}`)
})

test("a trigger has to travel before it counts as held", () => {
  const barely = GAMEPAD.triggerThreshold / 2
  assert.equal(readPad(pad({ buttons: { [D.fire]: barely } })).fire, false)
  assert.equal(readPad(pad({ buttons: { [D.fire]: 1 } })).fire, true)
  assert.equal(readPad(pad({ buttons: { [D.thrust]: 1 } })).thrust, true)
  assert.equal(readPad(pad({ buttons: { [D.reverse]: 1 } })).reverse, true)
})

test("the right stick gives the turret an absolute bearing", () => {
  // pushed right, and pushed down: the bearing follows the stick, not a rate
  assert.equal(readPad(pad({ axes: { [A.turretX]: 1 } })).turretAim, 0)
  const down = readPad(pad({ axes: { [A.turretY]: 1 } })).turretAim
  assert.ok(Math.abs(down - Math.PI / 2) < 1e-9, `expected +PI/2, got ${down}`)
  const nudge = GAMEPAD.turretDeadzone / 2
  assert.equal(
    readPad(pad({ axes: { [A.turretX]: nudge } })).turretAim,
    null,
    "a brushed stick must not swing the guns",
  )
})

test("the dpad and the left stick both move a menu", () => {
  assert.equal(readPad(pad({ buttons: { [B.dpadUp]: 1 } })).menuUp, true)
  assert.equal(readPad(pad({ buttons: { [B.dpadDown]: 1 } })).menuDown, true)
  assert.equal(readPad(pad({ axes: { [A.menu]: -1 } })).menuUp, true)
  assert.equal(readPad(pad({ axes: { [A.menu]: 1 } })).menuDown, true)
  assert.equal(readPad(pad({ axes: { [A.menu]: 0 } })).menuUp, false)
})

test("a bare numeric button list is read too", () => {
  // some mappings expose buttons as plain numbers rather than objects
  const numeric = { buttons: [], axes: [0, 0, 0, 0], connected: true }
  numeric.buttons.length = 17
  numeric.buttons.fill(0)
  numeric.buttons[D.thrust] = 1
  assert.equal(readPad(numeric).thrust, true)
})

// ---- driving the game -----------------------------------------------------

test("the pad flies the ship", () => {
  const game = liveGame()
  const input = new GamepadInput(game)
  const player = game.player
  const facing = player.angle
  input.apply(readPad(pad({ axes: { [A.turn]: 1 }, buttons: { [D.thrust]: 1 } })))
  game.advance(1 / 60)
  assert.ok(player.angle > facing, "the stick turned the ship")
  assert.equal(player.thrusting, true, "the trigger drove the engine")
})

test("a half-deflected stick turns more slowly than a full one", () => {
  const turnOver = (deflection) => {
    const game = liveGame()
    const input = new GamepadInput(game)
    const before = game.player.angle
    for (let i = 0; i < 10; i++) {
      input.apply(readPad(pad({ axes: { [A.turn]: deflection } })))
      game.advance(1 / 60)
    }
    return game.player.angle - before
  }
  const full = turnOver(1)
  const half = turnOver(0.6)
  assert.ok(half > 0 && half < full * 0.9, `half ${half.toFixed(3)} vs full ${full.toFixed(3)}`)
})

test("the keyboard still turns at the full rate", () => {
  const game = liveGame()
  const before = game.player.angle
  game.pressedKeys.add("KeyD")
  game.advance(1 / 60)
  assert.ok(Math.abs(game.player.angle - before - CONFIG.ROT / 60) < 1e-9)
})

test("holding the trigger charges and releasing it fires", () => {
  const game = liveGame()
  const input = new GamepadInput(game)
  const weapon = game.player.mainWeapon
  const held = readPad(pad({ buttons: { [D.fire]: 1 } }))
  for (let i = 0; i < 30; i++) {
    input.apply(held)
    game.advance(1 / 60)
  }
  assert.ok(weapon.charge > weapon.type.chargeMin, "the trigger charged the laser")
  assert.equal(game.stats.shots, 0, "and did not fire while held")
  input.apply(readPad(pad()))
  assert.equal(game.stats.shots, 1, "releasing it fired once")
  assert.equal(weapon.charge, 0)
})

test("the right stick aims the turret and the bumper fires it", () => {
  const game = liveGame()
  game.upgrades.turret = true
  game.player.fit("turret")
  const input = new GamepadInput(game)
  input.apply(
    readPad(pad({ axes: { [A.turretX]: 0, [A.turretY]: -1 }, buttons: { [D.turretFire]: 1 } })),
  )
  game.advance(1 / 60)
  assert.ok(
    Math.abs(game.player.turretAim + Math.PI / 2) < 1e-9,
    `turret should point at -PI/2, got ${game.player.turretAim}`,
  )
  assert.ok(game.player.turretManual > 0, "aiming takes manual control")
})

test("a face button uses its powerup slot once per press", () => {
  const game = liveGame()
  const player = game.player
  player.items = ["refuel"]
  player.energy = 10
  const input = new GamepadInput(game)
  const held = readPad(pad({ buttons: { [D.slot1]: 1 } }))
  input.apply(held)
  assert.equal(player.items.length, 0, "the slot was used")
  assert.ok(player.energy > 10, "and the powerup applied")
  player.items = ["refuel"]
  input.apply(held) // still held: must not fire again
  assert.equal(player.items.length, 1, "a held button must not repeat")
})

test("each face button maps to its own slot", () => {
  const game = liveGame()
  game.upgrades.slots = 4
  const player = game.player
  player.items = ["refuel", "refuel", "refuel", "refuel"]
  const input = new GamepadInput(game)
  input.apply(readPad(pad({ buttons: { [D.slot3]: 1 } })))
  assert.equal(player.items.length, 3, "the third button used a slot")
})

// ---- menus ----------------------------------------------------------------

test("start begins a run from the title screen", () => {
  const game = new Game()
  assert.equal(game.phase, "title")
  const input = new GamepadInput(game)
  input.apply(readPad(pad({ buttons: { [B.confirm]: 1 } })))
  assert.equal(game.phase, "arriving", "start launched a sector")
})

test("A confirms as well as start, in every menu", () => {
  const fromTitle = (buttonIndex) => {
    const game = new Game()
    new GamepadInput(game).apply(readPad(pad({ buttons: { [buttonIndex]: 1 } })))
    return game.phase
  }
  assert.equal(fromTitle(B.confirm), "arriving", "start begins a run")
  assert.equal(fromTitle(B.confirmAlt), "arriving", "and so does A")

  // In the shop A acts on the highlighted row, exactly as start does: it buys
  // where the cursor is, and launches on the launch row.
  const buying = liveGame()
  buying.enterShop()
  buying.oreBalance = 500
  const coreLevel = buying.upgrades.core
  new GamepadInput(buying).apply(readPad(pad({ buttons: { [B.confirmAlt]: 1 } })))
  assert.equal(buying.upgrades.core, coreLevel + 1, "A bought the highlighted upgrade")

  const launching = liveGame()
  launching.enterShop()
  launching.shopSelection = SHOP.length
  new GamepadInput(launching).apply(readPad(pad({ buttons: { [B.confirmAlt]: 1 } })))
  assert.equal(launching.phase, "arriving", "A launched from the launch row")
})

test("A fills a slot in flight and confirms in a menu, never both", () => {
  // A is also powerup slot 1, which is only reachable in a flying phase, so the
  // two uses cannot collide.
  const inFlight = liveGame()
  inFlight.player.items = ["refuel"]
  inFlight.player.energy = 10
  new GamepadInput(inFlight).apply(readPad(pad({ buttons: { [B.confirmAlt]: 1 } })))
  assert.equal(inFlight.player.items.length, 0, "in flight A used the slot")
  assert.equal(inFlight.phase, "play", "and did not confirm anything")

  const inShop = liveGame()
  inShop.player.items = ["refuel"]
  inShop.enterShop()
  new GamepadInput(inShop).apply(readPad(pad({ buttons: { [B.confirmAlt]: 1 } })))
  assert.equal(inShop.player.items.length, 1, "in a menu A left the slot alone")
})

test("the dpad walks the shop and start confirms", () => {
  const game = liveGame()
  game.enterShop()
  const input = new GamepadInput(game)
  assert.equal(game.shopSelection, 0)
  input.apply(readPad(pad({ buttons: { [B.dpadDown]: 1 } })))
  assert.equal(game.shopSelection, 1, "one press moves one row")
  input.apply(readPad(pad({ buttons: { [B.dpadDown]: 1 } })))
  assert.equal(game.shopSelection, 1, "holding it does not run away")
  input.apply(readPad(pad()))
  input.apply(readPad(pad({ buttons: { [B.dpadUp]: 1 } })))
  assert.equal(game.shopSelection, 0)
  // wrap backwards off the top onto the launch row
  input.apply(readPad(pad()))
  input.apply(readPad(pad({ buttons: { [B.dpadUp]: 1 } })))
  assert.equal(game.shopSelection, SHOP.length, "selection wraps to the launch row")
  input.apply(readPad(pad({ buttons: { [B.confirm]: 1 } })))
  assert.equal(game.phase, "arriving", "start launched from the shop")
})

test("the dpad steps the dev sector, and only in the dev shop", () => {
  const game = liveGame()
  game.enterShop()
  const input = new GamepadInput(game)
  const sector = game.shopSector
  input.apply(readPad(pad({ buttons: { [B.dpadRight]: 1 } })))
  assert.equal(game.shopSector, sector, "not offered outside dev mode")
  game.devMode = true
  input.apply(readPad(pad()))
  input.apply(readPad(pad({ buttons: { [B.dpadRight]: 1 } })))
  assert.equal(game.shopSector, sector + 1)
})

test("back pauses and unpauses in a sector", () => {
  const game = liveGame()
  const input = new GamepadInput(game)
  input.apply(readPad(pad({ buttons: { [B.pause]: 1 } })))
  assert.equal(game.paused, true)
  input.apply(readPad(pad()))
  input.apply(readPad(pad({ buttons: { [B.pause]: 1 } })))
  assert.equal(game.paused, false)
})

// ---- which device is in charge --------------------------------------------

test("touching the pad switches the prompts, and a key switches them back", () => {
  const game = liveGame()
  const input = new GamepadInput(game)
  assert.equal(game.inputMode, "keyboard")
  input.apply(readPad(pad({ buttons: { [D.thrust]: 1 } })))
  assert.equal(game.inputMode, "gamepad")
  game.onKeyDown({ code: "KeyW", repeat: false, preventDefault() {} })
  assert.equal(game.inputMode, "keyboard")
})

test("a resting pad leaves the prompts alone", () => {
  const game = liveGame()
  const input = new GamepadInput(game)
  for (let i = 0; i < 10; i++) {
    input.apply(readPad(pad()))
  }
  assert.equal(game.inputMode, "keyboard", "a plugged-in idle pad must not claim the HUD")
})

test("the pad does not disturb keys the keyboard is holding", () => {
  const game = liveGame()
  const input = new GamepadInput(game)
  game.pressedKeys.add("KeyW") // keyboard player holding thrust
  input.apply(readPad(pad({ buttons: { [D.thrust]: 1 } })))
  input.apply(readPad(pad())) // pad trigger released
  assert.ok(game.pressedKeys.has("KeyW"), "the held key survived the pad's release")
  game.advance(1 / 60)
  assert.equal(game.player.thrusting, true)
})

test("clearing input drops pad state too", () => {
  const game = liveGame()
  const input = new GamepadInput(game)
  input.apply(readPad(pad({ buttons: { [D.thrust]: 1 }, axes: { [A.turn]: 1 } })))
  game.clearInput()
  assert.equal(game.padInput.thrust, false)
  assert.equal(game.padInput.turn, 0)
})

test("B backs out of a menu on a pad, as escape does on a keyboard", () => {
  const game = liveGame()
  const input = new GamepadInput(game)
  const press = (fields) => {
    input.apply(readPad(pad(fields)))
    input.apply(readPad(pad({}))) // and release, so the next press is an edge
  }
  game.togglePause()
  game.openPausePage("controls")
  press({ buttons: { [B.back]: 1 } })
  assert.equal(game.pausePage, "root", "off the sub page first")
  assert.equal(game.paused, true, "without closing the menu")
  press({ buttons: { [B.back]: 1 } })
  assert.equal(game.paused, false, "a second press closes it")
})

test("B abandons a rebind rather than being bound to the control", () => {
  const game = liveGame()
  const input = new GamepadInput(game)
  game.togglePause()
  game.openPausePage("controls")
  game.beginRebind("buttons", "thrust")
  input.apply(readPad(pad({ buttons: { [B.back]: 1 } })))
  assert.equal(game.rebinding, null, "the wait is abandoned")
  assert.equal(game.bindings.buttons.thrust, 6, "and B was not captured")
  assert.equal(game.pausePage, "controls", "without leaving the page")
})

test("B still works its powerup slot in flight", () => {
  // B is slot 2 by default and back in a menu. The two never collide, because a
  // slot only works in a flying phase and a menu only exists outside one.
  const game = liveGame()
  const input = new GamepadInput(game)
  game.upgrades.slots = 2
  game.player.items = ["refuel", "repel"]
  assert.equal(game.paused, false)
  input.apply(readPad(pad({ buttons: { [B.back]: 1 } })))
  assert.deepEqual(game.player.items, ["refuel"], "the second slot was used")
})

test("the HUD names a powerup slot by what is actually bound to it", () => {
  const game = liveGame()
  game.inputMode = "gamepad"
  assert.equal(game.slotLabel(0), "A", "the default is the face button it sits on")
  game.bindings.buttons.slot1 = 3
  assert.equal(game.slotLabel(0), "Y", "and follows a rebind")
  game.bindings.buttons.slot1 = 11
  assert.equal(game.slotLabel(0), "B11", "a button with no face name says which it is")
  game.inputMode = "keyboard"
  assert.equal(game.slotLabel(0), "1", "a keyboard player is told the key")
  game.bindings.keys.slot1 = ["KeyZ"]
  assert.equal(game.slotLabel(0), "Z")
})
