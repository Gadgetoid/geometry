// The backdrop: nebula, planets, starfield, foreground stardust and the rocks
// drifting behind the title screen. Purely decorative, so it holds no gameplay
// state and nothing here can affect the simulation.
//
// Each sector's look is generated from a seeded PRNG, so the same sector number
// always produces the same worlds. How far out the sector is drives the whole
// palette: a run opens on cool, quiet space and arrives somewhere hostile,
// industrial and alien. See SKY below. GameView reads these arrays directly.

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
export const WORLD = {
  rocky: 0,
  volcanic: 1,
  inhabited: 2,
  gas: 3,
  ice: 4,
  forge: 5,
  alien: 6,
  shattered: 7,
}

// ---------------------------------------------------------------------------
// THE ARC - how far out a sector is, as 0 to 1, and everything that reads off
// it. A run opens on cool, quiet space and arrives somewhere hostile and alien;
// `arcSectors` is how long that takes, after which the sky holds where it is.
//
// Every pair below is [early, late] and is read at the arc, so retuning the
// whole progression is an edit to this table. A sector still wanders around the
// trend by `hueWander`, so neighbours differ and travel stays interesting; what
// changed from cycling the whole wheel every eight sectors is that the wander
// now rides on an anchor that goes somewhere.
// ---------------------------------------------------------------------------
export const SKY = {
  arcSectors: 40,
  // The anchor hue travels the short way from blue to ember, which passes
  // through violet and magenta rather than through green.
  hueEarly: 205,
  hueLate: 18,
  hueWander: 22,
  // The nebula's two colours. The gap between them opens with the arc, from
  // analogous and serene to two hues that genuinely oppose each other, and they
  // sit at different lightnesses so one reads as the highlight of the pair.
  // The shader multiplies these by the cloud mask and by 0.9 over a near-black
  // base, so they have to be well clear of black to read as two colours at all,
  // while staying a base layer the ship and the rocks sit in front of.
  //
  // A is the anchor and B the contrast. B starts as bright as A, so an early sky
  // is two serene tones of one idea, and ends darker, so a late sky is ember with
  // a cold accent in its shadows rather than the other way about.
  nebulaGap: [40, 165],
  nebulaSatA: [42, 62],
  nebulaLightA: [20, 19],
  nebulaSatB: [34, 52],
  nebulaLightB: [18, 12],
  // Glowing worlds are what a late sector has more of. Bloom is the limit, and the
  // third is only affordable because what is lit by the end is mostly alien: a web of
  // veins rather than a hemisphere of lava.
  emissiveCap: [1, 3],
  // Planet radius, by class. A late sector is more likely to have something
  // looming in it; one giant at a time, since the grid is only so wide.
  sizes: [
    { r: [30, 55], depth: [0.05, 0.1], weight: [1.5, 1.5] },
    { r: [60, 110], depth: [0.08, 0.16], weight: [3, 2] },
    { r: [150, 220], depth: [0.14, 0.22], weight: [0.35, 1.6], giant: true },
  ],
}

// What kinds of world a sector may roll, and how heavily. `from` holds a kind
// back until the arc reaches it, so the first sectors cannot turn up anything
// that belongs to the far end of the run.
const WORLDS = [
  { type: WORLD.ice, weight: [3, 0.2] },
  { type: WORLD.gas, weight: [3, 1] },
  { type: WORLD.rocky, weight: [2, 1] },
  { type: WORLD.inhabited, weight: [0.6, 0.35], emissive: true },
  { type: WORLD.volcanic, weight: [0.3, 1.5], emissive: true },
  { type: WORLD.forge, weight: [0, 2], from: 0.3, emissive: true },
  { type: WORLD.shattered, weight: [0, 1.5], from: 0.5, emissive: true },
  // The far end of a run belongs to them: over half of what a sector 40 sky rolls.
  { type: WORLD.alien, weight: [0, 8], from: 0.5, emissive: true },
]

const lerp = (from, to, t) => from + (to - from) * t
const at = (pair, arc) => lerp(pair[0], pair[1], arc)
const wrapHue = (h) => ((h % 360) + 360) % 360

// The short way round from one hue to another, so the anchor does not sweep
// backwards through half the wheel to get where it is going.
function lerpHue(from, to, t) {
  let delta = wrapHue(to - from)
  if (delta > 180) {
    delta -= 360
  }
  return wrapHue(from + delta * t)
}

// Draw from a set of [early, late] weights at this arc. Anything held back by
// `from`, or weighted to nothing, cannot come up.
function weightedPick(entries, arc, rng) {
  const pool = entries.filter((entry) => arc >= (entry.from ?? 0) && at(entry.weight, arc) > 0)
  const total = pool.reduce((sum, entry) => sum + at(entry.weight, arc), 0)
  let roll = rng() * total
  for (const entry of pool) {
    roll -= at(entry.weight, arc)
    if (roll <= 0) {
      return entry
    }
  }
  return pool[pool.length - 1]
}

// A world's colours. Most take the sector's anchor hue so the sky hangs
// together; the ones that are meant to unsettle deliberately do not.
function worldPalette(type, anchor, arc, rng) {
  const jitter = (h, d) => Math.round(wrapHue(h + (rng() * 2 - 1) * d))
  if (type === WORLD.gas) {
    const h = jitter(anchor, 25)
    return {
      base: `hsl(${h} ${Math.round(at([34, 26], arc))}% ${Math.round(at([26, 20], arc))}%)`,
      hi: `hsl(${wrapHue(h + 20)} 40% ${Math.round(at([52, 38], arc))}%)`,
      atmo: `hsl(${h} 45% ${Math.round(at([60, 44], arc))}%)`,
      emit: "#000000",
    }
  }
  if (type === WORLD.ice) {
    // Cool and high-albedo whatever the sector, which is why it belongs to the
    // opening: it is the one world that does not take the anchor at all.
    const h = jitter(210, 30)
    return {
      base: `hsl(${h} 20% 40%)`,
      hi: `hsl(${h} 14% 82%)`,
      atmo: `hsl(${h} 40% 78%)`,
      emit: "#000000",
    }
  }
  if (type === WORLD.volcanic) {
    return { base: "#241c18", hi: "#4a352a", atmo: "#7a3a24", emit: "#ff5a1e" }
  }
  if (type === WORLD.inhabited) {
    const h = jitter(anchor, 40)
    return {
      base: `hsl(${h} 30% 15%)`,
      hi: `hsl(${h} 26% 30%)`,
      atmo: `hsl(${wrapHue(h + 180)} 40% 55%)`,
      emit: "#ffd98a",
    }
  }
  if (type === WORLD.forge) {
    // Industry: soot over a furnace. Barely tinted by the sector, since what
    // colours it is what is being done to it.
    const h = jitter(anchor, 12)
    return {
      base: `hsl(${h} 8% 12%)`,
      hi: `hsl(${h} 12% 26%)`,
      atmo: `hsl(30 50% 30%)`,
      emit: "#ffa32e", // amber, so it reads as worked rather than molten
    }
  }
  if (type === WORLD.alien) {
    // Wrong on purpose: not the sector's hue but one of two bands that belong to
    // nothing else out here. Both are far from the ember sky they hang in, and
    // both stay clear of the player's cyan, which the ship and the HUD own.
    //
    // Which of the two comes up follows the arc, so the last stretch of a run is
    // overwhelmingly the green one: the same green the faction flying around in
    // front of it is drawn, burns and shoots in.
    if (rng() < 0.5 + 0.7 * (arc - 0.5)) {
      // Sickly rather than verdant: a drained, barely lit body under an acid glow,
      // so it reads as something wrong and not as somewhere that grows things.
      const h = jitter(112, 12)
      return {
        base: `hsl(${h} 26% 12%)`,
        hi: `hsl(${wrapHue(h - 8)} 38% 27%)`,
        atmo: `hsl(${wrapHue(h - 4)} 70% 44%)`,
        emit: `hsl(${wrapHue(h - 22)} 92% 52%)`,
      }
    }
    const h = jitter(285, 25)
    return {
      base: `hsl(${h} 32% 14%)`,
      hi: `hsl(${wrapHue(h + 30)} 44% 32%)`,
      atmo: `hsl(${wrapHue(h + 40)} 60% 46%)`,
      emit: `hsl(${wrapHue(h + 50)} 80% 46%)`,
    }
  }
  if (type === WORLD.shattered) {
    // Dead: rock, a split crust, and a core still cooling inside the cracks.
    const h = jitter(anchor, 20)
    return {
      base: `hsl(${h} 10% 15%)`,
      hi: `hsl(${h} 14% 34%)`,
      atmo: `hsl(${h} 18% 22%)`, // almost no rim, so the silhouette stays hard
      emit: "#c2331a", // deep and dim: cooling, not erupting
    }
  }
  // rocky, tinted by the sector hue
  const h = jitter(anchor, 35)
  return {
    base: `hsl(${h} 26% ${Math.round(at([22, 17], arc))}%)`,
    hi: `hsl(${h} 30% ${Math.round(at([45, 34], arc))}%)`,
    atmo: `hsl(${wrapHue(h + 30)} 34% ${Math.round(at([58, 42], arc))}%)`,
    emit: "#000000",
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
  // own repeatable vibe, and everything about that vibe read off how far out the
  // sector is (see SKY). Planets are spread over a jittered grid so they never
  // clump.
  regenSector(sector) {
    const rng = mulberry32((Math.imul(sector, 2654435761) ^ 0x9e3779b9) >>> 0)
    const rand = (a, b) => a + rng() * (b - a)
    const arc = Math.max(0, Math.min(1, sector / SKY.arcSectors))
    // The trend, and this sector's wander around it.
    const anchor = wrapHue(
      lerpHue(SKY.hueEarly, SKY.hueLate, arc) + (rng() * 2 - 1) * SKY.hueWander,
    )
    const gap = at(SKY.nebulaGap, arc)
    this.nebula = {
      colorA: `hsl(${Math.round(anchor)} ${Math.round(at(SKY.nebulaSatA, arc))}% ${Math.round(at(SKY.nebulaLightA, arc))}%)`,
      colorB: `hsl(${Math.round(wrapHue(anchor + gap))} ${Math.round(at(SKY.nebulaSatB, arc))}% ${Math.round(at(SKY.nebulaLightB, arc))}%)`,
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
    let emissiveLeft = Math.round(at(SKY.emissiveCap, arc))
    let giantLeft = 1
    this.planets = []
    for (let i = 0; i < count; i++) {
      const [cx, cy] = cells[i]
      // A glowing world once the sky has had its fill of them is an ordinary one
      // instead, so the cap never costs the sector a planet.
      const kind = weightedPick(
        WORLDS.filter((entry) => !entry.emissive || emissiveLeft > 0),
        arc,
        rng,
      )
      if (kind.emissive) {
        emissiveLeft--
      }
      const size = weightedPick(
        SKY.sizes.filter((entry) => !entry.giant || giantLeft > 0),
        arc,
        rng,
      )
      if (size.giant) {
        giantLeft--
      }
      this.planets.push({
        x: -PLANET_MARGIN_X + cx * cellW + rand(cellW * 0.2, cellW * 0.8),
        y: -PLANET_MARGIN_Y + cy * cellH + rand(cellH * 0.2, cellH * 0.8),
        r: rand(size.r[0], size.r[1]),
        // A bigger world sits nearer, so it parallaxes like one.
        depth: rand(size.depth[0], size.depth[1]),
        seed: rand(0, 20),
        light: rand(-Math.PI, Math.PI),
        drift: rand(2, 6),
        type: kind.type,
        ...worldPalette(kind.type, anchor, arc, rng),
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
