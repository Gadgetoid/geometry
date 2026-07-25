// GameView paints a Game with a Renderer. It owns the view transform (the
// letterboxed mapping of the virtual VIEW_W x VIEW_H space onto the canvas,
// plus screen shake) and composes each frame: world pass, then HUD / overlays.
// It only reads Game state, so a shader backend can be dropped in by swapping
// the Renderer without touching game logic. Entities still paint themselves via
// their own draw(renderer, game) methods.

import { VIEW_W, VIEW_H, TAU, ARENA, SHOP, POWERUP_TYPES } from "./config.js"
import { randRange, clamp, lerp } from "./math.js"
import { drawVectorText } from "./font.js"
import { PALETTE } from "./palette.js"

// Clip the infinite line (px,py)+s*(ux,uy) to the rect; returns the [s0,s1]
// range inside it, or null. Used to bound the out-of-bounds hatch to the view.
function clipLineToRect(px, py, ux, uy, x0, y0, x1, y1) {
  let s0 = -1e9,
    s1 = 1e9
  for (const [p, u, lo, hi] of [
    [px, ux, x0, x1],
    [py, uy, y0, y1],
  ]) {
    if (Math.abs(u) < 1e-9) {
      if (p < lo || p > hi) {
        return null
      }
    } else {
      let a = (lo - p) / u,
        b = (hi - p) / u
      if (a > b) {
        const t = a
        a = b
        b = t
      }
      s0 = Math.max(s0, a)
      s1 = Math.min(s1, b)
    }
  }
  return s1 > s0 ? { s0, s1 } : null
}

// Emit the parts of segment A->B that lie outside the circle.
function segmentOutsideCircle(ax, ay, bx, by, cx, cy, radius, emit) {
  const dx = bx - ax,
    dy = by - ay
  const fx = ax - cx,
    fy = ay - cy
  const a = dx * dx + dy * dy
  const b = 2 * (fx * dx + fy * dy)
  const c = fx * fx + fy * fy - radius * radius
  let disc = b * b - 4 * a * c
  if (disc <= 0 || a < 1e-9) {
    if (c > 0) {
      emit(ax, ay, bx, by) // wholly outside
    }
    return
  }
  disc = Math.sqrt(disc)
  const t1 = clamp((-b - disc) / (2 * a), 0, 1)
  const t2 = clamp((-b + disc) / (2 * a), 0, 1)
  if (t1 > 0) {
    emit(ax, ay, ax + dx * t1, ay + dy * t1)
  }
  if (t2 < 1) {
    emit(ax + dx * t2, ay + dy * t2, bx, by)
  }
}

export class GameView {
  constructor(renderer) {
    this.renderer = renderer
    this.dpr = 1
    this.scale = 1
    this.offsetX = 0
    this.offsetY = 0
  }

  resize(rect) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.renderer.canvas.width = Math.round(rect.width * this.dpr)
    this.renderer.canvas.height = Math.round(rect.height * this.dpr)
    this.scale = Math.min(rect.width / VIEW_W, rect.height / VIEW_H)
    this.offsetX = (rect.width - VIEW_W * this.scale) / 2
    this.offsetY = (rect.height - VIEW_H * this.scale) / 2
    if (this.renderer.setContentRect) {
      this.renderer.setContentRect(
        this.offsetX,
        this.offsetY,
        VIEW_W * this.scale,
        VIEW_H * this.scale,
        this.dpr,
      )
    }
  }

  // The world point shown at the centre of the view. Defaults to the middle of
  // the screen-sized world; when the arena is larger than the screen the view
  // follows the player (game.viewCenter).
  #center(game) {
    if (game.viewCenter) {
      return game.viewCenter
    }
    return { x: VIEW_W / 2, y: VIEW_H / 2 }
  }

  #cameras(game) {
    const shake = game.screenShake
    const sx = shake > 0 ? randRange(-shake, shake) : 0
    const sy = shake > 0 ? randRange(-shake, shake) : 0
    // slow cinematic sway; parallax between layers comes from per-object depth
    const panX = Math.sin(game.gameTime * 0.13) * 6
    const panY = Math.cos(game.gameTime * 0.17) * 4
    const c = this.#center(game)
    const base = {
      dpr: this.dpr,
      scale: this.scale,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
      clipW: VIEW_W,
      clipH: VIEW_H,
    }
    return {
      // background is screen-space (it scrolls via parallax, not the world camera)
      bg: { ...base, shakeX: sx, shakeY: sy, panX, panY },
      world: { ...base, shakeX: sx, shakeY: sy, panX, panY, centerX: c.x, centerY: c.y },
      hud: { ...base, shakeX: 0, shakeY: 0, panX: 0, panY: 0 },
    }
  }

  render(game) {
    const r = this.renderer,
      cam = this.#cameras(game)
    const c = this.#center(game)
    r.beginFrame(game.gameTime)
    r.clearFrame(PALETTE.space)

    // far background: nebula + planets (softened for depth of field)
    const neb = game.backdrop.nebula
    r.nebula(c.x, c.y, neb.colorA, neb.colorB, neb.seed)
    r.pushView(cam.bg)
    this.#planets(game)
    r.popView()
    r.compositeBackground()

    // stars sit in front of the depth-of-field blur so they stay sharp and bright
    r.pushView(cam.bg)
    this.#stars(game)
    r.popView()

    // world layer: arena, entities, effects (follows the ship)
    r.pushView(cam.world)
    if (game.phase === "title") {
      for (const rock of game.backdrop.menuAsteroids) {
        r.strokePoly(rock.vertices, { color: `hsl(${rock.hue} 85% 66%)`, width: 1.6, glow: 10 })
      }
    } else {
      this.#bounds(game)
      for (const chunk of game.oreChunks) {
        chunk.draw(r, game)
      }
      for (const asteroid of game.asteroids) {
        asteroid.draw(r, game)
      }
      for (const pickup of game.powerupPickups) {
        pickup.draw(r, game)
      }
      for (const rival of game.rivals) {
        rival.draw(r, game)
      }
      for (const projectile of game.projectiles) {
        projectile.draw(r, game)
      }
      this.#laserShots(game)
      this.#particles(game)
      if (game.phase === "play" || game.phase === "clearing") {
        game.player.draw(r, game)
      }
    }
    r.popView()

    // foreground stardust (screen-space, in front of gameplay)
    if (game.phase === "play" || game.phase === "clearing") {
      r.pushView(cam.bg)
      this.#dust(game)
      r.popView()
    }

    // HUD layer: screen-space, unshaken
    r.pushView(cam.hud)
    if (game.phase === "title") {
      this.#title(game)
    } else {
      this.#radar(game)
      this.#hud(game)
    }
    r.popView()
    r.endFrame()
  }

  #planets(game) {
    const r = this.renderer
    for (const p of game.backdrop.planets) {
      r.planet(p.x, p.y, p.r, {
        base: p.base,
        hi: p.hi,
        atmo: p.atmo,
        emit: p.emit,
        type: p.type,
        seed: p.seed,
        light: p.light,
        depth: p.depth,
      })
    }
  }

  // Foreground stardust streaks (screen-space, sharp, in front of gameplay).
  // Subtle: fades in with speed, so it only reads as motion when moving.
  #dust(game) {
    const r = this.renderer
    const pvx = game.player ? game.player.vx : 0
    const pvy = game.player ? game.player.vy : 0
    const speed = Math.hypot(pvx, pvy)
    const fade = clamp(speed / 260, 0, 1)
    if (fade < 0.02) {
      return // invisible when nearly still
    }
    for (const d of game.backdrop.dust) {
      r.line(d.x, d.y, d.x + pvx * d.z * 0.03, d.y + pvy * d.z * 0.03, {
        color: PALETTE.fx.dust,
        width: 1.1,
        glow: 4,
        alpha: 0.22 * d.z * fade,
        cap: "round",
      })
    }
  }

  #stars(game) {
    const r = this.renderer
    for (const star of game.backdrop.stars) {
      const twinkle = 0.55 + 0.45 * Math.sin(star.twinkle + game.gameTime * 1.5)
      const alpha = clamp((0.4 + 0.6 * star.depth) * twinkle, 0, 1)
      const size = star.depth * 2.6 + 0.7
      r.point(star.x, star.y, size, {
        color: `rgb(${lerp(170, 232, star.depth) | 0},${lerp(198, 240, star.depth) | 0},255)`,
        alpha,
        depth: star.depth,
      })
    }
  }

  // The circular arena boundary and the hatched out-of-bounds exterior, drawn
  // in world space so they scroll with the camera.
  #bounds(game) {
    const r = this.renderer
    const { cx, cy, radius } = ARENA

    // visible world rect (with a little slack for shake / sway)
    const c = game.viewCenter
    const pad = 60
    const x0 = c.x - VIEW_W / 2 - pad,
      x1 = c.x + VIEW_W / 2 + pad,
      y0 = c.y - VIEW_H / 2 - pad,
      y1 = c.y + VIEW_H / 2 + pad

    // nothing to hatch if the whole visible rect sits inside the arena
    const corners = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ]
    let farthest = 0
    for (const [px, py] of corners) {
      farthest = Math.max(farthest, Math.hypot(px - cx, py - cy))
    }
    if (farthest > radius) {
      const spacing = 26
      const nx = 0.7071,
        ny = -0.7071 // hatch line normal
      const ux = 0.7071,
        uy = 0.7071 // direction along each hatch line
      let dmin = 1e9,
        dmax = -1e9
      for (const [px, py] of corners) {
        const d = px * nx + py * ny
        dmin = Math.min(dmin, d)
        dmax = Math.max(dmax, d)
      }
      const emit = (sx, sy, ex, ey) =>
        r.line(sx, sy, ex, ey, { color: PALETTE.arena.boundary, width: 1.3, glow: 4, alpha: 0.45 })
      for (let d = Math.ceil(dmin / spacing) * spacing; d <= dmax; d += spacing) {
        const p0x = nx * d,
          p0y = ny * d
        const clip = clipLineToRect(p0x, p0y, ux, uy, x0, y0, x1, y1)
        if (!clip) {
          continue
        }
        segmentOutsideCircle(
          p0x + ux * clip.s0,
          p0y + uy * clip.s0,
          p0x + ux * clip.s1,
          p0y + uy * clip.s1,
          cx,
          cy,
          radius,
          emit,
        )
      }
    }

    // the boundary ring, pulsing gently
    const ring = []
    const seg = 96
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * TAU
      ring.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius })
    }
    const pulse = 0.75 + 0.25 * Math.sin(game.gameTime * 3)
    r.strokePoly(ring, {
      color: PALETTE.arena.boundary,
      width: 2,
      glow: 16,
      alpha: 0.85 * pulse,
      closed: true,
    })
  }

  // Off-screen asteroids and rivals as direction arrows around the screen edge.
  #radar(game) {
    if (game.phase !== "play" && game.phase !== "clearing") {
      return
    }
    const r = this.renderer
    const c = game.viewCenter
    const sx = VIEW_W / 2,
      sy = VIEW_H / 2
    const halfX = sx - 30,
      halfY = sy - 30
    const mark = (wx, wy, color, size = 9) => {
      const dx = wx - c.x,
        dy = wy - c.y
      if (Math.abs(dx) <= sx - 10 && Math.abs(dy) <= sy - 10) {
        return // on-screen: no marker
      }
      const ang = Math.atan2(dy, dx)
      const k = 1 / Math.max(Math.abs(dx) / halfX, Math.abs(dy) / halfY)
      const mx = sx + dx * k,
        my = sy + dy * k
      const dist = Math.hypot(dx, dy)
      const alpha = clamp(1 - (dist - VIEW_W / 2) / 1400, 0.28, 0.9)
      const tip = { x: mx + Math.cos(ang) * size, y: my + Math.sin(ang) * size }
      const la = { x: mx + Math.cos(ang + 2.5) * size, y: my + Math.sin(ang + 2.5) * size }
      const rb = { x: mx + Math.cos(ang - 2.5) * size, y: my + Math.sin(ang - 2.5) * size }
      r.strokePoly([tip, la, rb], { color, width: 1.6, glow: 8, alpha, closed: true })
    }
    for (const chunk of game.oreChunks) {
      mark(chunk.x, chunk.y, PALETTE.ore.body, 6)
    }
    for (const a of game.asteroids) {
      mark(a.center.x, a.center.y, a.explosive ? PALETTE.rock.explosive : PALETTE.rock.gun)
    }
    for (const rv of game.rivals) {
      if (!rv.dead) {
        mark(rv.x, rv.y, PALETTE.rival.hull)
      }
    }
  }

  #laserShots(game) {
    const r = this.renderer
    for (const shot of game.laserShots) {
      const life = shot.life || 0.4,
        alpha = 1 - shot.age / life
      const width = shot.width || 2.4
      const glow = shot.glow || 16
      for (const beam of shot.beams) {
        r.line(beam.a.x, beam.a.y, beam.b.x, beam.b.y, {
          color: shot.color,
          width,
          glow,
          alpha,
          cap: "round",
        })
      }
    }
  }

  #particles(game) {
    const r = this.renderer
    for (const q of game.particles) {
      const alpha = clamp(q.life / q.maxLife, 0, 1)
      r.line(q.x, q.y, q.x - q.vx * 0.03, q.y - q.vy * 0.03, {
        color: q.color,
        width: 1.6,
        glow: 8,
        alpha,
        cap: "round",
      })
    }
  }

  // ---- HUD + overlays --------------------------------------------------
  #hud(game) {
    const r = this.renderer
    r.text(`SCORE ${String(game.score).padStart(6, "0")}`, 18, 30, {
      size: 18,
      bold: true,
      color: PALETTE.text.bright,
    })
    r.text(`SECTOR ${game.level}   ROCKS ${game.asteroids.length}`, 18, 48, {
      size: 12,
      color: PALETTE.text.dim,
    })
    r.text(`ORE ${game.oreBalance}`, 18, 64, { size: 12, color: PALETTE.fx.flash })
    if (game.plan && game.plan.rivals > 0) {
      r.text(`RIVAL ${String(game.rivalScore).padStart(6, "0")}`, 18, 80, {
        size: 12,
        color: PALETTE.rival.hull,
      })
    }

    r.text("LIVES", VIEW_W - 18, 24, { size: 12, color: PALETTE.player.hull, align: "right" })
    for (let i = 0; i < game.lives; i++) {
      const x = VIEW_W - 24 - i * 22,
        y = 40
      r.strokePoly(
        [
          { x, y: y - 7 },
          { x: x - 8, y: y + 5 },
          { x, y: y + 2 },
          { x: x + 8, y: y + 5 },
        ],
        { color: PALETTE.player.hull, width: 1.5, glow: 6 },
      )
    }

    const barW = VIEW_W - 36,
      barX = 18,
      barY = VIEW_H - 26,
      barH = 12
    r.rect(barX, barY, barW, barH, { stroke: PALETTE.ui.edge, width: 1 })
    const fraction = game.player ? game.player.energy / game.maxEnergy() : 0
    const low = fraction < 0.22
    let fillW = barW * fraction
    if (low) {
      fillW = barW * fraction * (0.85 + 0.15 * Math.sin(game.gameTime * 10))
    }
    const barColour =
      game.player && game.player.buffTime("booster") > 0
        ? POWERUP_TYPES.booster.colour
        : low
          ? PALETTE.ui.warn
          : PALETTE.player.hull
    r.rect(barX + 1, barY + 1, Math.max(0, fillW - 2), barH - 2, { fill: barColour, glow: 10 })
    r.text("ENERGY", barX + 2, barY - 4, { size: 9, color: PALETTE.text.faint })

    // Shield: mark the offline / recovery energy levels and show online state.
    const shield = game.player ? game.player.shieldModule() : null
    if (shield) {
      const dropX = barX + barW * shield.type.dropAt
      const recoverX = barX + barW * shield.type.recoverAt
      r.line(dropX, barY - 2, dropX, barY + barH + 2, { color: PALETTE.ui.warn, width: 1 }) // offline level
      r.line(recoverX, barY - 2, recoverX, barY + barH + 2, {
        color: PALETTE.shield.spark,
        width: 1,
        alpha: 0.55,
      }) // recovery level
      // offline while overloaded, or whenever energy is at/below the drop marker
      // (below that the shield can't absorb a hit)
      const offline = !shield.up || game.player.energy <= shield.type.dropAt * game.player.energyMax
      r.text(offline ? "SHIELD OFFLINE" : "SHIELD", barX + 46, barY - 4, {
        size: 9,
        color: offline ? PALETTE.ui.warn : PALETTE.shield.spark,
      }) // beside ENERGY, clear of the powerup slots at the right edge
    }

    if (game.player) {
      const size = 20,
        count = game.upgrades.slots,
        startX = VIEW_W - 14 - count * (size + 4)
      for (let i = 0; i < count; i++) {
        const sx = startX + i * (size + 4),
          sy = barY - 4 - size,
          item = game.player.items[i]
        const spec = item ? POWERUP_TYPES[item] : null
        r.rect(sx, sy, size, size, {
          stroke: spec ? spec.colour : PALETTE.ui.slotEmpty,
          width: 1.2,
        })
        r.text(String(i + 1), sx + 2, sy + 9, { size: 8, color: PALETTE.text.muted })
        if (spec) {
          r.text(spec.icon, sx + size / 2, sy + size / 2 + 5, {
            size: 12,
            bold: true,
            color: spec.colour,
            align: "center",
          })
        }
      }
    }

    if (game.player) {
      let row = 0
      for (const [id, remaining] of game.player.buffs) {
        const spec = POWERUP_TYPES[id]
        r.text(`${spec.short || spec.label} ${remaining.toFixed(1)}s`, VIEW_W / 2, 26 + row * 15, {
          size: 11,
          color: spec.colour,
          align: "center",
        })
        row++
      }
    }

    if (game.toast) {
      r.text(game.toast.text, 18, VIEW_H - 72, {
        size: 12,
        color: PALETTE.ore.spark,
        glow: 8,
        alpha: clamp(game.toast.life / 0.6, 0, 1),
      })
    }

    // the ship sits at screen centre (camera follows), so warn just above it
    if (game.player && game.player.atBoundary && game.phase === "play") {
      r.text("OUT OF BOUNDS", VIEW_W / 2, VIEW_H / 2 - 42, {
        size: 14,
        bold: true,
        color: PALETTE.ui.warn,
        align: "center",
        glow: 10,
        alpha: 0.55 + 0.45 * Math.sin(game.gameTime * 9),
      })
    }

    if (game.phase === "clearing") {
      r.text("SECTOR CLEARED", VIEW_W / 2, VIEW_H / 2, {
        size: 26,
        bold: true,
        color: PALETTE.ui.good,
        align: "center",
        glow: 14,
      })
    }
    if (game.phase === "shop") {
      this.#shop(game)
    }
    if (game.phase === "over") {
      this.#gameOver(game)
    }
    if (game.paused) {
      this.#paused(game)
    }
  }

  #title(game) {
    const r = this.renderer
    drawVectorText(
      r,
      "GEOMETRY II",
      VIEW_W / 2,
      VIEW_H / 2 - 92,
      74,
      (ch, i) => (i >= 9 ? PALETTE.ui.accentAlt : PALETTE.ui.accent),
      18,
    )
    r.text(
      "Galactic Extraction Of Minerals, Europium, Thallium, Rare-earths & Yttrium",
      VIEW_W / 2,
      VIEW_H / 2 - 8,
      { size: 15, color: PALETTE.fx.flash, align: "center" },
    )
    r.text(
      "Slice asteroids, mine ore, balance your thrusters, shields and laser carefully!",
      VIEW_W / 2,
      VIEW_H / 2 + 30,
      { size: 13, color: PALETTE.text.dim, align: "center" },
    )
    r.text(
      "Clear every rock in the sector. Rinse. Repeat. You've got company.",
      VIEW_W / 2,
      VIEW_H / 2 + 52,
      { size: 13, color: PALETTE.text.dim, align: "center" },
    )
    r.text(
      `BEST   SCORE ${game.best.score}    SECTOR ${game.best.sector}`,
      VIEW_W / 2,
      VIEW_H / 2 + 82,
      { size: 12, color: PALETTE.ui.accent, align: "center" },
    )
    if (Math.floor(game.gameTime * 2) % 2 === 0) {
      r.text("PRESS ENTER", VIEW_W / 2, VIEW_H / 2 + 114, {
        size: 18,
        bold: true,
        color: PALETTE.ui.good,
        align: "center",
        glow: 14,
      })
    }
  }

  #shop(game) {
    const r = this.renderer,
      d = game.summaryData
    if (!d) {
      return
    }
    r.rect(0, 0, VIEW_W, VIEW_H, { fill: "rgba(2,4,10,.74)" })
    r.text(`SECTOR ${d.level} CLEARED`, VIEW_W / 2, 58, {
      size: 30,
      bold: true,
      color: PALETTE.ui.goodBright,
      align: "center",
      glow: 16,
    })
    r.text(
      `accuracy ${Math.round(d.accuracy * 100)}%    mined ${d.mined}    ore this run ${d.ore}    damage ${d.damage}    bonus +${d.totalBonus}`,
      VIEW_W / 2,
      82,
      { size: 12, color: PALETTE.text.dim, align: "center" },
    )
    r.text(`ORE  ${game.oreBalance}`, VIEW_W / 2, 112, {
      size: 20,
      bold: true,
      color: PALETTE.fx.flash,
      align: "center",
      glow: 12,
    })

    const leftX = VIEW_W / 2 - 250,
      rightX = VIEW_W / 2 + 250,
      top = 146,
      rowHeight = 32
    for (let i = 0; i < SHOP.length; i++) {
      const item = SHOP[i],
        y = top + i * rowHeight
      const selected = game.shopSelection === i,
        maxed = item.maxed(game),
        cost = item.cost(game),
        affordable = game.oreBalance >= cost && !maxed
      if (selected) {
        r.rect(leftX - 16, y - 18, rightX - leftX + 32, rowHeight - 4, {
          fill: "rgba(95,215,255,.12)",
        })
      }
      r.text(`${selected ? "> " : "  "}${item.name}`, leftX, y, {
        size: 15,
        bold: selected,
        color: maxed ? PALETTE.ui.good : selected ? PALETTE.text.bright : PALETTE.text.normal,
      })
      r.text(item.info(game), leftX + 206, y, { size: 11, color: PALETTE.text.faint })
      r.text(maxed ? "MAX" : game.devMode ? "FREE" : `${cost} ore`, rightX, y, {
        size: 14,
        color:
          maxed || game.devMode
            ? PALETTE.ui.good
            : affordable
              ? PALETTE.fx.flash
              : PALETTE.text.disabled,
        align: "right",
      })
    }
    if (game.shopSelection < SHOP.length) {
      r.text(SHOP[game.shopSelection].desc, VIEW_W / 2, top + SHOP.length * rowHeight + 8, {
        size: 12,
        color: PALETTE.text.soft,
        align: "center",
      })
    }

    const launchY = top + SHOP.length * rowHeight + 42,
      launchSelected = game.shopSelection === SHOP.length
    if (launchSelected) {
      r.rect(VIEW_W / 2 - 190, launchY - 21, 380, 30, { fill: "rgba(87,227,154,.16)" })
    }
    r.text(
      `${launchSelected ? "> " : ""}LAUNCH TO SECTOR ${game.shopSector}`,
      VIEW_W / 2,
      launchY,
      {
        size: 18,
        bold: true,
        color: PALETTE.ui.goodBright,
        align: "center",
        glow: launchSelected ? 16 : 8,
      },
    )
    r.text("UP / DOWN select      ENTER buy or launch", VIEW_W / 2, launchY + 26, {
      size: 11,
      color: PALETTE.text.muted,
      align: "center",
    })
    if (game.devMode) {
      r.text(
        "DEV   LEFT / RIGHT choose sector (hold SHIFT for x10)   -   purchases are free",
        VIEW_W / 2,
        launchY + 44,
        { size: 11, color: PALETTE.ui.accentAlt, align: "center" },
      )
    }
  }

  #gameOver(game) {
    const r = this.renderer
    r.rect(0, 0, VIEW_W, VIEW_H, { fill: "rgba(2,4,10,.55)" })
    r.text("SHIP LOST", VIEW_W / 2, VIEW_H / 2 - 30, {
      size: 56,
      bold: true,
      color: PALETTE.ui.lost,
      align: "center",
      glow: 20,
    })
    r.text(`REACHED SECTOR ${game.level}   SCORE ${game.score}`, VIEW_W / 2, VIEW_H / 2 + 14, {
      size: 18,
      color: PALETTE.text.bright,
      align: "center",
    })
    if (game.plan && game.plan.rivals > 0) {
      r.text(`RIVAL HAUL  ${game.rivalScore}`, VIEW_W / 2, VIEW_H / 2 + 38, {
        size: 14,
        color: PALETTE.rival.hull,
        align: "center",
      })
    }
    const newBest = game.score >= game.best.score && game.score > 0
    r.text(
      `${newBest ? "NEW BEST   " : "BEST   "}SCORE ${game.best.score}    SECTOR ${game.best.sector}`,
      VIEW_W / 2,
      VIEW_H / 2 + 58,
      { size: 12, color: newBest ? PALETTE.ui.goodBright : PALETTE.ui.accent, align: "center" },
    )
    if (Math.floor(game.gameTime * 2) % 2 === 0) {
      r.text("PRESS ENTER TO RETRY", VIEW_W / 2, VIEW_H / 2 + 82, {
        size: 13,
        color: PALETTE.text.dim,
        align: "center",
      })
    }
  }

  #paused() {
    const r = this.renderer
    r.rect(0, 0, VIEW_W, VIEW_H, { fill: "rgba(2,4,10,.5)" })
    r.text("PAUSED", VIEW_W / 2, VIEW_H / 2, {
      size: 40,
      bold: true,
      color: PALETTE.text.bright,
      align: "center",
      glow: 16,
    })
  }
}
