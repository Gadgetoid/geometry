// Gamepad input.
//
// The Gamepad API is polled rather than evented, so a pad is sampled once a
// frame and turned into the same intents the keyboard produces. Held controls go
// into game.padInput, which the ship reads alongside pressedKeys; presses are
// edge-detected against the previous sample, so a held button acts once and a
// held direction moves the shop cursor one row.
//
// Nothing here reaches past game's public input methods, and every index and
// threshold comes from GAMEPAD in config.js.

import { GAMEPAD } from "./config.js"

// Rescale travel past the deadzone back to a full 0..1, so the control starts
// moving from nothing rather than jumping to the deadzone's value.
export function applyDeadzone(value, deadzone) {
  const size = Math.abs(value)
  if (size < deadzone) {
    return 0
  }
  return Math.sign(value) * ((size - deadzone) / (1 - deadzone))
}

// How far a button is pressed, 0..1. A standard-mapping entry is an object with
// both a flag and an analog value; older mappings expose a bare number. Treating
// a pressed flag as fully travelled lets one threshold serve buttons and
// triggers alike.
function buttonTravel(pad, index) {
  const button = pad.buttons ? pad.buttons[index] : undefined
  if (button == null) {
    return 0
  }
  if (typeof button === "number") {
    return button
  }
  return button.pressed ? 1 : button.value || 0
}

// Every mapped control, as intent rather than as hardware. Pure, so the mapping
// is testable without a browser or a device.
export function readPad(pad) {
  const button = GAMEPAD.buttons
  const axis = (index) => (pad.axes && pad.axes[index]) || 0
  const held = (index) => buttonTravel(pad, index) >= GAMEPAD.triggerThreshold
  // The turret takes an absolute bearing from the stick, so it needs a deadzone
  // of its own: a barely-touched stick should not swing the guns.
  const turretX = applyDeadzone(axis(GAMEPAD.axes.turretX), GAMEPAD.turretDeadzone)
  const turretY = applyDeadzone(axis(GAMEPAD.axes.turretY), GAMEPAD.turretDeadzone)
  const menuAxis = axis(GAMEPAD.axes.menu)
  return {
    turn: applyDeadzone(axis(GAMEPAD.axes.turn), GAMEPAD.deadzone),
    thrust: held(button.thrust),
    reverse: held(button.reverse),
    fire: held(button.fire),
    turretAim: turretX || turretY ? Math.atan2(turretY, turretX) : null,
    turretFire: held(button.turretFire),
    confirm: held(button.confirm) || held(button.confirmAlt),
    pause: held(button.pause),
    slots: button.slots.map(held),
    menuUp: held(button.dpadUp) || menuAxis <= -GAMEPAD.menuStep,
    menuDown: held(button.dpadDown) || menuAxis >= GAMEPAD.menuStep,
    menuLeft: held(button.dpadLeft),
    menuRight: held(button.dpadRight),
  }
}

// Is the player touching the pad at all? Drives the switch of on-screen prompts,
// so it must not trip on a resting stick, which is what the deadzones are for.
export function padInUse(state) {
  return Boolean(
    state.turn ||
    state.thrust ||
    state.reverse ||
    state.fire ||
    state.turretFire ||
    state.turretAim !== null ||
    state.confirm ||
    state.pause ||
    state.slots.some(Boolean) ||
    state.menuUp ||
    state.menuDown ||
    state.menuLeft ||
    state.menuRight,
  )
}

// The first pad the browser reports as connected, or null.
function firstPad() {
  if (typeof navigator === "undefined" || !navigator.getGamepads) {
    return null
  }
  for (const pad of navigator.getGamepads()) {
    if (pad && pad.connected !== false) {
      return pad
    }
  }
  return null
}

export class GamepadInput {
  constructor(game) {
    this.game = game
    this.previous = null
  }

  // Once a frame, before the simulation advances.
  poll() {
    const pad = firstPad()
    if (!pad) {
      if (this.previous) {
        this.game.padInput = this.game.blankPadInput() // unplugged mid-flight
        this.previous = null
      }
      return
    }
    this.apply(readPad(pad))
  }

  // Drive one sample into the game. Separate from polling so a test can feed a
  // sample without a browser.
  apply(state) {
    const game = this.game
    const before = this.previous
    const pressed = (field) => state[field] && !(before && before[field])
    if (padInUse(state)) {
      game.inputMode = "gamepad"
    }

    game.padInput = {
      turn: state.turn,
      thrust: state.thrust,
      reverse: state.reverse,
      charging: state.fire,
      turretAim: state.turretAim,
      turretFire: state.turretFire,
    }

    // Firing is on release, as it is for the space bar: the trigger is held to
    // charge and the shot goes when it comes back up.
    if (before && before.fire && !state.fire) {
      game.releaseFire()
    }
    state.slots.forEach((down, index) => {
      if (down && !(before && before.slots[index])) {
        game.tryUseSlot(index)
      }
    })
    if (pressed("confirm")) {
      game.menuConfirm()
    }
    if (pressed("pause")) {
      game.togglePause()
    }
    if (pressed("menuUp")) {
      game.menuMove(-1)
    }
    if (pressed("menuDown")) {
      game.menuMove(1)
    }
    if (pressed("menuLeft")) {
      game.devSectorStep(-1)
    }
    if (pressed("menuRight")) {
      game.devSectorStep(1)
    }

    this.previous = state
  }
}
