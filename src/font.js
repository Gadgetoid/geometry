// Vector font: straight-segment glyphs on a 4x6 cell, drawn through the
// Renderer so it stays backend-agnostic. Only the letters in "GEOMETRY II"
// exist. Each glyph is a list of polylines.

import { clamp } from "./math.js"

const GLYPHS = {
  G: [
    [
      [4, 0],
      [0, 0],
      [0, 6],
      [4, 6],
      [4, 3],
      [2, 3],
    ],
  ],
  E: [
    [
      [4, 0],
      [0, 0],
      [0, 6],
      [4, 6],
    ],
    [
      [0, 3],
      [3, 3],
    ],
  ],
  O: [
    [
      [1, 0],
      [3, 0],
      [4, 1],
      [4, 5],
      [3, 6],
      [1, 6],
      [0, 5],
      [0, 1],
      [1, 0],
    ],
  ],
  M: [
    [
      [0, 6],
      [0, 0],
      [2, 2.6],
      [4, 0],
      [4, 6],
    ],
  ],
  T: [
    [
      [0, 0],
      [4, 0],
    ],
    [
      [2, 0],
      [2, 6],
    ],
  ],
  R: [
    [
      [0, 6],
      [0, 0],
      [3, 0],
      [4, 1],
      [4, 2],
      [3, 3],
      [0, 3],
    ],
    [
      [2, 3],
      [4, 6],
    ],
  ],
  Y: [
    [
      [0, 0],
      [2, 3],
      [4, 0],
    ],
    [
      [2, 3],
      [2, 6],
    ],
  ],
  I: [
    [
      [0.5, 0],
      [3.5, 0],
    ],
    [
      [2, 0],
      [2, 6],
    ],
    [
      [0.5, 6],
      [3.5, 6],
    ],
  ],
}

// Draw stroked vector text centred on (cx, cy). `colour` may be a string or a
// (char, index) => colour function so glyphs can be individually tinted.
export function drawVectorText(renderer, text, cx, cy, height, colour, glow) {
  const unit = height / 6
  const advance = 6 * unit
  const advanceFor = (ch) => (ch === " " ? advance * 0.45 : advance) // narrower space
  let totalWidth = -2 * unit
  for (const ch of text) {
    totalWidth += advanceFor(ch)
  }
  let x = cx - totalWidth / 2
  const y = cy - height / 2
  const colourOf = typeof colour === "function" ? colour : () => colour
  const width = clamp(height * 0.06, 2, 7)

  for (let i = 0; i < text.length; i++) {
    const glyph = GLYPHS[text[i]]
    if (glyph) {
      const c = colourOf(text[i], i)
      for (const stroke of glyph) {
        const points = stroke.map((p) => ({ x: x + p[0] * unit, y: y + p[1] * unit }))
        renderer.strokePoly(points, {
          color: c,
          width,
          glow: glow || 16,
          closed: false,
          cap: "round",
        })
      }
    }
    x += advanceFor(text[i])
  }
}
