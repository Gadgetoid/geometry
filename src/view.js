// GameView paints a Game with a Renderer. It owns the view transform (the
// letterboxed mapping of the virtual VIEW_W x VIEW_H space onto the canvas,
// plus screen shake) and composes each frame: world pass, then HUD / overlays.
// It only reads Game state, so a shader backend can be dropped in by swapping
// the Renderer without touching game logic. Entities still paint themselves via
// their own draw(renderer, game) methods.

import {
  VIEW_W,
  VIEW_H,
  TAU,
  ARENA,
  SHOP,
  SHOP_LAYOUT,
  MAX_SLOTS,
  SPECIAL_TYPES,
} from "./config.js"
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

// The first `fraction` of a box's outline, as a polyline starting at the top left
// and running clockwise. Used to walk a countdown round a HUD box.
function boxPerimeter(x, y, w, h, fraction) {
  const corners = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
    { x, y },
  ]
  const total = 2 * (w + h)
  let want = total * fraction
  const points = [corners[0]]
  for (let i = 1; i < corners.length; i++) {
    const from = corners[i - 1],
      to = corners[i]
    const side = Math.hypot(to.x - from.x, to.y - from.y)
    if (want >= side) {
      points.push(to)
      want -= side
      continue
    }
    const t = side > 0 ? want / side : 0
    points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    break
  }
  return points
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
    // Clear this to paint the world without the HUD, radar or overlays, which is
    // what tools/capture-steam-art.mjs wants from a frame.
    this.showHud = true
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

  // Name a control the way the device in the player's hands names it. Game
  // tracks which was last used, so a pad player is never told to press ENTER.
  #prompt(game, keyboard, gamepad) {
    return game.inputMode === "gamepad" ? gamepad : keyboard
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
      for (const pickup of game.specialPickups) {
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
      if (game.inSector()) {
        game.player.draw(r, game)
      }
    }
    r.popView()

    // foreground stardust (screen-space, in front of gameplay)
    if (game.inSector()) {
      r.pushView(cam.bg)
      this.#dust(game)
      r.popView()
    }

    // HUD layer: screen-space, unshaken
    r.pushView(cam.hud)
    if (game.phase === "title") {
      this.#title(game)
    } else if (this.showHud) {
      this.#radar(game)
      this.drawHud(game)
    }
    r.popView()
    this.#warp(game, c)
    r.endFrame()
  }

  // Point the screen-space ripple at the ship while it warps. The scene target
  // has its origin at the bottom, so the vertical coordinate is flipped.
  // Strength peaks when the ship is least present, which includes the pause
  // before a respawn: the portal shimmers open before anything arrives.
  #warp(game, centre) {
    const p = game.player
    // The ripple is a screen-space pass over the finished frame, so it bends the HUD
    // and the pause menu along with the world. Pausing mid-arrival would otherwise
    // leave the menu rippling, and gameTime keeps running while paused so it would
    // not even hold still. The world is frozen anyway, so the distortion goes with it.
    if (!p || !game.inSector() || p.warp >= 1 || game.paused) {
      this.renderer.setWarp(0, 0, 0)
      return
    }
    const screenX = VIEW_W / 2 + (p.x - centre.x)
    const screenY = VIEW_H / 2 + (p.y - centre.y)
    this.renderer.setWarp(screenX / VIEW_W, 1 - screenY / VIEW_H, 1 - p.warp)
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
    if (!game.inSector()) {
      return
    }
    const r = this.renderer
    const c = game.viewCenter
    const sx = VIEW_W / 2,
      sy = VIEW_H / 2
    const halfX = sx - 30,
      halfY = sy - 30
    // What the ship's own radar reaches, per kind. Marking something the hull
    // cannot detect would be the HUD knowing more than the ship does.
    const player = game.player
    const mark = (wx, wy, color, size = 9, reach = Infinity) => {
      const dx = wx - c.x,
        dy = wy - c.y
      if (Math.abs(dx) <= sx - 10 && Math.abs(dy) <= sy - 10) {
        return // on-screen: no marker
      }
      if (Math.hypot(wx - player.x, wy - player.y) > reach) {
        return // out of range: the ship does not know it is there
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
    const sees = (what) => player.sensorRange(what)
    for (const chunk of game.oreChunks) {
      mark(chunk.x, chunk.y, PALETTE.ore.body, 6, sees("ore"))
    }
    for (const a of game.asteroids) {
      const colour = a.explosive ? PALETTE.rock.explosive : PALETTE.rock.gun
      mark(a.center.x, a.center.y, colour, 9, sees("rocks"))
    }
    for (const pickup of game.specialPickups) {
      mark(pickup.x, pickup.y, SPECIAL_TYPES[pickup.type].colour, 7, sees("specials"))
    }
    for (const rv of game.rivals) {
      if (!rv.dead) {
        mark(rv.x, rv.y, PALETTE.rival.hull, 9, sees("ships"))
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
  // The HUD pass, called by render once the world is drawn. In-game readouts, at
  // the size the player has asked for. Everything here is
  // anchored to a screen edge and grows inward from it, so raising the scale makes
  // the readouts bigger without moving them off the page. The menus drawn at the
  // end are left alone: they already fill the screen.
  drawHud(game) {
    const r = this.renderer
    const ui = game.settings.uiScale
    const margin = 18 * ui

    r.text(`SCORE ${String(game.score).padStart(6, "0")}`, margin, 30 * ui, {
      size: 18 * ui,
      bold: true,
      color: PALETTE.text.bright,
    })
    r.text(`SECTOR ${game.level}   ROCKS ${game.asteroids.length}`, margin, 48 * ui, {
      size: 12 * ui,
      color: PALETTE.text.dim,
    })
    r.text(`ORE ${game.oreBalance}`, margin, 64 * ui, { size: 12 * ui, color: PALETTE.fx.flash })
    if (game.plan && game.plan.rivals > 0) {
      r.text(`RIVAL ${String(game.rivalScore).padStart(6, "0")}`, margin, 80 * ui, {
        size: 12 * ui,
        color: PALETTE.rival.hull,
      })
    }

    r.text("LIVES", VIEW_W - margin, 24 * ui, {
      size: 12 * ui,
      color: PALETTE.player.hull,
      align: "right",
    })
    for (let i = 0; i < game.lives; i++) {
      const x = VIEW_W - (24 + i * 22) * ui,
        y = 40 * ui
      r.strokePoly(
        [
          { x, y: y - 7 * ui },
          { x: x - 8 * ui, y: y + 5 * ui },
          { x, y: y + 2 * ui },
          { x: x + 8 * ui, y: y + 5 * ui },
        ],
        { color: PALETTE.player.hull, width: 1.5 * ui, glow: 6 },
      )
    }

    // The bar keeps the full width of the page at any scale; what grows is how
    // deep it is and how far off the bottom edge it sits.
    const barW = VIEW_W - 36 * ui,
      barX = margin,
      barY = VIEW_H - 26 * ui,
      barH = 12 * ui
    r.rect(barX, barY, barW, barH, { stroke: PALETTE.ui.edge, width: 1 * ui })
    const fraction = game.player ? game.player.energy / game.maxEnergy() : 0
    const low = fraction < 0.22
    let fillW = barW * fraction
    if (low) {
      fillW = barW * fraction * (0.85 + 0.15 * Math.sin(game.gameTime * 10))
    }
    // a special that tints the ship tints its energy bar to match
    const tint = game.player ? game.player.buffWith("tintsShip") : null
    const barColour = tint ? tint.colour : low ? PALETTE.ui.warn : PALETTE.player.hull
    r.rect(barX + ui, barY + ui, Math.max(0, fillW - 2 * ui), barH - 2 * ui, {
      fill: barColour,
      glow: 10,
    })
    r.text("ENERGY", barX + 2 * ui, barY - 4 * ui, {
      size: 9 * ui,
      color: PALETTE.text.faint,
    })

    // Shield: mark the offline / recovery energy levels and show online state.
    const shield = game.player ? game.player.shieldModule() : null
    if (shield) {
      const dropX = barX + barW * shield.type.dropAt
      const recoverX = barX + barW * shield.type.recoverAt
      r.line(dropX, barY - 2 * ui, dropX, barY + barH + 2 * ui, {
        color: PALETTE.ui.warn,
        width: 1 * ui,
      }) // offline level
      r.line(recoverX, barY - 2 * ui, recoverX, barY + barH + 2 * ui, {
        color: PALETTE.shield.spark,
        width: 1 * ui,
        alpha: 0.55,
      }) // recovery level
      // offline while overloaded, or whenever energy is at/below the drop marker
      // (below that the shield can't absorb a hit)
      const offline = !shield.up || game.player.energy <= shield.type.dropAt * game.player.energyMax
      r.text(offline ? "SHIELD OFFLINE" : "SHIELD", barX + 46 * ui, barY - 4 * ui, {
        size: 9 * ui,
        color: offline ? PALETTE.ui.warn : PALETTE.shield.spark,
      }) // beside ENERGY, clear of the special slots at the right edge
    }

    if (game.player) {
      const size = 20 * ui,
        gap = 4 * ui,
        count = game.specialSlots(),
        startX = VIEW_W - 14 * ui - count * (size + gap)
      for (let i = 0; i < count; i++) {
        const sx = startX + i * (size + gap),
          sy = barY - 4 * ui - size,
          item = game.player.items[i]
        const spec = item ? SPECIAL_TYPES[item.id] : null
        r.rect(sx, sy, size, size, {
          stroke: spec ? spec.colour : PALETTE.ui.slotEmpty,
          width: 1.2 * ui,
          alpha: spec && item.cooldown > 0 ? 0.35 : 1,
        })
        // A slot recovering, or running a timed effect, walks a bar back round its
        // own outline, so how long is left is read off the box it belongs to.
        if (spec) {
          const running = game.player.buffTime(item.id)
          const left =
            running > 0 ? running / spec.seconds : spec.cooldown ? item.cooldown / spec.cooldown : 0
          if (left > 0) {
            r.strokePoly(boxPerimeter(sx, sy, size, size, clamp(left, 0, 1)), {
              color: running > 0 ? spec.colour : PALETTE.ui.accent,
              width: 2 * ui,
              glow: 8,
              closed: false,
            })
          }
          // Switched on and drawing on the cell, which has no end until it is
          // switched off again, so it pulses instead of counting anything down.
          if (item.active) {
            const pulse = 0.5 + 0.5 * Math.sin(game.gameTime * 6)
            r.rect(sx + ui, sy + ui, size - 2 * ui, size - 2 * ui, {
              fill: spec.colour,
              alpha: 0.22 + 0.2 * pulse,
            })
            r.rect(sx, sy, size, size, {
              stroke: spec.colour,
              width: 2 * ui,
              glow: 6 + 8 * pulse,
            })
          }
        }
        const label = game.slotLabel(i)
        r.text(label, sx + 2 * ui, sy + 9 * ui, { size: 8 * ui, color: PALETTE.text.muted })
        if (spec) {
          r.text(spec.icon, sx + size / 2, sy + size / 2 + 5 * ui, {
            size: 12 * ui,
            bold: true,
            color: spec.colour,
            align: "center",
            alpha: item.cooldown > 0 ? 0.45 : 1,
          })
        }
      }
    }

    if (game.player) {
      let row = 0
      for (const [id, remaining] of game.player.buffs) {
        const spec = SPECIAL_TYPES[id]
        r.text(
          `${spec.short || spec.label} ${remaining.toFixed(1)}s`,
          VIEW_W / 2,
          (26 + row * 15) * ui,
          { size: 11 * ui, color: spec.colour, align: "center" },
        )
        row++
      }
    }

    if (game.toast) {
      r.text(game.toast.text, margin, VIEW_H - 72 * ui, {
        size: 12 * ui,
        color: PALETTE.ore.spark,
        glow: 8,
        alpha: clamp(game.toast.life / 0.6, 0, 1),
      })
    }

    // the ship sits at screen centre (camera follows), so warn just above it
    if (game.player && game.player.atBoundary && game.canFly()) {
      r.text("OUT OF BOUNDS", VIEW_W / 2, VIEW_H / 2 - 42 * ui, {
        size: 14 * ui,
        bold: true,
        color: PALETTE.ui.warn,
        align: "center",
        glow: 10,
        alpha: 0.55 + 0.45 * Math.sin(game.gameTime * 9),
      })
    }

    if (game.phase === "clearing" || game.phase === "departing") {
      r.text("SECTOR CLEARED", VIEW_W / 2, VIEW_H / 2, {
        size: 26,
        bold: true,
        color: PALETTE.ui.good,
        align: "center",
        glow: 14,
      })
    }
    // The options overlay covers whatever is behind it, and the cleared screen is
    // dense enough to read through it. Draw one or the other, never both.
    if (game.phase === "shop" && !game.paused) {
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
    if (game.savedRun) {
      r.text(
        `CONTINUE FROM SECTOR ${game.resumeSector()}   -   reset it from the pause menu`,
        VIEW_W / 2,
        VIEW_H / 2 + 104,
        { size: 12, color: PALETTE.ui.good, align: "center" },
      )
    }
    // The prompt is the largest line here, so it sits clear of the one above it.
    // It also names what pressing it will do, since a saved run is carried on from
    // rather than replaced.
    if (Math.floor(game.gameTime * 2) % 2 === 0) {
      const prompt = game.savedRun
        ? this.#prompt(game, "PRESS ENTER TO CONTINUE", "PRESS A OR START TO CONTINUE")
        : this.#prompt(game, "PRESS ENTER TO START", "PRESS A OR START")
      r.text(prompt, VIEW_W / 2, VIEW_H / 2 + 140, {
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

    // The page is centred, so it clears the dev buttons along the top instead of
    // starting under them. Every offset below is measured from `blockTop`, and the
    // first and last of them are what the centring is worked out from, so a row added
    // to the shop moves the whole page up half a row instead of being estimated
    // around.
    const rowHeight = 36
    const headerHeight = 114 // the title, the stats and the ore, above the first row
    const titleOffset = 26
    const listHeight = (SHOP.length + 1) * rowHeight + SHOP_LAYOUT.groupGap
    const launchOffset = headerHeight + listHeight + 44
    const lastOffset = launchOffset + (game.devMode ? 28 : 0)
    const blockTop = Math.max(24, Math.round((VIEW_H - titleOffset - lastOffset) / 2))

    // A sector walked out of was not cleared, and the screen should not say it was.
    r.text(`SECTOR ${d.level} ${d.bailed ? "ABANDONED" : "CLEARED"}`, VIEW_W / 2, blockTop + 26, {
      size: 34,
      bold: true,
      color: d.bailed ? PALETTE.ui.warn : PALETTE.ui.goodBright,
      align: "center",
      glow: 16,
    })
    // A resumed run has no sector behind it in this session, so there are no
    // stats to report; only what was banked.
    r.text(
      d.resumed
        ? "carrying on from your last session"
        : d.bailed
          ? `mined ${d.mined}    ore this run ${d.ore}    damage ${d.damage}    -    no bonus for a sector left unfinished`
          : `accuracy ${Math.round(d.accuracy * 100)}%    mined ${d.mined}    ore this run ${d.ore}    damage ${d.damage}    bonus +${d.totalBonus}`,
      VIEW_W / 2,
      blockTop + 52,
      { size: 13, color: PALETTE.text.dim, align: "center" },
    )
    r.text(`ORE  ${game.oreBalance}`, VIEW_W / 2, blockTop + 84, {
      size: 23,
      bold: true,
      color: PALETTE.fx.flash,
      align: "center",
      glow: 12,
    })

    const leftX = VIEW_W / 2 - 262,
      rightX = VIEW_W / 2 + 262,
      top = blockTop + headerHeight
    // The purchases and the specials row share one column, so the running y is what
    // places the group gap and everything below the list.
    let y = top,
      slotsY = top
    for (let row = 0; row <= SHOP.length; row++) {
      const selected = game.shopSelection === row
      if (selected) {
        r.rect(leftX - 16, y - 20, rightX - leftX + 32, rowHeight - 4, {
          fill: "rgba(95,215,255,.12)",
        })
      }
      const item = game.shopItem(row)
      if (!item) {
        slotsY = y
        // The specials row is the last of what the core carries, so it is inset with
        // the shield and the radar and the gap falls under the group.
        this.#shopSlots(game, leftX + SHOP_LAYOUT.insetBy, rightX, y, selected)
        y += rowHeight + SHOP_LAYOUT.groupGap
        continue
      }
      const maxed = item.maxed(game),
        cost = item.cost(game),
        affordable = game.oreBalance >= cost && !maxed
      // A row that opens a pop-over has no price of its own: what it costs depends on
      // which option is chosen in there, so the column marks it as a way in instead.
      const opens = !!(item.equipment || item.levels)
      r.text(
        `${selected ? "> " : "  "}${item.name}`,
        leftX + (item.inset ? SHOP_LAYOUT.insetBy : 0),
        y,
        {
          size: 17,
          bold: selected,
          color: maxed ? PALETTE.ui.good : selected ? PALETTE.text.bright : PALETTE.text.normal,
        },
      )
      // The row a pop-over was opened from wears the panel's own outline, and the
      // panel hangs directly off it, so the two read as one thing rather than as a
      // box that happens to be nearby.
      const infoX = leftX + 226
      const openedHere =
        game.slotMenu &&
        ((item.equipment && item.equipment === game.slotMenu.equipment) ||
          (item.levels && item.id === game.slotMenu.levels))
      const fitted = item.info(game)
      if (openedHere) {
        const tabW = Math.max(66, fitted.length * 12 * 0.62 + 16)
        this.menuAnchor = { x: infoX - 8, y: y + 8, w: tabW }
        r.rect(this.menuAnchor.x, y - 15, tabW, 23, { fill: "rgba(95,215,255,.14)" })
        r.rect(this.menuAnchor.x, y - 15, tabW, 23, {
          stroke: PALETTE.ui.accent,
          width: 1.2,
          glow: 8,
        })
      }
      r.text(fitted, infoX, y, {
        size: 12,
        color: openedHere ? PALETTE.text.bright : PALETTE.text.faint,
      })
      const price = opens
        ? maxed
          ? "MAX"
          : ">"
        : maxed
          ? "MAX"
          : game.devMode
            ? "FREE"
            : `${cost} ore`
      r.text(price, rightX, y, {
        size: 16,
        color:
          maxed || (game.devMode && !opens)
            ? PALETTE.ui.good
            : opens
              ? PALETTE.text.faint
              : affordable
                ? PALETTE.fx.flash
                : PALETTE.text.disabled,
        align: "right",
      })
      y += rowHeight
    }

    const selectedItem = game.shopItem(game.shopSelection)
    const hint = selectedItem
      ? selectedItem.desc
      : game.shopSelection === game.slotsRow
        ? "What you carry into the next sector. Fit a slot, or buy and sell what is in one."
        : null
    if (hint) {
      r.text(hint, VIEW_W / 2, y + 10, { size: 13, color: PALETTE.text.soft, align: "center" })
    }

    // The last line holds both, sharing the column edges the rows above use: OPTIONS
    // left-aligned under the item names, LAUNCH right-aligned under the costs. Each
    // keeps the two-space placeholder the rows above use, so the cursor arrow
    // replaces it instead of shoving the text along.
    const launchY = y + 44,
      launchSelected = game.shopSelection === game.launchRow,
      optionsSelected = game.shopSelection === game.optionsRow
    const midX = (leftX + rightX) / 2
    if (optionsSelected) {
      r.rect(leftX - 16, launchY - 19, midX - leftX + 8, 28, { fill: "rgba(95,215,255,.12)" })
    }
    if (launchSelected) {
      r.rect(midX + 8, launchY - 19, rightX - midX + 8, 28, { fill: "rgba(87,227,154,.16)" })
    }
    r.text(`${optionsSelected ? "> " : "  "}OPTIONS`, leftX, launchY, {
      size: 15,
      bold: optionsSelected,
      color: optionsSelected ? PALETTE.text.bright : PALETTE.text.normal,
    })
    r.text(`${launchSelected ? "> " : "  "}LAUNCH TO SECTOR ${game.shopSector}`, rightX, launchY, {
      size: 18,
      bold: true,
      color: PALETTE.ui.goodBright,
      align: "right",
      glow: launchSelected ? 16 : 8,
    })
    // The dev line stays: free purchases and a sector you can walk to are not things
    // a player would look for, and the x10 modifier is not visible anywhere else.
    if (game.devMode) {
      r.text(
        this.#prompt(
          game,
          "DEV   LEFT / RIGHT choose sector (hold SHIFT for x10)   -   purchases are free",
          "DEV   DPAD LEFT / RIGHT choose sector   -   purchases are free",
        ),
        VIEW_W / 2,
        launchY + 28,
        { size: 11, color: PALETTE.ui.accentAlt, align: "center" },
      )
    }
    // Last, so the pop-over sits over the rows it is opened from.
    if (game.slotMenu) {
      this.#slotPopover(game, rightX, slotsY)
    }
  }

  // Where a special slot sits on the shop's right-hand column. The row and the
  // pop-over that opens on one both place themselves from here, so they line up.
  #slotBox(rightX, index) {
    const size = 26,
      spacing = 6,
      width = MAX_SLOTS * (size + spacing) - spacing
    return { x: rightX - width + index * (size + spacing), size }
  }

  // The specials row: the heading under the item names, the slots under the costs.
  // A slot the ship has not been fitted with is drawn faint but is still reachable,
  // since selecting it is how the next one is bought.
  #shopSlots(game, leftX, rightX, y, selected) {
    const r = this.renderer
    r.text(`${selected ? "> " : "  "}SPECIALS`, leftX, y, {
      size: 15,
      bold: selected,
      color: selected ? PALETTE.text.bright : PALETTE.text.normal,
    })
    for (let index = 0; index < MAX_SLOTS; index++) {
      const { x, size } = this.#slotBox(rightX, index),
        boxY = y - size + 7
      const owned = index < game.specialSlots(),
        spec = game.slotType(index),
        onCursor = selected && game.shopSlot === index
      if (onCursor) {
        r.rect(x - 3, boxY - 3, size + 6, size + 6, { fill: "rgba(95,215,255,.28)" })
      }
      r.rect(x, boxY, size, size, {
        stroke: spec ? spec.colour : PALETTE.ui.slotEmpty,
        width: onCursor ? 1.8 : 1.2,
        alpha: owned ? 1 : 0.55,
      })
      if (spec) {
        r.text(spec.icon, x + size / 2, boxY + size / 2 + 5, {
          size: 14,
          bold: true,
          color: spec.colour,
          align: "center",
        })
      }
    }
  }

  // The pop-over on one special slot, hung under the slot it belongs to and pulled
  // back inside the right-hand column where it would otherwise overhang. It is
  // headed by what is in the slot, so which one is being worked on is never in
  // doubt once the panel covers the row.
  // Break `text` into lines that fit `width` at `size`, so a description can say
  // more than a panel is wide. The atlas is monospace, so a character is a fixed
  // fraction of the size and this needs no measuring.
  #wrap(text, width, size) {
    const perLine = Math.max(8, Math.floor(width / (size * 0.62)))
    const lines = []
    let line = ""
    for (const word of String(text).split(" ")) {
      const next = line ? `${line} ${word}` : word
      if (next.length > perLine && line) {
        lines.push(line)
        line = word
      } else {
        line = next
      }
    }
    if (line) {
      lines.push(line)
    }
    return lines
  }

  #slotPopover(game, rightX, slotsY) {
    const r = this.renderer,
      { slot, selection } = game.slotMenu,
      rows = game.slotMenuRows(slot)
    // A menu opened from a shop row belongs under that row; one opened on a special
    // slot belongs under its box. What it is called is the game's to say, since only
    // it knows which registry the rows came from - reading the special in slot 0 for
    // all of them is what put ORE MAGNET at the top of the ENGINE menu.
    const onRow = !!(game.slotMenu.equipment || game.slotMenu.levels)
    const titleColour = game.slotMenuColour()
    const chosen = rows[selection]
    const titleHeight = 20
    const width = onRow ? 260 : 200,
      rowHeight = 20
    const desc = chosen && chosen.desc ? this.#wrap(chosen.desc, width - 16, 10) : []
    const height = titleHeight + rows.length * rowHeight + 14 + desc.length * 12
    // A menu opened from a row hangs off the tab drawn on that row, sharing its left
    // edge so the two outlines line up; one opened on a special slot hangs under its
    // box, as before.
    const tab = onRow ? this.menuAnchor : null
    const anchorX = tab ? tab.x : this.#slotBox(rightX, slot).x - 6
    const panelX = Math.min(anchorX, rightX - width),
      panelY = tab ? tab.y : slotsY + 15
    r.rect(panelX, panelY, width, height, { fill: "rgba(4,8,16,.95)" })
    r.rect(panelX, panelY, width, height, { stroke: PALETTE.ui.accent, width: 1.2, glow: 8 })
    if (tab) {
      // The join: the tab's floor and the panel's ceiling are the same line, so it is
      // painted out and the pair becomes one outline with a shoulder in it.
      r.rect(panelX + 1.6, panelY - 1.4, tab.w - 3.2, 3, { fill: "rgba(4,8,16,1)" })
    }
    r.text(game.slotMenuTitle(), panelX + width / 2, panelY + 15, {
      size: 12,
      bold: true,
      color: titleColour ?? PALETTE.text.bright,
      align: "center",
    })
    r.line(panelX + 6, panelY + titleHeight + 1, panelX + width - 6, panelY + titleHeight + 1, {
      color: PALETTE.ui.edge,
      width: 1,
    })
    rows.forEach((row, index) => {
      const rowY = panelY + titleHeight + 18 + index * rowHeight,
        on = selection === index
      if (on) {
        r.rect(panelX + 3, rowY - 12, width - 6, rowHeight - 3, { fill: "rgba(95,215,255,.16)" })
      }
      r.text(`${on ? "> " : "  "}${row.name}`, panelX + 8, rowY, {
        size: 13,
        bold: on,
        color: on ? PALETTE.text.bright : PALETTE.text.normal,
      })
      if (row.value) {
        r.text(row.value(game, slot), panelX + width - 8, rowY, {
          size: 11,
          color: PALETTE.fx.flash,
          align: "right",
        })
      }
    })
    desc.forEach((line, index) => {
      r.text(
        line,
        panelX + width / 2,
        panelY + titleHeight + 20 + rows.length * rowHeight + index * 12,
        {
          size: 10,
          color: PALETTE.text.soft,
          align: "center",
        },
      )
    })
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
      r.text(
        this.#prompt(game, "PRESS ENTER TO RETRY", "PRESS A OR START TO RETRY"),
        VIEW_W / 2,
        VIEW_H / 2 + 82,
        {
          size: 13,
          color: PALETTE.text.dim,
          align: "center",
        },
      )
    }
  }

  // One menu row: its name on the left and, on the right, either what it is set to,
  // what it is waiting for, or the question it is asking.
  #menuRow(game, row, selected, x0, x1, y, size) {
    const r = this.renderer
    const asking = game.pauseConfirming === row.name
    const waiting = row.waiting ? row.waiting() : null
    if (selected) {
      r.rect(x0 - 12, y - 14, x1 - x0 + 26, size + 12, {
        fill: asking || waiting ? "rgba(255,91,91,.16)" : "rgba(95,215,255,.12)",
      })
    }
    r.text(`${selected ? "> " : "  "}${row.label ? row.label(game) : row.name}`, x0, y, {
      size,
      bold: selected,
      color: asking ? PALETTE.ui.warn : selected ? PALETTE.text.bright : PALETTE.text.normal,
    })
    const value = asking ? row.confirm : waiting || (row.value ? row.value(game) : "")
    if (value) {
      r.text(value, x1, y, {
        size: size - 1,
        color: asking || waiting ? PALETTE.ui.warn : PALETTE.fx.flash,
        align: "right",
      })
    }
    return asking || waiting
  }

  // The control bindings, one column per device. There are twenty of them, which is
  // more than fits down one side, and a column per device is the grouping a player
  // wants anyway. The cursor still runs through the rows in order, so it moves down
  // the keyboard column and on into the gamepad one.
  #controls(game, rows) {
    const r = this.renderer
    const columns = []
    rows.forEach((row, index) => {
      const key = row.section || ""
      let column = columns.find((c) => c.section === key)
      if (!column) {
        column = { section: key, rows: [] }
        columns.push(column)
      }
      column.rows.push({ row, index })
    })
    // the unsectioned rows (reset, back) sit under the columns rather than beside
    const sectioned = columns.filter((c) => c.section)
    const loose = columns.filter((c) => !c.section).flatMap((c) => c.rows)

    const top = 150
    const rowHeight = 24
    const width = 300
    const gap = 60
    const totalWidth = sectioned.length * width + (sectioned.length - 1) * gap
    let deepest = top
    sectioned.forEach((column, columnIndex) => {
      const x0 = VIEW_W / 2 - totalWidth / 2 + columnIndex * (width + gap)
      const x1 = x0 + width
      r.text(column.section, x0 + width / 2, top - 16, {
        size: 13,
        bold: true,
        color: PALETTE.ui.accent,
        align: "center",
        glow: 8,
      })
      r.line(x0 - 6, top - 8, x1 + 6, top - 8, {
        color: PALETTE.ui.accent,
        width: 1.2,
        glow: 6,
        alpha: 0.7,
      })
      column.rows.forEach(({ row, index }, rowIndex) => {
        const y = top + 8 + rowIndex * rowHeight
        this.#menuRow(game, row, game.pauseSelection === index, x0, x1, y, 12)
        deepest = Math.max(deepest, y)
      })
    })

    // The loose rows share one line under the columns, taking their outer edges: the
    // first left-aligned, the last right-aligned, as the shop's last row does.
    const y = deepest + 40
    const outerLeft = VIEW_W / 2 - totalWidth / 2
    const outerRight = VIEW_W / 2 + totalWidth / 2
    const midX = (outerLeft + outerRight) / 2
    loose.forEach(({ row, index }, position) => {
      const onLeft = position === 0
      const selected = game.pauseSelection === index
      const asking = game.pauseConfirming === row.name
      if (selected) {
        r.rect(onLeft ? outerLeft - 12 : midX + 8, y - 15, midX - outerLeft + 4, 24, {
          fill: asking ? "rgba(255,91,91,.16)" : "rgba(95,215,255,.12)",
        })
      }
      const edge = onLeft ? outerLeft : outerRight
      const align = onLeft ? "left" : "right"
      r.text(`${selected ? "> " : "  "}${row.label ? row.label(game) : row.name}`, edge, y, {
        size: 14,
        bold: selected,
        color: asking ? PALETTE.ui.warn : selected ? PALETTE.text.bright : PALETTE.text.normal,
        align,
      })
      if (asking) {
        r.text(row.confirm, edge, y + 17, { size: 11, color: PALETTE.ui.warn, align })
      }
    })
    return y + 17
  }

  // Pause doubles as the settings menu, laid out like the shop so the two read the
  // same way. A row wanting confirmation says so in place of its value.
  #paused(game) {
    const r = this.renderer
    r.rect(0, 0, VIEW_W, VIEW_H, { fill: "rgba(2,4,10,.72)" })
    const onControls = game.pausePage === "controls"
    // Measured and centred, as the shop is: a row added to the menu moves the page
    // rather than pushing its last row down the screen. The controls page lays itself
    // out in columns and keeps its own top.
    // Title to last row, which is the whole of it now the caption underneath is gone.
    const paused = game.pauseMenu()
    const lastRowOffset = 62 + (paused.length - 1) * 38
    const menuTop = onControls ? 92 : Math.max(48, Math.round((VIEW_H - lastRowOffset) / 2))
    r.text(onControls ? "CONTROLS" : "OPTIONS", VIEW_W / 2, menuTop, {
      size: 34,
      bold: true,
      color: PALETTE.text.bright,
      align: "center",
      glow: 16,
    })

    const rows = game.pauseMenu()
    if (onControls) {
      const hintY = this.#controls(game, rows) + 6
      if (!game.rebinding) {
        r.text("P, ENTER and ESC cannot be bound", VIEW_W / 2, hintY + 18, {
          size: 10,
          color: PALETTE.text.faint,
          align: "center",
        })
      }
      // Only while capturing a key: that is a modal state with no standard way out,
      // so how to abandon it has to be said.
      if (game.rebinding) {
        r.text(this.#prompt(game, "ESC cancels", "HOLD B to cancel"), VIEW_W / 2, hintY, {
          size: 11,
          color: PALETTE.ui.warn,
          align: "center",
        })
      }
      return
    }
    const leftX = VIEW_W / 2 - 205,
      rightX = VIEW_W / 2 + 205,
      top = menuTop + 62,
      rowHeight = 38
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i],
        y = top + i * rowHeight
      const selected = game.pauseSelection === i
      const asking = this.#menuRow(game, row, selected, leftX, rightX, y, 17)
      // a scale gets arrows, so it is clear it is adjusted rather than pressed
      if (selected && row.adjust && !asking) {
        r.text("<", leftX + 264, y, { size: 14, color: PALETTE.text.muted })
        r.text(">", rightX - 80, y, { size: 14, color: PALETTE.text.muted })
      }
    }

    const hintY = top + rows.length * rowHeight + 20
    if (game.pauseConfirming) {
      r.text("press again to confirm", VIEW_W / 2, hintY, {
        size: 11,
        color: PALETTE.ui.warn,
        align: "center",
      })
    }
  }
}
