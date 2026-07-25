// Maths and geometry helpers. Pure functions, no state.

// Deterministic PRNG (mulberry32): same seed -> same sequence, so a sector's
// backdrop is repeatable. Returns a function producing floats in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const randRange = (min, max) => min + Math.random() * (max - min)
export const randInt = (min, max) => Math.floor(randRange(min, max + 1))
export const pick = (arr) => arr[randInt(0, arr.length - 1)]
export const clamp = (value, min, max) => (value < min ? min : value > max ? max : value)
export const lerp = (a, b, t) => a + (b - a) * t

// 2D vector helpers operating on {x, y} objects.
export const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y })
export const dot = (a, b) => a.x * b.x + a.y * b.y
export const cross = (a, b) => a.x * b.y - a.y * b.x // 2D scalar cross product
export const magnitude = (v) => Math.hypot(v.x, v.y)
export const normalize = (v) => {
  const m = magnitude(v) || 1
  return { x: v.x / m, y: v.y / m }
}
export const perpendicular = (v) => ({ x: -v.y, y: v.x })

// Shoelace polygon area (always positive).
export function polygonArea(vertices) {
  let area = 0
  for (let i = 0; i < vertices.length; i++) {
    const p = vertices[i]
    const q = vertices[(i + 1) % vertices.length]
    area += p.x * q.y - q.x * p.y
  }
  return Math.abs(area) / 2
}

// Area-weighted polygon centroid, with an average as a degenerate fallback.
export function polygonCentroid(vertices) {
  let area = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < vertices.length; i++) {
    const p = vertices[i]
    const q = vertices[(i + 1) % vertices.length]
    const w = p.x * q.y - q.x * p.y
    area += w
    cx += (p.x + q.x) * w
    cy += (p.y + q.y) * w
  }
  if (Math.abs(area) < 1e-6) {
    let sx = 0
    let sy = 0
    vertices.forEach((p) => {
      sx += p.x
      sy += p.y
    })
    return { x: sx / vertices.length, y: sy / vertices.length }
  }
  area *= 0.5
  return { x: cx / (6 * area), y: cy / (6 * area) }
}

// Distance from centre to the furthest vertex.
export function boundingRadius(vertices, centre) {
  let max = 0
  for (const p of vertices) {
    max = Math.max(max, Math.hypot(p.x - centre.x, p.y - centre.y))
  }
  return max
}

// Andrew's monotone chain convex hull. Asteroids are hulls so every fragment
// stays convex, which keeps the slice logic well-behaved.
export function convexHull(points) {
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y)
  if (sorted.length < 3) {
    return sorted
  }
  const turn = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower = []
  for (const p of sorted) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop()
    }
    lower.push(p)
  }
  const upper = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop()
    }
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

// Even-odd ray cast point-in-polygon test.
export function pointInPolygon(point, vertices) {
  let inside = false
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[i]
    const b = vertices[j]
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside
    }
  }
  return inside
}

// Intersection point of segment a->b with segment c->d, or null.
export function segmentIntersection(a, b, c, d) {
  const r = subtract(b, a)
  const s = subtract(d, c)
  const denom = cross(r, s)
  if (Math.abs(denom) < 1e-9) {
    return null
  }
  const t = cross(subtract(c, a), s) / denom
  const u = cross(subtract(c, a), r) / denom
  if (t < 0 || t > 1 || u < 0 || u > 1) {
    return null
  }
  return { x: a.x + t * r.x, y: a.y + t * r.y }
}

// Shortest distance from point (px,py) to segment a->b. Used for wide beams.
export function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax,
    dy = by - ay
  const lenSq = dx * dx + dy * dy || 1
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = ax + t * dx,
    cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

// How many polygon edges a beam segment crosses.
export function countBeamCrossings(beam, vertices) {
  let count = 0
  for (let i = 0; i < vertices.length; i++) {
    if (segmentIntersection(beam.a, beam.b, vertices[i], vertices[(i + 1) % vertices.length])) {
      count++
    }
  }
  return count
}

// Pieces smaller than this are numerical debris (a line grazing one vertex),
// not a cut.
const SLICE_MIN_AREA = 1e-6

// Slice a simple polygon (convex OR concave) by the infinite line through
// `pointOnLine` with the given `normal`. Returns an array of the resulting
// pieces (each a fresh list of {x,y}); a clean cut yields two or more pieces, a
// non-cutting or merely grazing line yields the single input polygon.
//
// Works by inserting the boundary/line intersection points, pairing them along
// the line (even-odd: consecutive pairs bound interior chords), then walking the
// arrangement as half-edges. At a crossing the walk alternates boundary<->chord,
// so every interior face (piece) is traced exactly once - which is what makes
// concave cuts (more than two crossings, disjoint pieces) come out correctly.
export function slicePolygon(vertices, pointOnLine, normal) {
  const n = vertices.length
  if (n < 3) {
    return [vertices.map((v) => ({ x: v.x, y: v.y }))]
  }
  const tx = -normal.y,
    ty = normal.x // tangent along the cut line
  const sideOf = (p) => (p.x - pointOnLine.x) * normal.x + (p.y - pointOnLine.y) * normal.y
  const along = (p) => (p.x - pointOnLine.x) * tx + (p.y - pointOnLine.y) * ty
  const sign = vertices.map((v) => (sideOf(v) >= 0 ? 1 : -1)) // on-line counts as +

  // boundary ring with intersection points inserted
  const ring = []
  const isCut = []
  for (let i = 0; i < n; i++) {
    const a = vertices[i],
      b = vertices[(i + 1) % n]
    ring.push({ x: a.x, y: a.y })
    isCut.push(false)
    if (sign[i] !== sign[(i + 1) % n]) {
      const sa = sideOf(a),
        sb = sideOf(b)
      const t = sa / (sa - sb)
      ring.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) })
      isCut.push(true)
    }
  }
  const cuts = ring.map((_, i) => i).filter((i) => isCut[i])
  if (cuts.length < 2 || cuts.length % 2 !== 0) {
    return [ring] // tangent / no clean crossing
  }

  // pair crossings by position along the line
  cuts.sort((i, j) => along(ring[i]) - along(ring[j]))
  const partner = new Map()
  for (let k = 0; k + 1 < cuts.length; k += 2) {
    partner.set(cuts[k], cuts[k + 1])
    partner.set(cuts[k + 1], cuts[k])
  }

  const M = ring.length
  const nextB = (i) => (i + 1) % M
  const used = new Set()
  const key = (a, b) => a * M + b
  const starts = []
  for (let i = 0; i < M; i++) {
    starts.push([i, nextB(i), true]) // boundary half-edges (forward only)
  }
  for (const c of cuts) {
    starts.push([c, partner.get(c), false]) // chord half-edges (both directions)
  }

  const pieces = []
  for (const [f0, t0, b0] of starts) {
    if (used.has(key(f0, t0))) {
      continue
    }
    const piece = []
    let u = f0,
      v = t0,
      viaBoundary = b0,
      guard = 0
    while (!used.has(key(u, v)) && guard++ < 4 * M + 8) {
      used.add(key(u, v))
      piece.push({ x: ring[u].x, y: ring[u].y })
      // choose the next half-edge out of node v
      if (isCut[v] && viaBoundary) {
        u = v
        v = partner.get(v)
        viaBoundary = false // arrived by boundary -> leave along the chord
      } else {
        u = v
        v = nextB(v)
        viaBoundary = true // arrived by chord (or plain vertex) -> follow boundary
      }
    }
    // A line touching a single vertex traces a spur with no area alongside the
    // intact polygon; callers must not see that as a cut piece.
    if (piece.length >= 3 && polygonArea(piece) > SLICE_MIN_AREA) {
      pieces.push(piece)
    }
  }
  return pieces.length ? pieces : [ring]
}
