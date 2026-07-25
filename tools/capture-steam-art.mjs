// Capture Steam library artwork from the game itself.
//
// The art is rendered by the real WebGL backend, so the bloom, the neon weights
// and the CRT curvature are the ones the game actually ships. Nothing is drawn by
// hand except the transparent logo, which reuses the game's own vector glyphs
// through a small canvas adapter because a GL frame has no alpha to give.
//
// Needs a browser and puppeteer-core, neither of which the game depends on:
//
//   npm install --no-save puppeteer-core
//   node tools/capture-steam-art.mjs
//
// Output lands in deck/steam-art/, named for the slots Steam keeps in
// userdata/<id>/config/grid/. See deck/steam-art/README.md.

import puppeteer from "puppeteer-core"
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const OUT = path.join(ROOT, "deck", "steam-art")

// Where to find a browser. CHROME overrides it.
const CHROME_CANDIDATES = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/var/lib/flatpak/app/org.chromium.Chromium/current/active/files/bin/chromium",
].filter(Boolean)

// The GL backend renders into a fixed 2048x1280 scene target, so capturing at
// exactly that size is the most true detail available; anything larger is upscale.
const PLATE_W = 2048
const PLATE_H = 1280

// The slots Steam looks for, and how each is built from the plates.
const ASSETS = [
  { file: "header.png", w: 920, h: 430, slot: "<appid>.png", from: "wide" },
  { file: "capsule.png", w: 460, h: 215, slot: "<appid>.png (small)", from: "wide" },
  { file: "hero.png", w: 1920, h: 620, slot: "<appid>_hero.png", from: "hero" },
  { file: "portrait.png", w: 600, h: 900, slot: "<appid>p.png", from: "portrait" },
  { file: "logo.png", w: 1280, h: 720, slot: "<appid>_logo.png", from: "logo" },
  { file: "icon.png", w: 256, h: 256, slot: "<appid>_icon.png", from: "icon" },
  // a bigger cut of the same frame, for the macOS .app icon, whose .icns wants
  // sizes up to 512 and would otherwise be upscaled from 256
  { file: "icon-512.png", w: 512, h: 512, slot: "macOS .app icon source", from: "icon" },
]

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error("No browser found. Set CHROME=/path/to/chrome, or install the Chromium flatpak.")
}

function serve(root) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0])
    const file = path.join(root, rel === "/" ? "index.html" : rel)
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404)
        return res.end("not found")
      }
      res.writeHead(200, {
        "content-type": types[path.extname(file)] || "application/octet-stream",
      })
      res.end(data)
    })
  })
  return new Promise((resolve) => server.listen(0, () => resolve(server)))
}

const server = await serve(ROOT)
const port = server.address().port
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--hide-scrollbars",
    `--window-size=${PLATE_W},${PLATE_H}`,
  ],
})
const page = await browser.newPage()
await page.setViewport({ width: PLATE_W, height: PLATE_H, deviceScaleFactor: 1 })
const problems = []
page.on("pageerror", (e) => problems.push(e.message))
// ?fullscreen already drops the frame and the help line and gives the canvas the
// whole viewport, which is exactly the framing a plate wants. Only the on-screen
// buttons need hiding on top of that, and the HUD, which the view can skip.
await page.goto(`http://127.0.0.1:${port}/index.html?fullscreen`, { waitUntil: "load" })
await page.waitForFunction("window.__geometry !== undefined", { timeout: 20000 })
await page.addStyleTag({ content: ".hud-btns { display: none !important; }" })
await page.evaluate(() => {
  window.__geometry.view.showHud = false
  window.__geometry.view.resize(document.getElementById("game").getBoundingClientRect())
  // Stop the game driving itself. Its own loop would otherwise keep advancing
  // and repainting between a scene being posed and the shot being taken, which
  // ages every particle, fades the beam and finishes the warp that the icon is
  // supposed to be caught halfway through. One frame already in flight still
  // runs, hence the wait below.
  window.requestAnimationFrame = () => 0
})
await new Promise((r) => setTimeout(r, 150))

// ---- scene composition ----------------------------------------------------
// Each scene is built by driving the real simulation, then a plate is captured.
// Math.random is seeded while a scene is built so the same command gives the same
// artwork, rather than a different rock field every run.
await page.evaluate(async () => {
  const { mulberry32 } = await import("./src/math.js")
  const { Asteroid, RivalShip } = await import("./src/entities.js")
  const { ARENA, WEAPON_TYPES } = await import("./src/config.js")
  const { PALETTE } = await import("./src/palette.js")

  window.__art = {
    // Seeded while a scene is built, so the same command gives the same artwork
    // rather than a fresh rock field every run.
    seeded(seed, build) {
      const rng = mulberry32(seed)
      const real = Math.random
      Math.random = rng
      try {
        build()
      } finally {
        Math.random = real
      }
    },

    // A live sector with the ship solid and at the centre of the view. The ship
    // stays near the middle of the arena so the out-of-bounds hatching never
    // creeps into frame, and every placement below is relative to the camera.
    sector(game, sector) {
      game.startNewGame()
      game.startLevel(sector)
      game.phase = "play"
      game.asteroids = []
      game.rivals = []
      game.particles = []
      game.laserShots = []
      const player = game.player
      player.warp = 1
      player.warpTarget = 1
      player.warpHold = 0
      player.invincible = 0 // an invincible ship blinks, and may blink out of the frame
      player.x = ARENA.cx
      player.y = ARENA.cy
      player.vx = 0
      player.vy = 0
      game.viewCenter.x = player.x
      game.viewCenter.y = player.y
      return player
    },

    // Draw a ship bigger than life. A 13-unit hull is a speck on a banner, and
    // the outline is scale-free, so the art can simply ask for more of it.
    grow(ship, factor) {
      ship.setOutline(ship.outlineLocal, ship.size * factor)
      ship.radius = (ship.radius || ship.size) * factor
      return ship
    },

    rock(game, dx, dy, radius, traits = {}) {
      const rock = new Asteroid({
        x: game.viewCenter.x + dx,
        y: game.viewCenter.y + dy,
        radius,
        traits,
        vx: 0,
        vy: 0,
        spin: 0,
      })
      game.asteroids.push(rock)
      return rock
    },

    rival(game, type, dx, dy, angle, factor = 1) {
      const ship = new RivalShip(game.viewCenter.x + dx, game.viewCenter.y + dy, type, [])
      ship.angle = angle
      ship.lifeTimer = 1e9
      if (factor !== 1) {
        this.grow(ship, factor)
      }
      game.rivals.push(ship)
      return ship
    },

    // Cut something, and leave the beam on screen. applyBeam does the cutting;
    // the flash is normally pushed by whatever pulled the trigger.
    slice(game, fromX, fromY, angle, length = 700) {
      const dir = { x: Math.cos(angle), y: Math.sin(angle) }
      const from = { x: game.viewCenter.x + fromX, y: game.viewCenter.y + fromY }
      const beam = {
        a: { x: from.x, y: from.y },
        dir,
        b: { x: from.x + dir.x * length, y: from.y + dir.y * length },
      }
      game.applyBeam(beam, game.player, { type: WEAPON_TYPES.playerLaser })
      game.laserShots.push({
        beams: [beam],
        age: 0,
        color: PALETTE.player.beam,
        width: 5.5,
        glow: 34,
      })
      return beam
    },

    // Stop everything shooting, so settling frames cannot turn into a firefight
    // that damages the ship or fills the frame with stray bullets.
    disarm(game) {
      for (const host of [...game.rivals, ...game.asteroids]) {
        for (const hardpoint of host.hardpoints) {
          if (hardpoint.module && hardpoint.module.kind === "weapon") {
            hardpoint.module.cooldown = 1e9
            hardpoint.module.charging = 0
          }
        }
      }
    },

    // Let effects breathe. The phase is pinned because an all-but-empty field
    // would otherwise decide the sector is cleared and warp the ship out.
    settle(game, frames) {
      for (let i = 0; i < frames; i++) {
        this.disarm(game)
        game.phase = "play"
        game.advance(1 / 60)
        game.projectiles = []
      }
      game.screenShake = 0
      game.laserShots.forEach((shot) => (shot.age = 0)) // keep the beam at full brightness
    },
  }
})

// Plates are written into the served tree and loaded back by URL. Handing them
// to the page as data URLs instead fails once they run to megabytes: img.src
// rejects with a bare error Event and no diagnostic.
const PLATE_DIR = path.join(ROOT, ".art-plates")
fs.mkdirSync(PLATE_DIR, { recursive: true })

async function plate(name, build) {
  await page.evaluate(build)
  // only to let the compositor present; nothing is simulating now
  await new Promise((r) => setTimeout(r, 120))
  const canvas = await page.$("#game")
  const shot = await canvas.screenshot({ type: "png" })
  fs.writeFileSync(path.join(PLATE_DIR, `${name}.png`), shot)
  console.log(`  plate ${name}: ${(shot.length / 1024).toFixed(0)} kB`)
  return `/.art-plates/${name}.png`
}

console.log("capturing plates")

// A busy field for the header and the small capsule: rocks of every kind, a
// scout, and the ship cutting one open.
const wide = await plate("wide", () => {
  const game = window.__geometry.game
  window.__art.seeded(20260725, () => {
    const art = window.__art
    const player = art.grow(art.sector(game, 9), 3)
    player.angle = -0.3
    art.rock(game, -430, -230, 190)
    art.rock(game, 250, 260, 165, { gun: true })
    art.rock(game, 470, -215, 150, { explosive: true })
    art.rock(game, -300, 250, 120, { shield: true })
    art.rival(game, "scout", 330, 60, 2.9, 2.6)
    art.slice(game, 40, -12, -0.3) // through the big rock, up and to the right
    art.settle(game, 6)
    player.thrusting = true
    player.mainWeapon.charge = 460
  })
  window.__geometry.view.render(game)
})

// The hero: a sector coming apart at the seams. Deliberately zoomed out, with
// smaller subjects and more of them, so it reads as a busy field rather than a
// portrait of one ship.
const hero = await plate("hero", () => {
  const game = window.__geometry.game
  window.__art.seeded(7717, () => {
    const art = window.__art
    const player = art.grow(art.sector(game, 14), 1.7)
    player.angle = -0.1
    player.x -= 250
    game.viewCenter.x = player.x + 250
    player.invincible = 1e9 // a blast is going off; survive it, then stop blinking

    // A rock already cut, then the frigate opened up down its spine. Only the
    // second beam is still on screen: two full-length beams read as scratches
    // across the frame rather than as shots.
    art.rock(game, 60, 165, 115)
    art.slice(game, -250, 150, -0.03, 430)
    game.laserShots = []
    art.rival(game, "frigate", 250, -45, 0.04, 1.5)
    art.slice(game, -215, -34, 0.035, 620)

    // the rest of the field, and a scout in among it
    art.rock(game, -455, 150, 100)
    art.rock(game, -375, -145, 88)
    art.rock(game, -175, -215, 100, { gun: true })
    art.rock(game, -95, 245, 72)
    art.rock(game, 455, -195, 120, { shield: true })
    art.rock(game, 700, 70, 95)
    art.rival(game, "scout", 40, -160, 2.2, 1.6)

    // and an explosive rock going off, far enough away not to end the run
    const bomb = art.rock(game, 640, 190, 90, { explosive: true })
    art.settle(game, 8)
    bomb.detonate(game)
    art.settle(game, 13) // fire and embers spread, debris drifts

    for (let i = 0; i < 9; i++) {
      const angle = (i / 9) * Math.PI * 2
      game.spawnOre(
        game.viewCenter.x + Math.cos(angle) * 300,
        game.viewCenter.y + Math.sin(angle) * 165,
        Math.cos(angle) * 30,
        Math.sin(angle) * 30,
      )
    }
    player.thrusting = true
    player.mainWeapon.charge = 190 // a short charge glow, not a second long line
    player.invincible = 0
  })
  window.__geometry.view.render(game)
})

// Tall and narrow for the library grid: the portrait crop only sees the middle
// 430 units of the field, so everything is stacked up the centre.
const portrait = await plate("portrait", () => {
  const game = window.__geometry.game
  window.__art.seeded(31337, () => {
    const art = window.__art
    const player = art.grow(art.sector(game, 6), 3.4)
    player.angle = -Math.PI / 2 // facing up the frame
    player.y += 175
    game.viewCenter.y = player.y - 95
    art.rock(game, -10, -135, 165)
    art.rock(game, 140, 165, 105, { explosive: true })
    art.rock(game, -155, 45, 90, { gun: true })
    art.rock(game, -130, 255, 85)
    art.rock(game, 115, 295, 68, { gun: true })
    // From the nose, not from behind the ship: an origin below it puts the beam
    // straight through the hull and reads as a pole rather than a shot.
    art.slice(game, 0, 30, -Math.PI / 2, 400)
    art.settle(game, 8)
    player.thrusting = true
    player.mainWeapon.charge = 260
  })
  window.__geometry.view.render(game)
})

// The icon: the ship arriving. The two halves of that image come from different
// states and cannot both fall out of one warp value, so they are composed.
//
// PlayerShip.draw branches: below full presence it draws the portal and a hull
// swelling out of it, and only at full presence does it draw the true outline
// with its hexagonal shield. The screen ripple, meanwhile, is armed by the view
// from the same value, after the world has been painted. Drawing the ship as
// solid and restoring the low value straight afterwards gets the true shape and
// the shield from the one, and the ripple from the other.
const icon = await plate("icon", () => {
  const game = window.__geometry.game
  const { PALETTE } = window.__geometry
  window.__art.seeded(4242, () => {
    const art = window.__art
    const player = art.grow(art.sector(game, 4), 5.2)
    player.angle = -Math.PI / 2
    player.energy = player.energyMax
    player.invincible = 0 // an invincible ship blinks, and might blink out

    // Hold the arrival open for a while so the sparks that spiral in pile up.
    game.phase = "arriving"
    player.warpTarget = 1
    player.warpHold = 0
    for (let i = 0; i < 13; i++) {
      player.warp = 0.34
      game.advance(1 / 60) // a few sparks spiralling in, not a solid wheel of them
    }

    // The shockwave the arrival throws off, given long enough to open out into a
    // halo between the hull and the shield rather than a tight knot over it.
    game.ring(player.x, player.y, 30, PALETTE.player.hull, 430, 0.6)
    game.ring(player.x, player.y, 20, PALETTE.shield.spark, 300, 0.55)
    player.warp = 0.82 // ripple strength is 1 - warp: enough to feel, not to distort
    for (let i = 0; i < 13; i++) {
      game.advance(1 / 60)
      player.warp = 0.82
    }
    game.screenShake = 0

    const solidDraw = player.draw.bind(player)
    player.draw = (renderer, g) => {
      const arriving = player.warp
      player.warp = 1
      player.warpTarget = 1
      solidDraw(renderer, g)
      player.warp = arriving
      player.warpTarget = 1
    }
  })
  window.__geometry.view.render(game)
})

console.log("compositing assets")

// ---- compositing ----------------------------------------------------------
// Done in the page with canvas 2D: crops and scales for the landscape slots, a
// built-up composition for the portrait, and the vector logo for the alpha one.
const encoded = await page.evaluate(
  async ({ plates, assets, plateW, plateH }) => {
    const { drawVectorText } = await import("./src/font.js")
    const { PALETTE } = await import("./src/palette.js")

    const load = (url) =>
      new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error("could not load plate " + url))
        image.src = url
      })
    const images = {}
    for (const [name, url] of Object.entries(plates)) {
      images[name] = await load(url)
    }

    const surface = (w, h) => {
      const canvas = document.createElement("canvas")
      canvas.width = w
      canvas.height = h
      return { canvas, ctx: canvas.getContext("2d") }
    }

    // Cover-crop a plate into w x h, keeping `focusY` (0..1) in view. The plates
    // are 16:10 and every landscape slot is wider, so this trims top and bottom.
    const cover = (ctx, image, w, h, focusX = 0.5, focusY = 0.5) => {
      const scale = Math.max(w / plateW, h / plateH)
      const sw = w / scale
      const sh = h / scale
      const sx = (plateW - sw) * focusX
      const sy = (plateH - sh) * focusY
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, w, h)
    }

    // The neon logo, from the game's own glyphs. A GL frame is opaque, so this
    // goes through a canvas adapter that answers the one call the font makes.
    // Three passes stand in for the bloom: wide haze, mid glow, crisp core.
    const drawLogo = (ctx, cx, cy, height) => {
      const adapter = (widthScale, blur, alpha) => ({
        strokePoly(points, opts = {}) {
          ctx.save()
          ctx.globalAlpha = (opts.alpha ?? 1) * alpha
          ctx.strokeStyle = opts.color
          ctx.lineWidth = (opts.width ?? 1.6) * widthScale
          ctx.lineJoin = "round"
          ctx.lineCap = opts.cap || "round"
          if (blur) {
            ctx.shadowColor = opts.color
            ctx.shadowBlur = blur
          }
          ctx.beginPath()
          points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
          if (opts.closed !== false) {
            ctx.closePath()
          }
          ctx.stroke()
          ctx.restore()
        },
      })
      // the title screen tints the "II" differently; keep that
      const colourOf = (ch, i) => (i >= 9 ? PALETTE.ui.accentAlt : PALETTE.ui.accent)
      for (const [widthScale, blur, alpha] of [
        [2.4, height * 0.5, 0.34],
        [1.4, height * 0.18, 0.6],
        [1, height * 0.05, 1],
      ]) {
        drawVectorText(adapter(widthScale, blur, alpha), "GEOMETRY II", cx, cy, height, colourOf, 0)
      }
    }

    const out = {}
    for (const asset of assets) {
      const { canvas, ctx } = surface(asset.w, asset.h)
      if (asset.from === "wide") {
        cover(ctx, images.wide, asset.w, asset.h, 0.5, 0.46)
      } else if (asset.from === "hero") {
        cover(ctx, images.hero, asset.w, asset.h, 0.5, 0.48)
      } else if (asset.from === "icon") {
        // a square window on the middle of the frame, where the portal sits
        const side = plateH * 0.4
        ctx.drawImage(
          images.icon,
          (plateW - side) / 2,
          (plateH - side) / 2,
          side,
          side,
          0,
          0,
          asset.w,
          asset.h,
        )
      } else if (asset.from === "portrait") {
        ctx.fillStyle = PALETTE.space
        ctx.fillRect(0, 0, asset.w, asset.h)
        // gameplay fills the frame, cropped to the central column
        cover(ctx, images.portrait, asset.w, asset.h, 0.5, 0.5)
        // darken the top so the logo sits on something quiet
        const shade = ctx.createLinearGradient(0, 0, 0, asset.h * 0.52)
        shade.addColorStop(0, "rgba(2,4,10,0.92)")
        shade.addColorStop(1, "rgba(2,4,10,0)")
        ctx.fillStyle = shade
        ctx.fillRect(0, 0, asset.w, asset.h * 0.52)
        drawLogo(ctx, asset.w / 2, asset.h * 0.13, asset.w / 11.6)
      } else if (asset.from === "logo") {
        drawLogo(ctx, asset.w / 2, asset.h / 2, asset.w / 10.9)
      }
      out[asset.file] = canvas.toDataURL("image/png").split(",")[1]
    }
    return out
  },
  { plates: { wide, hero, portrait, icon }, assets: ASSETS, plateW: PLATE_W, plateH: PLATE_H },
)

fs.mkdirSync(OUT, { recursive: true })
for (const asset of ASSETS) {
  const file = path.join(OUT, asset.file)
  fs.writeFileSync(file, Buffer.from(encoded[asset.file], "base64"))
  const kb = (fs.statSync(file).size / 1024).toFixed(0)
  console.log(
    `  ${asset.file.padEnd(14)} ${asset.w}x${asset.h}  ${kb.padStart(4)} kB  -> ${asset.slot}`,
  )
}

if (problems.length) {
  console.log("\npage errors:", problems)
}
fs.rmSync(PLATE_DIR, { recursive: true, force: true })
console.log(`\nwritten to ${path.relative(ROOT, OUT)}/`)
await browser.close()
server.close()
