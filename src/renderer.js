// Rendering abstraction.
//
// The game never touches a drawing context directly. Instead it calls the
// high-level, world-space primitives on a Renderer. Everything is expressed as
// vertex lists / points in the virtual 1024x640 space, which is exactly what a
// GPU backend wants. To port to WebGL/WebGPU, implement this same interface in
// a new class (e.g. WebGLRenderer) and swap it in `main.js`.
//
// Options bags use these keys: { color, width, glow, alpha, closed, stroke,
// fill, cap, size, align, baseline, bold }.

/** Abstract contract. A backend must implement every method. */
export class Renderer {
  clearFrame(_color) {
    throw new Error("not implemented")
  }
  pushView(_camera) {
    throw new Error("not implemented")
  } // begin a transformed pass
  popView() {
    throw new Error("not implemented")
  }
  strokePoly(_points, _opts) {
    throw new Error("not implemented")
  }
  fillPoly(_points, _opts) {
    throw new Error("not implemented")
  }
  line(_ax, _ay, _bx, _by, _opts) {
    throw new Error("not implemented")
  }
  circle(_x, _y, _r, _opts) {
    throw new Error("not implemented")
  }
  rect(_x, _y, _w, _h, _opts) {
    throw new Error("not implemented")
  }
  point(_x, _y, _size, _opts) {
    throw new Error("not implemented")
  }
  text(_str, _x, _y, _opts) {
    throw new Error("not implemented")
  }
}

const MONO = "ui-monospace,Menlo,monospace"

/** Canvas 2D implementation of the Renderer contract. */
export class Canvas2DRenderer extends Renderer {
  constructor(canvas) {
    super()
    this.canvas = canvas
    this.ctx = canvas.getContext("2d")
  }

  #glow(colour, amount) {
    if (amount) {
      this.ctx.shadowColor = colour
      this.ctx.shadowBlur = amount
    } else {
      this.ctx.shadowBlur = 0
    }
  }

  clearFrame(color) {
    const { ctx, canvas } = this
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = color
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  // camera: { dpr, offsetX, offsetY, scale, shakeX, shakeY, clipW, clipH }
  pushView(camera) {
    const { ctx } = this
    ctx.save()
    ctx.setTransform(camera.dpr, 0, 0, camera.dpr, 0, 0)
    ctx.translate(camera.offsetX + (camera.shakeX || 0), camera.offsetY + (camera.shakeY || 0))
    ctx.scale(camera.scale, camera.scale)
    ctx.beginPath()
    ctx.rect(0, 0, camera.clipW, camera.clipH)
    ctx.clip()
  }

  popView() {
    this.ctx.restore()
  }

  #tracePath(points, closed) {
    const { ctx } = this
    ctx.beginPath()
    points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
    if (closed) {
      ctx.closePath()
    }
  }

  strokePoly(points, opts = {}) {
    const { ctx } = this
    ctx.save()
    this.#glow(opts.color, opts.glow || 0)
    ctx.globalAlpha = opts.alpha ?? 1
    ctx.strokeStyle = opts.color
    ctx.lineWidth = opts.width ?? 1.6
    ctx.lineJoin = "round"
    ctx.lineCap = opts.cap || "butt"
    this.#tracePath(points, opts.closed !== false)
    ctx.stroke()
    ctx.restore()
  }

  fillPoly(points, opts = {}) {
    const { ctx } = this
    ctx.save()
    this.#glow(opts.color, opts.glow || 0)
    ctx.globalAlpha = opts.alpha ?? 1
    ctx.fillStyle = opts.color
    this.#tracePath(points, true)
    ctx.fill()
    ctx.restore()
  }

  line(ax, ay, bx, by, opts = {}) {
    const { ctx } = this
    ctx.save()
    this.#glow(opts.color, opts.glow || 0)
    ctx.globalAlpha = opts.alpha ?? 1
    ctx.strokeStyle = opts.color
    ctx.lineWidth = opts.width ?? 1.6
    ctx.lineCap = opts.cap || "butt"
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    ctx.stroke()
    ctx.restore()
  }

  circle(x, y, r, opts = {}) {
    const { ctx } = this
    ctx.save()
    this.#glow(opts.stroke || opts.fill, opts.glow || 0)
    ctx.globalAlpha = opts.alpha ?? 1
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    if (opts.fill) {
      ctx.fillStyle = opts.fill
      ctx.fill()
    }
    if (opts.stroke) {
      ctx.strokeStyle = opts.stroke
      ctx.lineWidth = opts.width ?? 1.6
      ctx.stroke()
    }
    ctx.restore()
  }

  rect(x, y, w, h, opts = {}) {
    const { ctx } = this
    ctx.save()
    this.#glow(opts.stroke || opts.fill, opts.glow || 0)
    ctx.globalAlpha = opts.alpha ?? 1
    if (opts.fill) {
      ctx.fillStyle = opts.fill
      ctx.fillRect(x, y, w, h)
    }
    if (opts.stroke) {
      ctx.strokeStyle = opts.stroke
      ctx.lineWidth = opts.width ?? 1
      ctx.strokeRect(x, y, w, h)
    }
    ctx.restore()
  }

  point(x, y, size, opts = {}) {
    const { ctx } = this
    ctx.save()
    ctx.globalAlpha = opts.alpha ?? 1
    ctx.fillStyle = opts.color
    ctx.fillRect(x, y, size, size)
    ctx.restore()
  }

  text(str, x, y, opts = {}) {
    const { ctx } = this
    ctx.save()
    this.#glow(opts.color, opts.glow || 0)
    ctx.globalAlpha = opts.alpha ?? 1
    ctx.fillStyle = opts.color
    ctx.font = `${opts.bold ? "bold " : ""}${opts.size || 12}px ${MONO}`
    ctx.textAlign = opts.align || "left"
    ctx.textBaseline = opts.baseline || "alphabetic"
    ctx.fillText(str, x, y)
    ctx.restore()
  }
}
