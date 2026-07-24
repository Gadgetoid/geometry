// Entry point: wire the DOM, create the renderer + game, run the loop.

import { Canvas2DRenderer } from "./renderer.js"
import { WebGLRenderer } from "./glrenderer.js"
import { GameView } from "./view.js"
import { Game } from "./game.js"
import { DEV_VISIBLE } from "./config.js"
import { Sound } from "./audio.js"

const canvas = document.getElementById("game")
// Prefer the WebGL2 shader backend; fall back to Canvas 2D where unavailable.
const renderer = WebGLRenderer.create(canvas) || new Canvas2DRenderer(canvas)
const usingGL = renderer instanceof WebGLRenderer
if (usingGL) {
  // The shader does the CRT effect; hide the CSS overlays so they don't stack.
  document.querySelector(".stage").classList.add("gl")
}
const view = new GameView(renderer)
const game = new Game()

addEventListener("keydown", (e) => game.onKeyDown(e))
addEventListener("keyup", (e) => game.onKeyUp(e))
addEventListener("blur", () => game.onBlur())

document.getElementById("btnCrt").addEventListener("click", (e) => {
  // Canvas fallback toggles the CSS overlays; WebGL toggles the shader effect.
  const off = document.querySelector(".stage").classList.toggle("crt-off")
  renderer.crtEnabled = !off
  e.currentTarget.setAttribute("aria-pressed", String(!off))
})

document.getElementById("btnSnd").addEventListener("click", (e) => {
  Sound.enabled = !Sound.enabled
  e.currentTarget.setAttribute("aria-pressed", String(Sound.enabled))
  if (Sound.enabled) {
    Sound.ensureContext()
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

let last = 0
function loop(timestamp) {
  if (!last) {
    last = timestamp
  }
  let dt = (timestamp - last) / 1000
  last = timestamp
  if (dt > 0.05) {
    dt = 0.05
  } // clamp so a stalled tab doesn't teleport everything
  game.advance(dt)
  view.render(game)
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)
