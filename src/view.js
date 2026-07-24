// GameView paints a Game with a Renderer. It owns the view transform (the
// letterboxed mapping of the virtual VIEW_W x VIEW_H space onto the canvas,
// plus screen shake) and composes each frame: world pass, then HUD / overlays.
// It only reads Game state, so a shader backend can be dropped in by swapping
// the Renderer without touching game logic. Entities still paint themselves via
// their own draw(renderer, game) methods.

import { VIEW_W, VIEW_H, SHOP, SHOP_DESC, POWERUP_COLOUR } from "./config.js"
import { randRange, clamp, lerp } from "./math.js"
import { drawVectorText } from "./font.js"

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
      world: { ...base, shakeX: sx, shakeY: sy, panX, panY, centerX: c.x, centerY: c.y },
      hud: { ...base, shakeX: 0, shakeY: 0, panX: 0, panY: 0 },
    }
  }

  render(game) {
    const r = this.renderer,
      cam = this.#cameras(game)
    r.beginFrame(game.gameTime)
    r.clearFrame("#02040a")

    r.pushView(cam.world)
    this.#planets(game)
    this.#background(game)
    if (game.phase === "title") {
      for (const rock of game.menuAsteroids) {
        r.strokePoly(rock.vertices, { color: `hsl(${rock.hue} 85% 66%)`, width: 1.6, glow: 10 })
      }
      r.popView()
      r.pushView(cam.hud)
      this.#title(game)
      r.popView()
      r.endFrame()
      return
    }
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
    r.popView()

    r.pushView(cam.hud)
    this.#radar(game)
    this.#hud(game)
    r.popView()
    r.endFrame()
  }

  #planets(game) {
    const r = this.renderer
    for (const p of game.planets) {
      r.planet(p.x, p.y, p.r, {
        base: p.base,
        hi: p.hi,
        atmo: p.atmo,
        seed: p.seed,
        light: p.light,
        depth: p.depth,
      })
    }
  }

  #background(game) {
    const r = this.renderer
    for (const star of game.stars) {
      const twinkle = 0.4 + 0.6 * Math.sin(star.twinkle + game.gameTime * 1.5)
      const alpha = clamp((0.14 + 0.72 * star.depth) * twinkle, 0, 1)
      const size = star.depth * 2.2
      r.point(star.x, star.y, size, {
        color: `rgb(${lerp(148, 226, star.depth) | 0},${lerp(180, 236, star.depth) | 0},242)`,
        alpha,
        depth: star.depth,
      })
    }
  }

  // Arena bounds + off-screen radar are filled in with the arena system; stubs
  // keep the render path stable until then.
  #bounds() {}
  #radar() {}

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
      color: "#eaf4ff",
    })
    r.text(`SECTOR ${game.level}   ROCKS ${game.asteroids.length}`, 18, 48, {
      size: 12,
      color: "#9fc0ff",
    })
    r.text(`ORE ${game.oreBalance}`, 18, 64, { size: 12, color: "#ffcf5c" })
    if (game.plan && game.plan.rivals > 0) {
      r.text(`RIVAL ${String(game.rivalScore).padStart(6, "0")}`, 18, 80, {
        size: 12,
        color: "#ff9a3c",
      })
    }

    r.text("LIVES", VIEW_W - 18, 24, { size: 12, color: "#5fd7ff", align: "right" })
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
        { color: "#5fd7ff", width: 1.5, glow: 6 },
      )
    }

    const barW = VIEW_W - 36,
      barX = 18,
      barY = VIEW_H - 26,
      barH = 12
    r.rect(barX, barY, barW, barH, { stroke: "#1c3050", width: 1 })
    const fraction = game.player ? game.player.energy / game.maxEnergy() : 0
    const low = fraction < 0.22
    let fillW = barW * fraction
    if (low) {
      fillW = barW * fraction * (0.85 + 0.15 * Math.sin(game.gameTime * 10))
    }
    const barColour =
      game.player && game.player.boosterTime > 0 ? "#ffcf5c" : low ? "#ff5b5b" : "#5fd7ff"
    r.rect(barX + 1, barY + 1, Math.max(0, fillW - 2), barH - 2, { fill: barColour, glow: 10 })
    r.text("ENERGY", barX + 2, barY - 4, { size: 9, color: "#7fa0c8" })

    // Shield: mark the offline / recovery energy levels and show online state.
    const shield = game.player ? game.player.shieldModule() : null
    if (shield) {
      const dropX = barX + barW * shield.type.dropAt
      const recoverX = barX + barW * shield.type.recoverAt
      r.line(dropX, barY - 2, dropX, barY + barH + 2, { color: "#ff5b5b", width: 1 }) // offline level
      r.line(recoverX, barY - 2, recoverX, barY + barH + 2, { color: "#9fe8ff", width: 1, alpha: 0.55 }) // recovery level
      r.text(shield.up ? "SHIELD" : "SHIELD OFFLINE", barX + 46, barY - 4, {
        size: 9,
        color: shield.up ? "#9fe8ff" : "#ff5b5b",
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
        r.rect(sx, sy, size, size, { stroke: item ? POWERUP_COLOUR[item] : "#26436b", width: 1.2 })
        r.text(String(i + 1), sx + 2, sy + 9, { size: 8, color: "#5f79a6" })
        if (item) {
          r.text(item[0].toUpperCase(), sx + size / 2, sy + size / 2 + 5, {
            size: 12,
            bold: true,
            color: POWERUP_COLOUR[item],
            align: "center",
          })
        }
      }
    }

    const buffs = []
    if (game.player) {
      if (game.player.boosterTime > 0) {
        buffs.push(["BOOST", game.player.boosterTime, "#ffcf5c"])
      }
      if (game.player.multiTime > 0) {
        buffs.push(["MULTI", game.player.multiTime, "#5fd7ff"])
      }
      if (game.player.magnetTime > 0) {
        buffs.push(["MAGNET", game.player.magnetTime, "#b38bff"])
      }
    }
    buffs.forEach((buff, i) =>
      r.text(`${buff[0]} ${buff[1].toFixed(1)}s`, VIEW_W / 2, 26 + i * 15, {
        size: 11,
        color: buff[2],
        align: "center",
      }),
    )

    if (game.toast) {
      r.text(game.toast.text, 18, VIEW_H - 72, {
        size: 12,
        color: "#ffbdee",
        glow: 8,
        alpha: clamp(game.toast.life / 0.6, 0, 1),
      })
    }

    if (game.phase === "clearing") {
      r.text("SECTOR CLEARED", VIEW_W / 2, VIEW_H / 2, {
        size: 26,
        bold: true,
        color: "#57e39a",
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
      (ch, i) => (i >= 9 ? "#ff7fdc" : "#7fe0ff"),
      18,
    )
    r.text(
      "Galactic Extraction Of Minerals, Europium, Thallium, Rare-earths & Yttrium",
      VIEW_W / 2,
      VIEW_H / 2 - 8,
      { size: 15, color: "#ffcf5c", align: "center" },
    )
    r.text(
      "Slice asteroids, mine ore, balance your thrusters, shields and laser carefully!",
      VIEW_W / 2,
      VIEW_H / 2 + 30,
      { size: 13, color: "#9fc0ff", align: "center" },
    )
    r.text(
      "Clear every rock in the sector. Rinse. Repeat. You've got company.",
      VIEW_W / 2,
      VIEW_H / 2 + 52,
      { size: 13, color: "#9fc0ff", align: "center" },
    )
    r.text(
      `BEST   SCORE ${game.best.score}    SECTOR ${game.best.sector}`,
      VIEW_W / 2,
      VIEW_H / 2 + 82,
      { size: 12, color: "#7fe0ff", align: "center" },
    )
    if (Math.floor(game.gameTime * 2) % 2 === 0) {
      r.text("PRESS ENTER", VIEW_W / 2, VIEW_H / 2 + 114, {
        size: 18,
        bold: true,
        color: "#57e39a",
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
      color: "#7ff0b8",
      align: "center",
      glow: 16,
    })
    r.text(
      `accuracy ${Math.round(d.accuracy * 100)}%    mined ${d.mined}    ore this run ${d.ore}    damage ${d.damage}    bonus +${d.totalBonus}`,
      VIEW_W / 2,
      82,
      { size: 12, color: "#9fc0ff", align: "center" },
    )
    r.text(`ORE  ${game.oreBalance}`, VIEW_W / 2, 112, {
      size: 20,
      bold: true,
      color: "#ffcf5c",
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
        color: maxed ? "#57e39a" : selected ? "#eaf4ff" : "#bcd0ee",
      })
      r.text(item.info(game), leftX + 206, y, { size: 11, color: "#7fa0c8" })
      r.text(maxed ? "MAX" : game.devMode ? "FREE" : `${cost} ore`, rightX, y, {
        size: 14,
        color: maxed ? "#57e39a" : game.devMode ? "#57e39a" : affordable ? "#ffcf5c" : "#5a6f92",
        align: "right",
      })
    }
    if (game.shopSelection < SHOP.length) {
      r.text(
        SHOP_DESC[SHOP[game.shopSelection].id],
        VIEW_W / 2,
        top + SHOP.length * rowHeight + 8,
        { size: 12, color: "#8fb2dd", align: "center" },
      )
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
      { size: 18, bold: true, color: "#7ff0b8", align: "center", glow: launchSelected ? 16 : 8 },
    )
    r.text("UP / DOWN select      ENTER buy or launch", VIEW_W / 2, launchY + 26, {
      size: 11,
      color: "#5f79a6",
      align: "center",
    })
    if (game.devMode) {
      r.text(
        "DEV   LEFT / RIGHT choose sector (hold SHIFT for x10)   -   purchases are free",
        VIEW_W / 2,
        launchY + 44,
        { size: 11, color: "#ff7fdc", align: "center" },
      )
    }
  }

  #gameOver(game) {
    const r = this.renderer
    r.rect(0, 0, VIEW_W, VIEW_H, { fill: "rgba(2,4,10,.55)" })
    r.text("SHIP LOST", VIEW_W / 2, VIEW_H / 2 - 30, {
      size: 56,
      bold: true,
      color: "#ff8080",
      align: "center",
      glow: 20,
    })
    r.text(`REACHED SECTOR ${game.level}   SCORE ${game.score}`, VIEW_W / 2, VIEW_H / 2 + 14, {
      size: 18,
      color: "#eaf4ff",
      align: "center",
    })
    if (game.plan && game.plan.rivals > 0) {
      r.text(`RIVAL HAUL  ${game.rivalScore}`, VIEW_W / 2, VIEW_H / 2 + 38, {
        size: 14,
        color: "#ff9a3c",
        align: "center",
      })
    }
    const newBest = game.score >= game.best.score && game.score > 0
    r.text(
      `${newBest ? "NEW BEST   " : "BEST   "}SCORE ${game.best.score}    SECTOR ${game.best.sector}`,
      VIEW_W / 2,
      VIEW_H / 2 + 58,
      { size: 12, color: newBest ? "#7ff0b8" : "#7fe0ff", align: "center" },
    )
    if (Math.floor(game.gameTime * 2) % 2 === 0) {
      r.text("PRESS ENTER TO RETRY", VIEW_W / 2, VIEW_H / 2 + 82, {
        size: 13,
        color: "#9fc0ff",
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
      color: "#eaf4ff",
      align: "center",
      glow: 16,
    })
  }
}
