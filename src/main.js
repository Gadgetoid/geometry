// Entry point: wire the DOM, create the renderer + game, run the loop.

import { WebGLRenderer } from "./glrenderer.js"
import { GameView } from "./view.js"
import { Game } from "./game.js"
import { GamepadInput } from "./gamepad.js"
import { DEV_VISIBLE, SPECIAL_TYPES, SHOP } from "./config.js"
import { PALETTE } from "./palette.js"
import { Sound } from "./audio.js"

const canvas = document.getElementById("game")
const renderer = WebGLRenderer.create(canvas)
// WebGL2 is the only backend. Say so plainly instead of leaving a black screen.
if (!renderer) {
  document.getElementById("screen").innerHTML =
    '<p class="unsupported">WEBGL2 REQUIRED<br /><small>This browser could not' +
    " create a WebGL2 context.</small></p>"
  throw new Error("WebGL2 unavailable")
}
// ?fullscreen drops the page frame and the help line so the canvas owns the
// screen, for a Steam shortcut or anything else running this without a desktop
// around it. ?sound starts with audio already on, see below.
const OPTIONS = new URLSearchParams(location.search)
const FULLSCREEN = OPTIONS.has("fullscreen")
if (FULLSCREEN) {
  document.body.classList.add("fullscreen")
}
// Whether the page's own buttons are worth having. A build launched without a desktop around
// it is being played rather than worked on, whatever it was served from - and the packaged
// build runs off the filesystem, which is one of the things DEV_VISIBLE reads as developing.
const PAGE_BUTTONS = DEV_VISIBLE && !FULLSCREEN

const view = new GameView(renderer)
const game = new Game()
// Script can only close a window it owns, which means an app window rather than a tab,
// so the pause menu leaves Exit out where it would do nothing. A tab is the case
// display-mode names exactly: anything else, standalone or the fullscreen an --app=
// window is already in by the time this runs, is a window the game may close.
game.canExit = !matchMedia("(display-mode: browser)").matches
const gamepad = new GamepadInput(game)

// Debug / test handle: lets the browser console and the smoke test inspect and
// drive live state without reaching into module scope.
window.__geometry = { game, view, renderer, gamepad, SPECIAL_TYPES, SHOP, PALETTE }

// The help line names whichever device is in use. Both are in the page so the
// swap costs nothing and neither has to be built in script.
const helpFor = {
  keyboard: document.getElementById("helpKeys"),
  gamepad: document.getElementById("helpPad"),
}
let shownHelp = null
function syncHelp() {
  if (FULLSCREEN || shownHelp === game.inputMode) {
    return
  }
  shownHelp = game.inputMode
  for (const [mode, element] of Object.entries(helpFor)) {
    element.hidden = mode !== shownHelp
  }
}
syncHelp()

addEventListener("keydown", (e) => game.onKeyDown(e))
addEventListener("keyup", (e) => game.onKeyUp(e))
addEventListener("blur", () => game.onBlur())

document.getElementById("btnCrt").addEventListener("click", (e) => {
  game.setCrt(!game.settings.crt)
  e.currentTarget.setAttribute("aria-pressed", String(game.settings.crt))
})

const soundButton = document.getElementById("btnSnd")
soundButton.addEventListener("click", (e) => {
  game.setSound(!game.settings.sound)
  e.currentTarget.setAttribute("aria-pressed", String(game.settings.sound))
  if (game.settings.sound) {
    // The device only opens inside a real gesture, so unlock it here. setSound
    // makes the confirmation tone itself.
    Sound.ensureContext()
  }
})

// ?sound starts with audio on, rather than waiting to be asked for it.
//
// A browser will only open an audio device off a real user gesture, and a gamepad
// button is not one, so a player holding only a pad has no way to turn sound on:
// the button needs a pointer. The launcher passes this together with
// --autoplay-policy=no-user-gesture-required, which is what allows the device to
// open unprompted. Without that flag the context comes up suspended and stays
// quiet until something is clicked, which is the same as not passing this at all.
if (OPTIONS.has("sound")) {
  game.setSound(true)
  Sound.ensureContext()
}

// Settings live on the game so the pause menu can work them without knowing about
// the renderer or the DOM; this is where they are actually applied. Cheap enough to
// check every frame, and it means a change from any source lands the same way.
const applied = { crt: null, sound: null }
function syncSettings() {
  if (applied.crt !== game.settings.crt) {
    applied.crt = game.settings.crt
    renderer.crtEnabled = game.settings.crt
    document.querySelector(".stage").classList.toggle("crt-off", !game.settings.crt)
    document.getElementById("btnCrt").setAttribute("aria-pressed", String(game.settings.crt))
  }
  if (applied.sound !== game.settings.sound) {
    applied.sound = game.settings.sound
    soundButton.setAttribute("aria-pressed", String(game.settings.sound))
    soundButton.style.display = game.settings.sound && !PAGE_BUTTONS ? "none" : ""
  }
}

// CRT and DEV are for developing: the filter is in the pause menu and nothing else
// here is a player's business, so a published build is cleaner without either. A
// packaged build runs off the filesystem, which DEV_VISIBLE reads as developing, so
// ?fullscreen has the last word - the stylesheet hides both there as well.
//
// SOUND is not the same. A browser only opens an audio device inside a real pointer
// gesture, and a gamepad button is not one, so the pause menu cannot unlock it for a
// player holding only a pad: SOUND would read ON and stay silent. The button is
// therefore shown exactly while it is needed - whenever sound is off - and goes once
// it is on, which is the only state it has nothing left to do in. On a dev build in a
// browser it stays, since turning sound back off is something worth reaching for.
//
// The packaged build passes ?sound and starts with audio on, so the button is already
// gone by the time anything is drawn: this is for a browser, where it cannot be.
const devButton = document.getElementById("btnDev")
if (!PAGE_BUTTONS) {
  for (const id of ["btnDev", "btnCrt"]) {
    document.getElementById(id).style.display = "none"
  }
}
devButton.addEventListener("click", (e) => {
  game.openDevMenu()
  e.currentTarget.setAttribute("aria-pressed", "true")
  e.currentTarget.blur()
})

function resize() {
  view.resize(canvas.getBoundingClientRect())
}
new ResizeObserver(resize).observe(canvas)
resize()

// Pause simulation and audio while the tab is hidden. Background rAF ticks
// would otherwise keep the AI firing and emit stray sounds.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    Sound.setThruster(false)
    if (Sound.ctx && Sound.ctx.suspend) {
      Sound.ctx.suspend()
    }
    game.onBlur()
  } else if (Sound.enabled && Sound.ctx && Sound.ctx.resume) {
    Sound.ctx.resume().catch(() => {})
  }
})

let last = 0
function loop(timestamp) {
  if (!last) {
    last = timestamp
  }
  let dt = (timestamp - last) / 1000
  last = timestamp
  if (document.hidden) {
    // don't simulate in the background (avoids stray AI fire / sounds)
    requestAnimationFrame(loop)
    return
  }
  if (dt > 0.05) {
    dt = 0.05
  } // clamp so a stalled tab doesn't teleport everything
  // a pad is polled, not evented, so it is sampled before the step it drives
  gamepad.poll(dt)
  syncHelp()
  syncSettings()
  if (game.exitRequested) {
    // Only works because the game is opened as an app window; a tab the user opened
    // themselves refuses. The launcher notices the window going and exits with it,
    // which is what lets Steam see the game stop.
    window.close()
    return
  }
  game.advance(dt)
  // the simulation still runs while a lost GPU context is being restored
  if (renderer.ready) {
    view.render(game)
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)
