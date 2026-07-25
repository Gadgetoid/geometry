// Entry point: wire the DOM, create the renderer + game, run the loop.

import { WebGLRenderer } from "./glrenderer.js"
import { GameView } from "./view.js"
import { Game } from "./game.js"
import { GamepadInput } from "./gamepad.js"
import { DEV_VISIBLE, POWERUP_TYPES, SHOP } from "./config.js"
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
const view = new GameView(renderer)
const game = new Game()
const gamepad = new GamepadInput(game)

// Debug / test handle: lets the browser console and the smoke test inspect and
// drive live state without reaching into module scope.
window.__geometry = { game, view, renderer, gamepad, POWERUP_TYPES, SHOP }

// The help line names whichever device is in use. Both are in the page so the
// swap costs nothing and neither has to be built in script.
const helpFor = {
  keyboard: document.getElementById("helpKeys"),
  gamepad: document.getElementById("helpPad"),
}
let shownHelp = null
function syncHelp() {
  if (shownHelp === game.inputMode) {
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
  const off = document.querySelector(".stage").classList.toggle("crt-off")
  renderer.crtEnabled = !off
  e.currentTarget.setAttribute("aria-pressed", String(!off))
})

document.getElementById("btnSnd").addEventListener("click", (e) => {
  Sound.enabled = !Sound.enabled
  e.currentTarget.setAttribute("aria-pressed", String(Sound.enabled))
  if (Sound.enabled) {
    // resume + unlock the context inside this gesture, then a confirmation blip
    Sound.ensureContext()
    Sound.power()
  }
})

const devButton = document.getElementById("btnDev")
if (!DEV_VISIBLE) {
  devButton.style.display = "none"
}
devButton.addEventListener("click", (e) => {
  game.enterDevShop()
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
  gamepad.poll()
  syncHelp()
  game.advance(dt)
  // the simulation still runs while a lost GPU context is being restored
  if (renderer.ready) {
    view.render(game)
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)
