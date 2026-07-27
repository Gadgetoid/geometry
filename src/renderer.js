// Rendering abstraction.
//
// The game never touches a drawing context directly. Instead it calls the
// high-level, world-space primitives on a Renderer. Everything is expressed as
// vertex lists / points in the virtual 1024x640 space, which is exactly what a
// GPU backend wants. WebGLRenderer (glrenderer.js) is the only implementation;
// to add another (WebGPU, a capture backend), implement this same interface and
// swap it in `main.js`.
//
// Options bags use these keys: { color, width, glow, alpha, closed, stroke,
// fill, cap, size, align, baseline, bold }.

/** Abstract contract. A backend must implement every method. */
export class Renderer {
  beginFrame(_time) {} // start a frame (bind targets / stash time); optional
  endFrame() {} // finish a frame (post-processing / present); optional
  nebula(_scrollX, _scrollY) {} // background nebula layer; optional
  compositeBackground() {} // finalise the background layer (e.g. depth of field); optional
  // Screen-space ripple centred on (uvX, uvY) with 0..1 strength, for the warp.
  // Optional: a backend without post-processing simply has no distortion, and
  // the expanding rings the ship draws carry the effect on their own.
  setWarp(_uvX, _uvY, _strength) {}
  setLenses(_list) {}
  setTears(_list) {}
  // False while the backend cannot draw (e.g. a lost GPU context), so the loop
  // can skip the frame instead of issuing calls that would be discarded.
  get ready() {
    return true
  }
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
  planet(_x, _y, _r, _opts) {
    throw new Error("not implemented")
  }
}
