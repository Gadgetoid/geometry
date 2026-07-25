// The backdrop: nebula, planets, starfield, foreground stardust and the rocks
// drifting behind the title screen. Purely decorative, so it holds no gameplay
// state and nothing here can affect the simulation.
//
// Each sector's look is generated from a seeded PRNG, so the same sector number
// always produces the same worlds, and the base hue advances with the sector so
// the palette evolves as you travel. GameView reads these arrays directly.

import { VIEW_W, VIEW_H, TAU } from "./config.js"
import { randRange, randInt, mulberry32 } from "./math.js"
import { makeAsteroidPolygon } from "./entities.js"

const STAR_COUNT = 170
const DUST_COUNT = 90
const MENU_ROCK_COUNT = 7

// Planets live in a region larger than the viewport (so they sit well apart and
// only a couple are on screen at once) and wrap within it as they drift.
const PLANET_MARGIN_X = 560
const PLANET_MARGIN_Y = 380
const PLANET_COLS = 3
const PLANET_ROWS = 2

// Planet surface kinds, matching the uType switch in the planet shader.
const WORLD = { rocky: 0, volcanic: 1, inhabited: 2, gas: 3, ice: 4 }

// Palette for an ordinary world (rocky / gas / ice), tinted by the sector hue
// for cohesion. The rare emissive worlds are handled separately so there is at
// most one per sector. Returns { type, base, hi, atmo, emit }.
function ordinaryPalette(rng, baseHue) {
  const jitter = (h, d) => Math.round((((h + (rng() * 2 - 1) * d) % 360) + 360) % 360)
  const roll = rng()
  if (roll < 0.35) {
    // gas giant with banding
    const h = jitter(baseHue, 25)
    return {
      type: WORLD.gas,
      base: `hsl(${h} 34% 26%)`,
      hi: `hsl(${(h + 20) % 360} 40% 52%)`,
      atmo: `hsl(${h} 45% 60%)`,
      emit: "#000000",
    }
  }
  if (roll < 0.55) {
    // ice world (cool, high albedo)
    const h = jitter(210, 30)
    return {
      type: WORLD.ice,
      base: `hsl(${h} 20% 40%)`,
      hi: `hsl(${h} 14% 82%)`,
      atmo: `hsl(${h} 40% 78%)`,
      emit: "#000000",
    }
  }
  // rocky world tinted by the sector hue
  const h = jitter(baseHue, 35)
  return {
    type: WORLD.rocky,
    base: `hsl(${h} 26% 22%)`,
    hi: `hsl(${h} 30% 45%)`,
    atmo: `hsl(${(h + 30) % 360} 34% 58%)`,
    emit: "#000000",
  }
}

// The rare, cool worlds: volcanic (glowing lava) and inhabited (city lights).
function fancyPalette(type, baseHue, rng) {
  if (type === WORLD.volcanic) {
    return { type, base: "#241c18", hi: "#4a352a", atmo: "#7a3a24", emit: "#ff5a1e" }
  }
  const h = Math.round(baseHue + (rng() * 2 - 1) * 40 + 360) % 360
  return {
    type: WORLD.inhabited,
    base: `hsl(${h} 30% 15%)`,
    hi: `hsl(${h} 26% 30%)`,
    atmo: `hsl(${(h + 180) % 360} 40% 55%)`,
    emit: "#ffd98a",
  }
}

export class Backdrop {
  constructor() {
    this.stars = []
    for (let i = 0; i < STAR_COUNT; i++) {
      const depth = Math.pow(Math.random(), 1.6) * 0.88 + 0.12
      this.stars.push({
        x: Math.random() * VIEW_W,
        y: Math.random() * VIEW_H,
        depth,
        twinkle: Math.random() * TAU,
        vx: randRange(-2, 2),
        vy: randRange(-1.4, 1.4),
      })
    }
    // Foreground stardust: near, fast-parallax motes that streak past as the
    // ship moves, selling the sense of motion.
    this.dust = []
    for (let i = 0; i < DUST_COUNT; i++) {
      this.dust.push({
        x: Math.random() * VIEW_W,
        y: Math.random() * VIEW_H,
        z: randRange(0.55, 1), // parallax strength (near)
      })
    }
    this.regenSector(1) // planets + nebula for the title / first sector
    this.menuAsteroids = []
    for (let i = 0; i < MENU_ROCK_COUNT; i++) {
      const x = randRange(90, VIEW_W - 90),
        y = randRange(90, VIEW_H - 90)
      this.menuAsteroids.push({
        vertices: makeAsteroidPolygon(x, y, randRange(24, 50)),
        center: { x, y },
        spin: randRange(-0.4, 0.4),
        vx: randRange(-16, 16),
        vy: randRange(-12, 12),
        hue: randInt(0, 359),
      })
    }
  }

  // Rebuild the backdrop for a sector: a seeded palette so each sector has its
  // own repeatable vibe, evolving slowly as the base hue advances. Planets are
  // spread over a jittered grid so they never clump.
  regenSector(sector) {
    const rng = mulberry32((Math.imul(sector, 2654435761) ^ 0x9e3779b9) >>> 0)
    const rand = (a, b) => a + rng() * (b - a)
    const baseHue = (sector * 43) % 360 // advances each sector for slow evolution
    this.nebula = {
      colorA: `hsl(${baseHue} 45% 16%)`,
      colorB: `hsl(${(baseHue + 55) % 360} 40% 14%)`,
      seed: rand(0, 30),
    }

    const cellW = (VIEW_W + PLANET_MARGIN_X * 2) / PLANET_COLS
    const cellH = (VIEW_H + PLANET_MARGIN_Y * 2) / PLANET_ROWS
    const cells = []
    for (let cy = 0; cy < PLANET_ROWS; cy++) {
      for (let cx = 0; cx < PLANET_COLS; cx++) {
        cells.push([cx, cy])
      }
    }
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[cells[i], cells[j]] = [cells[j], cells[i]]
    }
    const count = 3 + Math.floor(rng() * 2) // 3-4, one per grid cell, well spaced
    // at most one rare emissive world per sector, and only sometimes
    const fancyRoll = rng()
    const fancyType =
      fancyRoll < 0.2 ? WORLD.volcanic : fancyRoll < 0.4 ? WORLD.inhabited : WORLD.rocky
    const fancySlot = fancyType ? Math.floor(rng() * count) : -1
    this.planets = []
    for (let i = 0; i < count; i++) {
      const [cx, cy] = cells[i]
      const pal =
        i === fancySlot ? fancyPalette(fancyType, baseHue, rng) : ordinaryPalette(rng, baseHue)
      this.planets.push({
        x: -PLANET_MARGIN_X + cx * cellW + rand(cellW * 0.2, cellW * 0.8),
        y: -PLANET_MARGIN_Y + cy * cellH + rand(cellH * 0.2, cellH * 0.8),
        r: rand(50, 120),
        depth: rand(0.05, 0.2), // far: barely parallaxes
        seed: rand(0, 20),
        light: rand(-Math.PI, Math.PI),
        drift: rand(2, 6),
        ...pal,
      })
    }
  }

  // Parallax the layers against the ship's velocity. Pass zero when the ship
  // isn't flying, so the backdrop settles.
  update(dt, shipVx, shipVy) {
    for (const d of this.dust) {
      // foreground: streaks past faster than the world (opposite to travel)
      d.x = wrap(d.x - shipVx * d.z * 1.2 * dt, VIEW_W)
      d.y = wrap(d.y - shipVy * d.z * 1.2 * dt, VIEW_H)
    }
    for (const star of this.stars) {
      // stream opposite to travel, scaled by depth (near stars move most)
      star.x = wrap(star.x + (star.vx - shipVx * star.depth * 0.5) * dt, VIEW_W)
      star.y = wrap(star.y + (star.vy - shipVy * star.depth * 0.5) * dt, VIEW_H)
    }
    for (const planet of this.planets) {
      // distant parallax: planets drift and stream slowly opposite to travel
      planet.x += (planet.drift * planet.depth - shipVx * planet.depth * 0.6) * dt
      planet.y += -shipVy * planet.depth * 0.6 * dt
      planet.x = wrapMargin(planet.x, VIEW_W, PLANET_MARGIN_X)
      planet.y = wrapMargin(planet.y, VIEW_H, PLANET_MARGIN_Y)
    }
  }

  // Title-screen rocks: spin, drift and wrap around the screen edges.
  updateMenu(dt) {
    for (const rock of this.menuAsteroids) {
      const cosA = Math.cos(rock.spin * dt),
        sinA = Math.sin(rock.spin * dt)
      for (const p of rock.vertices) {
        const dx = p.x - rock.center.x,
          dy = p.y - rock.center.y
        p.x = rock.center.x + dx * cosA - dy * sinA + rock.vx * dt
        p.y = rock.center.y + dx * sinA + dy * cosA + rock.vy * dt
      }
      rock.center.x += rock.vx * dt
      rock.center.y += rock.vy * dt
      if (rock.center.x < -70) {
        shiftRock(rock, VIEW_W + 140, 0)
      } else if (rock.center.x > VIEW_W + 70) {
        shiftRock(rock, -(VIEW_W + 140), 0)
      }
      if (rock.center.y < -70) {
        shiftRock(rock, 0, VIEW_H + 140)
      } else if (rock.center.y > VIEW_H + 70) {
        shiftRock(rock, 0, -(VIEW_H + 140))
      }
    }
  }
}

// Wrap a coordinate into [0, span).
function wrap(value, span) {
  if (value < 0) {
    return value + span
  }
  if (value > span) {
    return value - span
  }
  return value
}

// Wrap into [-margin, span + margin), the region planets are spread over.
function wrapMargin(value, span, margin) {
  if (value < -margin) {
    return value + span + margin * 2
  }
  if (value > span + margin) {
    return value - span - margin * 2
  }
  return value
}

function shiftRock(rock, dx, dy) {
  for (const p of rock.vertices) {
    p.x += dx
    p.y += dy
  }
  rock.center.x += dx
  rock.center.y += dy
}
