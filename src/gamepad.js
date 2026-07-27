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

import { GAMEPAD, freshBindings } from "./config.js"

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
//
// `bound` is the buttons half of a bindings table, so which physical button works
// a control is the player's business; the axes and the menu buttons are fixed and
// come from GAMEPAD. Defaults are used when no table is passed, which is what the
// mapping tests want.
export function readPad(pad, bound = freshBindings().buttons) {
  const button = GAMEPAD.buttons
  const axis = (index) => (pad.axes && pad.axes[index]) || 0
  const held = (index) => buttonTravel(pad, index) >= GAMEPAD.triggerThreshold
  // The turret takes an absolute bearing from the stick, so it needs a deadzone
  // of its own: a barely-touched stick should not swing the guns.
  const turretX = applyDeadzone(axis(GAMEPAD.axes.turretX), GAMEPAD.turretDeadzone)
  const turretY = applyDeadzone(axis(GAMEPAD.axes.turretY), GAMEPAD.turretDeadzone)
  const menuAxis = axis(GAMEPAD.axes.menu)
  // A control with nothing bound to it simply reads as not held.
  const bind = (action) => (bound[action] === undefined ? false : held(bound[action]))
  // Every button past the threshold, so a rebind can see what was pressed without
  // the mapping standing in the way.
  const pressed = []
  const count = pad.buttons ? pad.buttons.length : 0
  for (let index = 0; index < count; index++) {
    if (buttonTravel(pad, index) >= GAMEPAD.triggerThreshold) {
      pressed.push(index)
    }
  }
  return {
    turn: applyDeadzone(axis(GAMEPAD.axes.turn), GAMEPAD.deadzone),
    thrust: bind("thrust"),
    reverse: bind("reverse"),
    fire: bind("fire"),
    turretAim: turretX || turretY ? Math.atan2(turretY, turretX) : null,
    turretFire: bind("turretFire"),
    confirm: held(button.confirmAlt),
    start: held(button.confirm),
    back: held(button.back),
    pause: held(button.pause),
    slots: [bind("slot1"), bind("slot2"), bind("slot3"), bind("slot4")],
    pressed,
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
    state.start ||
    state.back ||
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
    this.backHeld = 0 // seconds B has been down, for the hold that cancels a rebind
    this.holdCancelled = false // this B press has already abandoned a wait
    this.heldWhenWaitOpened = null // buttons already down when a row started waiting
  }

  // Once a frame, before the simulation advances.
  poll(dt = 0) {
    const pad = firstPad()
    if (!pad) {
      if (this.previous) {
        this.game.padInput = this.game.blankPadInput() // unplugged mid-flight
        this.previous = null
      }
      return
    }
    this.apply(readPad(pad, this.game.bindings.buttons), dt)
  }

  // Drive one sample into the game. Separate from polling so a test can feed a
  // sample without a browser.
  apply(state, dt = 0) {
    const game = this.game
    const before = this.previous
    const pressed = (field) => state[field] && !(before && before[field])
    if (padInUse(state)) {
      game.inputMode = "gamepad"
    }
    if (state.back) {
      this.backHeld += dt
    } else {
      this.backHeld = 0
      this.holdCancelled = false
    }

    game.padInput = {
      turn: state.turn,
      thrust: state.thrust,
      reverse: state.reverse,
      charging: state.fire,
      turretAim: state.turretAim,
      turretFire: state.turretFire,
    }

    // A row waiting for a button takes it when it comes back up, and the menu
    // sees none of it. Binding on release is what lets B be bound like any other
    // button: a tap fills the row, and holding B abandons the wait instead. BACK
    // still abandons it outright, since it opens the menu and is reserved, so it
    // could never be captured anyway.
    if (game.rebinding) {
      // Whatever was already down when the row started waiting - the A that chose
      // it - must not be taken by the release that follows. Pressing it again
      // afterwards binds it like anything else.
      // With no previous sample there is no evidence anything was held, so
      // nothing is excused: the first press to arrive is the binding.
      if (!this.heldWhenWaitOpened) {
        this.heldWhenWaitOpened = new Set(before ? before.pressed : [])
      }
      if (pressed("pause")) {
        game.cancelRebind()
        this.previous = state
        return
      }
      if (state.back && this.backHeld >= GAMEPAD.rebindCancelHold && !this.holdCancelled) {
        this.holdCancelled = true
        game.cancelRebind()
        this.previous = state
        return
      }
      for (const index of before ? before.pressed : []) {
        if (state.pressed.includes(index)) {
          continue // still held; nothing is taken until it comes up
        }
        if (this.heldWhenWaitOpened.delete(index)) {
          continue // left over from choosing the row
        }
        if (index === GAMEPAD.buttons.back && this.holdCancelled) {
          continue // this is the release that ended a cancelling hold
        }
        if (game.captureBinding("buttons", index)) {
          break
        }
      }
      this.previous = state
      return
    }
    this.heldWhenWaitOpened = null

    // Firing is on release, as it is for the fire key: the trigger is held to
    // charge and the shot goes when it comes back up.
    if (before && before.fire && !state.fire) {
      game.releaseFire()
    }
    // Slot buttons are held as well as tapped: a tap uses the slot on release, a
    // hold throws the special overboard, so both edges go through.
    state.slots.forEach((down, index) => {
      const was = !!(before && before.slots[index])
      if (down && !was) {
        game.slotDownAt(index)
      } else if (!down && was) {
        game.slotUpAt(index)
      }
    })
    if (pressed("confirm")) {
      game.menuConfirm()
    }
    // START opens the options menu where there is one, and confirms where there is
    // not, so it still starts a run from the title screen. BACK opens the same menu.
    if (pressed("start")) {
      game.padStart()
    }
    if (pressed("back")) {
      game.menuBack()
    }
    if (pressed("pause")) {
      game.toggleOptions()
    }
    if (pressed("menuUp")) {
      game.menuMove(-1)
    }
    if (pressed("menuDown")) {
      game.menuMove(1)
    }
    if (pressed("menuLeft")) {
      game.menuAdjust(-1)
    }
    if (pressed("menuRight")) {
      game.menuAdjust(1)
    }

    this.previous = state
  }
}
