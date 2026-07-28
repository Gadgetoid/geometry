// Gamepad mapping tests. readPad is pure and GamepadInput.apply takes a sample
// directly, so the whole mapping is testable without a browser or a device.
//
// Buttons are addressed through GAMEPAD rather than by number, so remapping a
// control in config.js does not break these.

import test from "node:test"
import assert from "node:assert/strict"

import { Game } from "../src/game.js"
import { Asteroid } from "../src/entities.js"
import { GameView } from "../src/view.js"
import { GamepadInput, applyDeadzone, padInUse, readPad } from "../src/gamepad.js"
import {
  ARENA,
  GAMEPAD,
  PAD_CLUSTERS,
  PAD_LAYOUT,
  SHOP,
  VIEW_W,
  freshBindings,
} from "../src/config.js"

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
  // Which is the fitted thrusters' rate: a key is held or it is not, so a quicker set
  // is a quicker turn and there is no half deflection to soften it.
  const game = liveGame()
  const before = game.player.angle
  game.pressedKeys.add("KeyD")
  game.advance(1 / 60)
  assert.ok(Math.abs(game.player.angle - before - game.player.turnRate / 60) < 1e-9)
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
  // The turret is equipment now, owned and fitted rather than flagged on.
  game.upgrades.owned.turret = ["defenseBlaster"]
  game.upgrades.fitted.turret = "defenseBlaster"
  game.player.fitEquipment(game)
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

test("a face button uses its special slot on release, once per press", () => {
  const game = liveGame()
  const player = game.player
  const item = player.equip(0, "repel")
  player.energy = player.energyMax
  const input = new GamepadInput(game)
  const held = readPad(pad({ buttons: { [D.slot1]: 1 } })),
    released = readPad(pad({}))
  input.apply(held)
  assert.equal(player.energy, player.energyMax, "holding it does nothing yet")
  input.apply(held) // still held: must not repeat either
  assert.equal(player.energy, player.energyMax)
  input.apply(released)
  assert.ok(player.energy < player.energyMax, "letting go used it")
  assert.equal(player.items[0], item, "and the special stays in its slot")
  const after = player.energy
  input.apply(held)
  input.apply(released)
  assert.equal(player.energy, after, "a slot on cooldown does nothing")
})

test("each face button maps to its own slot", () => {
  const game = liveGame()
  game.upgrades.slots = 4
  const player = game.player
  player.energy = player.energyMax
  for (let slot = 0; slot < 4; slot++) {
    player.equip(slot, "repel")
  }
  const input = new GamepadInput(game)
  input.apply(readPad(pad({ buttons: { [D.slot3]: 1 } })))
  input.apply(readPad(pad({})))
  assert.ok(player.items[2].cooldown > 0, "the third button used the third slot")
  assert.deepEqual(
    [0, 1, 3].map((slot) => player.items[slot].cooldown),
    [0, 0, 0],
    "and no other",
  )
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
  // Found by walking the page rather than by offsetting an index: where the specials
  // row falls among the purchases is the layout's business and has moved once already.
  buying.shopSelection = [...Array(SHOP.length + 1).keys()].find((row) => {
    const item = buying.shopItem(row)
    return item && item.id === "core"
  })
  const coreLevel = buying.upgrades.core
  const input = new GamepadInput(buying)
  // The core opens on its ladder, at the step there is something to do with, so A
  // opens and A buys. Two presses, with the button released between them.
  input.apply(readPad(pad({ buttons: { [B.confirmAlt]: 1 } })))
  assert.ok(buying.slotMenu, "A opened the core's steps")
  input.apply(readPad(pad()))
  input.apply(readPad(pad({ buttons: { [B.confirmAlt]: 1 } })))
  assert.equal(buying.upgrades.core, coreLevel + 1, "and A bought the step it opened on")

  const launching = liveGame()
  launching.enterShop()
  launching.shopSelection = launching.launchRow
  new GamepadInput(launching).apply(readPad(pad({ buttons: { [B.confirmAlt]: 1 } })))
  assert.equal(launching.phase, "arriving", "A launched from the launch row")
})

test("A fills a slot in flight and confirms in a menu, never both", () => {
  // A is also special slot 1, which is only reachable in a flying phase, so the
  // two uses cannot collide.
  const inFlight = liveGame()
  inFlight.player.equip(0, "refuel")
  inFlight.player.energy = 10
  const flying = new GamepadInput(inFlight)
  flying.apply(readPad(pad({ buttons: { [B.confirmAlt]: 1 } })))
  flying.apply(readPad(pad({})))
  assert.ok(inFlight.player.energy > 10, "in flight A used the slot")
  assert.equal(inFlight.phase, "play", "and did not confirm anything")

  const inShop = liveGame()
  inShop.player.equip(0, "refuel")
  inShop.player.energy = 10
  inShop.enterShop()
  const shopping = new GamepadInput(inShop)
  shopping.apply(readPad(pad({ buttons: { [B.confirmAlt]: 1 } })))
  shopping.apply(readPad(pad({})))
  assert.equal(inShop.player.energy, 10, "in a menu A left the slot alone")
})

test("the dpad walks the shop and A confirms", () => {
  const game = liveGame()
  game.enterShop()
  const input = new GamepadInput(game)
  // Release first, so the press that follows is always an edge whatever was held
  // before it. Releasing afterwards instead leaves the next press with no edge.
  const press = (fields) => {
    input.apply(readPad(pad({})))
    input.apply(readPad(pad(fields)))
  }
  assert.equal(game.shopSelection, 0)
  input.apply(readPad(pad({ buttons: { [B.dpadDown]: 1 } })))
  assert.equal(game.shopSelection, 1, "one press moves one row")
  input.apply(readPad(pad({ buttons: { [B.dpadDown]: 1 } })))
  assert.equal(game.shopSelection, 1, "holding it does not run away")
  input.apply(readPad(pad()))
  input.apply(readPad(pad({ buttons: { [B.dpadUp]: 1 } })))
  assert.equal(game.shopSelection, 0)
  // wrap backwards off the top onto the settings cell, which is the last of them
  press({ buttons: { [B.dpadUp]: 1 } })
  assert.equal(game.shopSelection, game.optionsRow, "wraps onto the options cell")
  // and left or right moves between it and the launch beside it
  press({ buttons: { [B.dpadRight]: 1 } })
  assert.equal(game.shopSelection, game.launchRow, "right moves to the launch")
  press({ buttons: { [B.confirmAlt]: 1 } })
  assert.equal(game.phase, "arriving", "A launched from the shop")
})

test("BACK reaches the options menu from the shop", () => {
  const game = liveGame()
  game.enterShop()
  const input = new GamepadInput(game)
  assert.equal(game.paused, false)
  input.apply(readPad(pad({ buttons: { [B.pause]: 1 } })))
  assert.equal(game.paused, true, "BACK opened the options menu over the shop")
  assert.equal(game.phase, "shop", "and did not leave the shop")
  // the options rows take over from the shop's while it is open
  assert.ok(game.pauseMenu().some((row) => row.name === "CONTROLS"))
})

// START pauses during play, and confirms everywhere else. Routing it to the options
// menu wherever one could be opened took the launch away from a pad: pressing it at
// the shop opened the menu instead, so the run never left the sector it was on.
test("START launches from the shop, and pauses only in a sector", () => {
  const launching = liveGame()
  launching.level = 2
  launching.enterShop()
  launching.shopSelection = launching.launchRow
  const input = new GamepadInput(launching)
  input.apply(readPad(pad({ buttons: { [B.confirm]: 1 } })))
  assert.equal(launching.phase, "arriving", "START launched")
  assert.equal(launching.level, 3, "into the next sector")
  assert.equal(launching.paused, false, "and opened no menu")

  const flying = liveGame()
  const flyingInput = new GamepadInput(flying)
  flyingInput.apply(readPad(pad({ buttons: { [B.confirm]: 1 } })))
  assert.equal(flying.paused, true, "in a sector it opens the options menu")
})

test("START still starts a run from the title, where there is nothing to pause", () => {
  const game = new Game()
  game.phase = "title"
  const input = new GamepadInput(game)
  input.apply(readPad(pad({ buttons: { [B.confirm]: 1 } })))
  assert.equal(game.phase, "arriving", "it confirmed instead")
  assert.equal(game.paused, false)
})

test("the dpad steps the dev sector, and only in the dev shop", () => {
  const game = liveGame()
  game.enterShop()
  const input = new GamepadInput(game)
  const sector = game.shopSector
  // The sector only steps from the row that shows it, which is the launch line.
  game.shopSelection = game.launchRow
  input.apply(readPad(pad({ buttons: { [B.dpadRight]: 1 } })))
  assert.equal(game.shopSector, sector, "not offered outside dev mode")
  game.setDevAnySector(true)
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
  // Release first, so the press that follows is always an edge.
  const press = (fields) => {
    input.apply(readPad(pad({})))
    input.apply(readPad(pad(fields)))
  }
  game.toggleOptions()
  game.openPausePage("controls")
  press({ buttons: { [B.back]: 1 } })
  assert.equal(game.pausePage, "root", "off the sub page first")
  assert.equal(game.paused, true, "without closing the menu")
  press({ buttons: { [B.back]: 1 } })
  assert.equal(game.paused, false, "a second press closes it")
})

// A row waiting for a button on a pad. Returns the input so a test can drive it.
function waitingForAButton(game) {
  const input = new GamepadInput(game)
  game.toggleOptions()
  game.openPausePage("controls")
  game.beginRebind("buttons", "thrust")
  return input
}
const HOLD = GAMEPAD.rebindCancelHold

test("a pad binding is taken when the button comes back up", () => {
  const game = liveGame()
  const input = waitingForAButton(game)
  input.apply(readPad(pad({ buttons: { [B.dpadUp]: 1 } })), 1 / 60)
  assert.ok(game.rebinding, "nothing is taken while the button is still down")
  input.apply(readPad(pad({})), 1 / 60)
  assert.equal(game.rebinding, null, "and the release fills the row")
  assert.equal(game.bindings.buttons.thrust, B.dpadUp)
})

test("a tap of B binds it, so the one button a pad could not reach now can be", () => {
  const game = liveGame()
  const input = waitingForAButton(game)
  input.apply(readPad(pad({ buttons: { [B.back]: 1 } })), 1 / 60)
  assert.ok(game.rebinding, "a tap is not a cancel")
  input.apply(readPad(pad({})), 1 / 60)
  assert.equal(game.bindings.buttons.thrust, B.back, "B is captured like any other button")
  assert.equal(game.rebinding, null)
  assert.equal(game.pausePage, "controls", "without leaving the page")
})

test("holding B abandons the wait, and the release that ends it is not captured", () => {
  const game = liveGame()
  const input = waitingForAButton(game)
  const before = game.bindings.buttons.thrust
  // hold it past the threshold
  for (let held = 0; held <= HOLD + 0.05; held += 1 / 60) {
    input.apply(readPad(pad({ buttons: { [B.back]: 1 } })), 1 / 60)
  }
  assert.equal(game.rebinding, null, "the wait is abandoned")
  input.apply(readPad(pad({})), 1 / 60)
  assert.equal(game.bindings.buttons.thrust, before, "and letting go binds nothing")
  assert.equal(game.pausePage, "controls", "nor does it back out of the page")
  assert.equal(game.paused, true, "nor close the menu")
})

test("a hold only cancels once, so the next wait is not cancelled by the same press", () => {
  const game = liveGame()
  const input = waitingForAButton(game)
  for (let held = 0; held <= HOLD + 0.05; held += 1 / 60) {
    input.apply(readPad(pad({ buttons: { [B.back]: 1 } })), 1 / 60)
  }
  assert.equal(game.rebinding, null)
  // still holding B, ask for another binding
  game.beginRebind("buttons", "fire")
  input.apply(readPad(pad({ buttons: { [B.back]: 1 } })), 1 / 60)
  assert.ok(game.rebinding, "a press already spent cannot cancel again")
})

test("the A that chooses a row is not captured by its own release", () => {
  // Taking a binding on release means the press that opened the wait is still
  // down when it opens; letting go of it must not fill the row with A.
  const game = liveGame()
  const input = new GamepadInput(game)
  game.toggleOptions()
  game.openPausePage("controls")
  const rows = game.pauseMenu()
  game.pauseSelection = rows.findIndex((row) => row.section === "GAMEPAD")
  const before = game.bindings.buttons.thrust
  input.apply(readPad(pad({})), 1 / 60)
  input.apply(readPad(pad({ buttons: { [B.confirmAlt]: 1 } })), 1 / 60) // A chooses the row
  assert.ok(game.rebinding, "the row is waiting")
  input.apply(readPad(pad({})), 1 / 60) // and A comes back up
  assert.ok(game.rebinding, "still waiting")
  assert.equal(game.bindings.buttons.thrust, before, "A was not captured by letting go of it")
  // pressing A again, deliberately, does bind it
  input.apply(readPad(pad({ buttons: { [B.confirmAlt]: 1 } })), 1 / 60)
  input.apply(readPad(pad({})), 1 / 60)
  assert.equal(game.bindings.buttons.thrust, B.confirmAlt, "a fresh press of A binds it")
})

test("BACK still abandons a wait outright, being reserved and unbindable", () => {
  const game = liveGame()
  const input = waitingForAButton(game)
  const before = game.bindings.buttons.thrust
  input.apply(readPad(pad({})), 1 / 60)
  input.apply(readPad(pad({ buttons: { [B.pause]: 1 } })), 1 / 60)
  assert.equal(game.rebinding, null, "the wait is abandoned on the press")
  input.apply(readPad(pad({})), 1 / 60)
  assert.equal(game.bindings.buttons.thrust, before, "and BACK was not captured")
})

test("B still works its special slot in flight", () => {
  // B is slot 2 by default and back in a menu. The two never collide, because a
  // slot only works in a flying phase and a menu only exists outside one.
  const game = liveGame()
  const input = new GamepadInput(game)
  game.upgrades.slots = 2
  game.player.equip(0, "refuel")
  game.player.equip(1, "repel")
  assert.equal(game.paused, false)
  input.apply(readPad(pad({ buttons: { [B.back]: 1 } })))
  input.apply(readPad(pad({})))
  assert.ok(game.player.items[1].cooldown > 0, "the second slot was used")
  assert.equal(game.player.items[0].cooldown, 0, "and only that one")
})

test("the HUD names a special slot by what is actually bound to it", () => {
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

test("a slot says which pad button works it by where the button is, not by its letter", () => {
  // The Gamepad API reports an index and never a layout, so a letter can only ever be right
  // for some pads: index 0 is A on an Xbox pad and B on a Nintendo one. What the standard
  // mapping does guarantee is that an index is a position, so that is what the HUD draws.
  const game = liveGame()
  game.inputMode = "gamepad"
  assert.equal(game.settings.help, true, "the hint rides on help text")

  assert.equal(game.slotButton(0), D.slot1, "a slot reports the button bound to it")
  game.bindings.buttons.slot1 = 3
  assert.equal(game.slotButton(0), 3, "and follows a rebind")
  game.inputMode = "keyboard"
  assert.equal(game.slotButton(0), null, "a keyboard player has no pad button to be shown")
  game.inputMode = "gamepad"
  delete game.bindings.buttons.slot1
  assert.equal(game.slotButton(0), null, "and neither has an unbound slot")

  // Every face button, every shoulder and every D-pad direction has a position; the ones
  // that do not are the buttons there is nothing useful to draw for.
  for (let button = 0; button <= 7; button++) {
    assert.ok(PAD_LAYOUT[button], `button ${button} should have a position`)
  }
  for (let button = 12; button <= 15; button++) {
    assert.ok(PAD_LAYOUT[button], `D-pad button ${button} should have a position`)
  }
  assert.equal(PAD_LAYOUT[B.pause], undefined, "and a reserved button needs none")

  // A cluster is four positions, and each of them is exactly one button: two buttons
  // sharing a spot would draw one lit dot for either of them.
  for (const [group, spots] of Object.entries(PAD_CLUSTERS)) {
    assert.equal(spots.length, 4, `${group} should hold four buttons`)
    const seen = new Set(spots.map((at) => at.join(",")))
    assert.equal(seen.size, 4, `${group} should put each of them somewhere different`)
  }
  // And the face cluster is the standard mapping's own order: bottom, right, left, top.
  assert.deepEqual(
    [0, 1, 2, 3].map((button) => PAD_LAYOUT[button].at),
    [
      [0, 1],
      [1, 0],
      [-1, 0],
      [0, -1],
    ],
    "0 bottom, 1 right, 2 left, 3 top",
  )
})

test("the HUD draws that position, and moves the lit one when the binding moves", () => {
  const game = liveGame()
  game.inputMode = "gamepad"
  game.player.equip(0, "refuel")

  // Everything the HUD draws, as a box plus its middle, so a circle and a rect can be
  // measured the same way: a cluster is round for a face button and square or a bar for the
  // others, and the assertions below are about where its marks sit rather than which
  // primitive drew them.
  const hud = (uiScale = 1) => {
    const filled = [],
      outlined = [],
      soft = [],
      labels = []
    const box = (list, x, y, w, h, extra = {}) =>
      list.push({ x, y, w, h, cx: x + w / 2, cy: y + h / 2, ...extra })
    const renderer = new Proxy(
      {
        circle: (x, y, r, opts = {}) => {
          // `circle`'s own fill is the additive sprite pipeline, kept apart from the crisp
          // discs below: the two are the same geometry and read nothing like each other.
          if (opts.fill) {
            box(soft, x - r, y - r, r * 2, r * 2, { r })
          }
          box(opts.fill ? filled : outlined, x - r, y - r, r * 2, r * 2, { r })
        },
        // The renderer's crisp disc, which is what a lit face button is filled with.
        occlude: (x, y, r) => box(filled, x - r, y - r, r * 2, r * 2, { r }),
        rect: (x, y, w, h, opts = {}) => box(opts.fill ? filled : outlined, x, y, w, h),
        text: (str, x, y, opts = {}) => labels.push({ str: String(str), x, y, size: opts.size }),
      },
      { get: (target, key) => (key in target ? target[key] : () => {}) },
    )
    game.settings.uiScale = uiScale
    new GameView(renderer).drawHud(game)
    return { filled, outlined, soft, labels }
  }
  // The hint's marks are the only small shapes the HUD draws: everything else in that corner
  // is a slot box at 20 units or a bar spanning the page. A size cap is what picks them out,
  // and picking them by primitive instead caught the energy bar and measured its corners.
  const small = (list) => list.filter((shape) => shape.w < 10)

  // The letter is gone, replaced by the picture.
  game.bindings.buttons.slot1 = 0
  assert.ok(
    !hud().labels.some((label) => label.str === "A"),
    "a pad player is shown where the button is rather than told a letter",
  )
  // The bound button is the one that is filled, and it is the only filled mark in its
  // cluster: fill against outline is what says which of the four it is.
  const litFor = (button) => {
    game.bindings.buttons.slot1 = button
    const marks = small(hud().filled)
    assert.ok(marks.length > 0, `something is lit for button ${button}`)
    return marks.reduce((best, mark) => (mark.cx < best.cx ? mark : best))
  }
  const top = litFor(3),
    low = litFor(0),
    left = litFor(2),
    right = litFor(1)
  assert.ok(top.cy < low.cy, "the top face button is drawn above the bottom one")
  assert.ok(left.cx < right.cx, "and the left one to the left of the right one")
  assert.ok(Math.abs(top.cx - low.cx) < 0.01, "the pair on the vertical share a column")
  assert.ok(Math.abs(left.cy - right.cy) < 0.01, "and the pair on the horizontal share a row")
  // Same size as the three beside it, so which is lit is the fill and nothing else.
  const unlit = small(hud().outlined)
  assert.ok(unlit.length >= 3, "the other three are drawn as well")
  assert.ok(
    unlit.every((mark) => Math.abs(mark.w - right.w) < 0.01),
    "every mark of a cluster is the same size",
  )
  // And it is solid at that size. This is the one place the primitive itself is asserted,
  // because the geometry cannot tell the two apart: `circle`'s fill is the additive sprite
  // pipeline, which falls away from the middle and is about a sixth as bright at the radius
  // it was asked for, so a mark that size reads as a dot floating inside its own ring. The
  // crisp disc is the only way to draw it solid, and solid is the whole distinction between
  // the lit button and the other three.
  game.bindings.buttons.slot1 = 0
  assert.equal(
    small(hud().soft).length,
    0,
    "a lit face button is filled with the crisp disc, not the soft sprite",
  )

  // The shoulders are stacked tighter than they are spread, because a bumper sits close
  // above its trigger: on the spacing the square clusters use, the four bars read as four
  // loose buttons rather than as a pair on each shoulder.
  //
  const marksFor = (button) => {
    game.bindings.buttons.slot1 = button
    const drawn = hud()
    // One mark per position. The lit one is drawn twice, a fill and then an edge at the same
    // size, so the two are folded back together here: what is being measured is where the
    // four buttons sit, not how many calls each took.
    const byPlace = new Map()
    for (const mark of small(drawn.filled.concat(drawn.outlined))) {
      const place = `${mark.cx.toFixed(2)},${mark.cy.toFixed(2)}`
      if (!byPlace.has(place)) {
        byPlace.set(place, mark)
      }
    }
    // four to a cluster, and the first slot's are the leftmost of them
    const cluster = [...byPlace.values()].sort((a, b) => a.cx - b.cx).slice(0, 4)
    assert.equal(cluster.length, 4, `button ${button} should draw a cluster of four`)
    return cluster
  }
  const shoulders = marksFor(4)
  const spread = Math.max(...shoulders.map((b) => b.cx)) - Math.min(...shoulders.map((b) => b.cx))
  const stack = Math.max(...shoulders.map((b) => b.cy)) - Math.min(...shoulders.map((b) => b.cy))
  assert.ok(stack > 0 && spread > 0, "the shoulders are drawn as a pair on each side")
  assert.ok(
    stack < spread,
    `a bumper should sit closer to its trigger than to the other side, got ${stack.toFixed(1)} down against ${spread.toFixed(1)} across`,
  )
  // And nothing in a cluster overlaps its neighbour, at any scale: four marks that touch
  // are one blob, which is the thing this whole picture exists to avoid.
  for (const marks of [marksFor(0), marksFor(4), marksFor(12)]) {
    for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        const a = marks[i],
          b = marks[j]
        const apart =
          Math.abs(a.cx - b.cx) >= (a.w + b.w) / 2 || Math.abs(a.cy - b.cy) >= (a.h + b.h) / 2
        assert.ok(apart, `two marks of a cluster overlap: ${JSON.stringify([a, b])}`)
      }
    }
  }

  // A button with no position falls back to being named, rather than drawing nothing.
  game.bindings.buttons.slot1 = 11
  assert.ok(
    hud().labels.some((label) => label.str === "B11"),
    "a stick press is named, since there is no picture for it",
  )

  // With help off it is the letter again: the hint is help text like any other.
  game.bindings.buttons.slot1 = 0
  game.setHelp(false)
  assert.ok(
    hud().labels.some((label) => label.str === "A"),
    "help off falls back to the letter",
  )
  game.setHelp(true)

  // And it scales with the rest of the HUD, anchored to the right edge as its box is.
  const atOneX = litFor(0)
  game.bindings.buttons.slot1 = 0
  game.settings.uiScale = 1
  const factor = 2
  const atTwoX = (() => {
    game.settings.uiScale = factor
    const marks = hud(factor).filled.filter((shape) => shape.w < 10 * factor)
    return marks.reduce((best, mark) => (mark.cx < best.cx ? mark : best))
  })()
  assert.ok(
    Math.abs(VIEW_W - atTwoX.cx - (VIEW_W - atOneX.cx) * factor) < 0.5,
    `the hint sits ${VIEW_W - atOneX.cx} from the right edge, then ${VIEW_W - atTwoX.cx}`,
  )
  assert.ok(Math.abs(atTwoX.w - atOneX.w * factor) < 0.01, "and the mark grows with it")
})
