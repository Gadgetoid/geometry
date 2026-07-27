// Capture the screenshots the README shows.
//
// Same idea as capture-steam-art.mjs, and for the same reason: the shots are
// taken from the real game through the real WebGL backend, so the bloom, the
// neon weights and the CRT curvature are the ones it ships with, and a change to
// the look is one command away from being shown.
//
// Scenes are posed by driving the simulation, with Math.random seeded so the same
// command gives the same pictures rather than a fresh rock field every run.
//
// Needs a browser and puppeteer-core, neither of which the game depends on:
//
//   npm install --no-save puppeteer-core
//   node tools/capture-screenshots.mjs
//
// Output lands in screenshots/.

import puppeteer from "puppeteer-core"
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const OUT = path.join(ROOT, "screenshots")

// Where to find a browser. CHROME overrides it.
const CHROME_CANDIDATES = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/var/lib/flatpak/app/org.chromium.Chromium/current/active/files/bin/chromium",
].filter(Boolean)

// The view is 1024x640, so that is the size a shot is honest at: anything larger
// is upscale, and the internal scene target downsamples into it cleanly.
const W = 1024
const H = 640

// One entry per shot. `sector` poses the run at that sector first; `build` then
// arranges the scene through window.__shot, which is set up in the page below.
const SHOTS = [
  {
    file: "sector.png",
    seed: 41207,
    caption: "a rock cut clean in half, early on",
    build: `(game, art) => {
      const player = art.sector(game, 3)
      art.hud(game, { score: 18240, ore: 26 })
      player.angle = -0.32
      // The rock the beam is drawn through, placed on its line so the shot lands
      // and the halves are already drifting apart when the plate is taken.
      art.rock(game, 330, -115, 104)
      art.rock(game, -250, -150, 88)
      art.rock(game, -120, 250, 72)
      art.hold(game, "thrust")
      art.slice(game, 20, -8, -0.32)
      art.settle(game, 14)
    }`,
  },
  {
    file: "hazards.png",
    seed: 8823,
    caption: "an armed rock, a shielded one and a scout closing in",
    build: `(game, art) => {
      const player = art.sector(game, 9)
      art.hud(game, { score: 96500, ore: 84, rival: 21400 })
      player.angle = 0.5
      art.hold(game, "thrust")
      art.rock(game, -300, -110, 104, { gun: true })
      art.rock(game, 300, 120, 96, { shield: true })
      art.rock(game, 40, 250, 78, { explosive: true })
      art.rival(game, "scout", 280, -180, 2.4)
      art.volley(game, 44)
    }`,
  },
  {
    file: "frigate.png",
    seed: 5514,
    caption: "a frigate closing in while an armed rock opens up",
    build: `(game, art) => {
      const player = art.sector(game, 16)
      art.hud(game, { score: 254900, ore: 12, rival: 88300 })
      player.angle = -2.55
      art.hold(game, "thrust")
      art.rock(game, -330, 170, 92)
      art.rock(game, 260, -230, 108, { gun: true })
      const frigate = art.rival(game, "frigate", 235, 120, 3.7)
      art.volley(game, 52)
      // Hold the cannon part way through its wind-up: the glow growing at the
      // muzzle is the cue to break the arc, and it is what the shot is about.
      // The countdown and its duration are both posed from the weapon's own
      // charge time, since the duration is only set once a charge has begun.
      for (const hp of frigate.hardpoints) {
        const weapon = hp.module
        if (weapon && weapon.kind === "weapon" && weapon.type.chargeTime) {
          weapon.chargeDuration = weapon.type.chargeTime
          weapon.charging = weapon.chargeDuration * 0.2 // most of the way through
        }
      }
    }`,
  },
  {
    file: "late-sector.png",
    seed: 3391,
    caption: "further out, where the sky has turned",
    build: `(game, art) => {
      const player = art.sector(game, 34)
      art.hud(game, { score: 611300, ore: 173, rival: 204700 })
      player.angle = -0.85
      art.hold(game, "thrust")
      art.rock(game, 300, -140, 100, { gun: true, shield: true })
      art.rock(game, -260, 170, 86, { explosive: true })
      art.rock(game, -60, -250, 70)
      art.rival(game, "seeker", -250, -170, 0.5)
      art.volley(game, 48)
    }`,
  },
  {
    file: "shop.png",
    seed: 1177,
    caption: "the shop between sectors, and what a cleared sector paid",
    build: `(game, art) => {
      art.sector(game, 7)
      art.hud(game, { score: 132600, ore: 218, rival: 40100 })
      // A run part way through spending: a bigger cell, which is also what earns
      // the special slots, and the second mark of the beam. What the run has found
      // is what the shop will sell it.
      game.upgrades.core = 2
      art.own(game, "laser", "playerLaserMk2")
      game.seenSpecials = new Set(["booster", "oreMagnet", "refuel"])
      // A sector actually finished, so the summary shows the bonuses it pays and
      // not the line about leaving one unfinished. The tally it reads is posed too,
      // since nothing was really shot at.
      game.stats = { shots: 46, hits: 39, damage: 210, ore: 122, mined: 17 }
      game.enterShop(true)
      game.shopSelection = 2
    }`,
  },
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
    `--window-size=${W},${H}`,
  ],
})
const page = await browser.newPage()
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 })
const problems = []
page.on("pageerror", (e) => problems.push(e.message))
// ?fullscreen drops the frame and the help line and gives the canvas the whole
// viewport, which is the framing a screenshot wants. The on-screen buttons are
// the only thing left to hide.
await page.goto(`http://127.0.0.1:${port}/index.html?fullscreen`, { waitUntil: "load" })
await page.waitForFunction("window.__geometry !== undefined", { timeout: 20000 })
await page.addStyleTag({ content: ".hud-btns { display: none !important; }" })
await page.evaluate(() => {
  window.__geometry.view.resize(document.getElementById("game").getBoundingClientRect())
  // Stop the game driving itself, so a posed scene is not aged by a frame that
  // lands between posing it and taking the shot.
  window.requestAnimationFrame = () => 0
})
await new Promise((r) => setTimeout(r, 150))

await page.evaluate(async () => {
  const { mulberry32 } = await import("./src/math.js")
  const { Asteroid, RivalShip } = await import("./src/entities.js")
  const { ARENA, HAZARD_TRAITS, yardOptions } = await import("./src/config.js")

  // What a hazard trait is, taken from the registry that spawns it, so a scene
  // asking for an armed rock gets whatever an armed rock currently is.
  const hazard = (name) => {
    const found = HAZARD_TRAITS.find((entry) => entry.traits[name])
    return found ? found.traits[name] : null
  }

  window.__shot = {
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

    // A live sector with the ship solid and centred, clear of the boundary so the
    // out-of-bounds hatching never creeps into frame.
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
      player.invincible = 0 // an invincible ship blinks, and may blink out of frame
      player.x = ARENA.cx
      player.y = ARENA.cy
      player.vx = 0
      player.vy = 0
      game.viewCenter.x = player.x
      game.viewCenter.y = player.y
      return player
    },

    // Hold a ship control down, the way a player would. Setting `thrusting` on
    // the ship instead would last until the next frame recomputed it from input,
    // which is to say not as far as the plume.
    hold(game, action) {
      for (const code of game.bindings.keys[action] || []) {
        game.pressedKeys.add(code)
      }
    },

    // A run in progress, so the HUD is not a row of zeros.
    hud(game, { score = 0, ore = 0, rival = 0 }) {
      game.score = score
      game.oreBalance = ore
      game.rivalScore = rival
    },

    rock(game, dx, dy, radius, want = {}) {
      const traits = {}
      if (want.explosive) {
        traits.explosive = true
      }
      if (want.shield) {
        traits.shield = hazard("shield")
      }
      if (want.gun) {
        const gun = hazard("gun")
        traits.gun = gun && { ...gun, guns: game.gunsForSector(gun, game.level) }
      }
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

    // A rival carrying its design's own loadout. The loadout is left unstated
    // rather than passed empty: an empty one is still a loadout, and a hull given
    // it arrives with no guns, no drive and no core.
    rival(game, type, dx, dy, angle) {
      const ship = new RivalShip(game.viewCenter.x + dx, game.viewCenter.y + dy, type, null)
      ship.angle = angle
      ship.lifeTimer = 1e9
      game.rivals.push(ship)
      return ship
    },

    // Own an equipment option the way a run that had bought it would, and fit it.
    // A ladder is climbed in order, so every mark below the one asked for is owned
    // too, which is what the shop draws.
    own(game, slot, id) {
      const options = yardOptions(slot)
      const upTo = options.findIndex((option) => option.id === id)
      for (const option of options.slice(0, upTo + 1)) {
        if (!game.upgrades.owned[slot].includes(option.id)) {
          game.upgrades.owned[slot].push(option.id)
        }
      }
      game.fitEquipment(slot, id)
    },

    // Cut something and leave the beam on screen, the way the player's shot does.
    slice(game, fromX, fromY, angle, length = 700) {
      const dir = { x: Math.cos(angle), y: Math.sin(angle) }
      const from = { x: game.viewCenter.x + fromX, y: game.viewCenter.y + fromY }
      const to = { x: from.x + dir.x * length, y: from.y + dir.y * length }
      const beam = { a: from, b: to, dir }
      game.applyBeam(beam, game.player, game.player.mainWeapon)
      game.laserShots.push({
        beams: [beam],
        age: 0,
        color: game.player.mainWeapon.type.colour,
        width: 3,
        glow: 20,
        life: 0.5,
      })
    },

    // Every mounted gun off cooldown, so a turret fires within a frame or two of
    // settling rather than somewhere inside its 1 to 2 second reload.
    arm(game) {
      for (const host of [...game.asteroids, ...game.rivals]) {
        for (const hp of host.hardpoints || []) {
          if (hp.module && hp.module.kind === "weapon") {
            hp.module.cooldown = 0
          }
        }
      }
    },

    // Hold the ship whole. The rivals in these scenes are armed and aimed at a ship
    // parked in front of them, and fifty frames is long enough for one to finish it;
    // a plate of the player warping back in having lost a life is not the picture any
    // of these scenes are of. Invincibility is not used for it, since an invincible
    // ship blinks and may blink out of the frame the plate is taken on.
    whole(game, lives) {
      const player = game.player
      if (player) {
        player.hull = player.type.hull
        player.warp = 1
        player.warpTarget = 1
        player.warpHold = 0
      }
      game.lives = lives
    },

    // A scene with the shooting going on. Every gun is put back off cooldown a few
    // times a second, since one left to its own 1 to 2 second reload fires once and
    // the round is still on the muzzle when the shot is taken; this gives each
    // turret a spaced stream that reads as being fired at.
    volley(game, frames, { every = 9, keepLast = 30 } = {}) {
      const lives = game.lives
      for (let i = 0; i < frames; i++) {
        if (i % every === 0) {
          this.arm(game)
        }
        game.advance(1 / 60)
        this.whole(game, lives)
        if (i < frames - keepLast) {
          game.projectiles = []
        }
      }
      game.screenShake = 0
      game.laserShots.forEach((shot) => (shot.age = 0))
    },

    // Run the simulation on so contacts settle and debris has somewhere to be,
    // then stop the shake and hold every beam at full brightness.
    //
    // Shots are cleared as it runs, since a scene settling for half a second
    // otherwise fills with stray bullets, but the last few frames are kept: those
    // are the ones still near their muzzles, which is what reads as being fired at.
    settle(game, frames, keepLast = 10) {
      const lives = game.lives
      for (let i = 0; i < frames; i++) {
        game.advance(1 / 60)
        this.whole(game, lives)
        if (i < frames - keepLast) {
          game.projectiles = []
        }
      }
      game.screenShake = 0
      game.laserShots.forEach((shot) => (shot.age = 0))
    },
  }
})

fs.mkdirSync(OUT, { recursive: true })
console.log("capturing screenshots")
for (const shot of SHOTS) {
  await page.evaluate(
    (seed, source) => {
      const game = window.__geometry.game
      window.__shot.seeded(seed, () => {
        new Function("return " + source)()(game, window.__shot)
      })
      window.__geometry.view.render(game)
    },
    shot.seed,
    shot.build,
  )
  await new Promise((r) => setTimeout(r, 150)) // let the compositor present
  const canvas = await page.$("#game")
  const png = await canvas.screenshot({ type: "png" })
  fs.writeFileSync(path.join(OUT, shot.file), png)
  console.log(`  ${shot.file.padEnd(18)} ${W}x${H}  ${(png.length / 1024).toFixed(0)} kB`)
}

if (problems.length) {
  console.log("\npage errors:")
  for (const problem of problems) {
    console.log("  " + problem)
  }
}
console.log(`\nwritten to ${path.relative(ROOT, OUT)}/`)
await browser.close()
server.close()
