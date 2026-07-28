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

// Pick one entry in proportion to what `weightOf` says it weighs. A weight of
// zero is never picked, so a caller excludes an entry by weighing it nothing
// rather than by filtering the list first; nothing left to pick gives null.
//
// Every "which one turns up" roll in the game goes through here, so a share is
// always one weight against the total and never depends on what order the
// entries are in.
export function weightedPick(entries, weightOf) {
  let total = 0
  for (const entry of entries) {
    total += Math.max(0, weightOf(entry))
  }
  if (total <= 0) {
    return null
  }
  let roll = Math.random() * total
  for (const entry of entries) {
    roll -= Math.max(0, weightOf(entry))
    if (roll < 0) {
      return entry
    }
  }
  return entries[entries.length - 1] // only reachable on floating-point dust
}
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

// Distance and direction between two points, which is what every site that aims
// at something wants. Named `...To` because `distance` and `bearing` are both
// already in use as locals in the files that import these.
export const distanceTo = (from, to) => Math.hypot(to.x - from.x, to.y - from.y)
export const bearingTo = (from, to) => Math.atan2(to.y - from.y, to.x - from.x)

// The shortest way round from one angle to another, in (-PI, PI]. Neither input
// need be normalised: a ship's heading accumulates without bound, so a wrap that
// assumes a range will eventually be handed one outside it.
export const shortestTurn = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from))

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
// How far a point lies from a polygon: zero when it is inside, and the distance to the
// nearest edge when it is not. Wanted wherever something has to be assigned to the shape
// it belongs to rather than the shape that happens to contain it - a nozzle mounted just
// off the tail of a hull is on that hull, and a containment test says otherwise.
export function distanceToPolygon(point, vertices) {
  if (pointInPolygon(point, vertices)) {
    return 0
  }
  let best = Infinity
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i],
      b = vertices[(i + 1) % vertices.length]
    const vx = b.x - a.x,
      vy = b.y - a.y
    const len2 = vx * vx + vy * vy
    const t = len2 > 0 ? clamp(((point.x - a.x) * vx + (point.y - a.y) * vy) / len2, 0, 1) : 0
    best = Math.min(best, Math.hypot(point.x - (a.x + vx * t), point.y - (a.y + vy * t)))
  }
  return best
}

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

// ---------------------------------------------------------------------------
// Contact solving. Collision is broadphase then narrowphase: callers reject
// cheaply with an enclosing circle, then solve the real outlines here. The
// result is the push needed to separate the pair - a unit normal and a
// penetration depth - or null when they are genuinely apart.
//
// A circle proxy is not good enough for any of it: an asteroid can be long and
// thin and a ship hull is a sliver, so a circle around either is mostly empty
// space. Concave outlines are handled by partitioning them (see below) and
// solving part against part, so nothing is ever approximated.
// ---------------------------------------------------------------------------

// Separating axis test for two convex polygons. The normal points from `a`
// toward `b`, so `b` moves along it and `a` against it.
export function convexContact(a, b, centreA, centreB) {
  if (a.length < 3 || b.length < 3) {
    return null
  }
  // Each candidate axis is oriented from a toward b up front, so its overlap
  // has one unambiguous meaning: how far b must travel along it to clear a.
  // Choosing the axis first and the direction afterwards can pair a depth with
  // the opposite normal, which pushes the shapes further together.
  //
  // Whether the axis separates them, though, is decided from the two projected
  // intervals and not from that orientation. The centres a caller passes need not
  // be these two shapes' own: bodyContact compares part against part while
  // passing the whole bodies' centres, and a part pair whose arrangement
  // disagrees with the body-to-body direction would otherwise have its
  // separating axis oriented the wrong way and read as an overlap.
  const toBx = centreB.x - centreA.x,
    toBy = centreB.y - centreA.y
  let bestDepth = Infinity,
    bestX = 0,
    bestY = 0
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i],
        q = poly[(i + 1) % poly.length]
      let nx = -(q.y - p.y),
        ny = q.x - p.x
      const len = Math.hypot(nx, ny)
      if (len < 1e-9) {
        continue
      }
      nx /= len
      ny /= len
      if (toBx * nx + toBy * ny < 0) {
        nx = -nx
        ny = -ny
      }
      let aMin = Infinity,
        aMax = -Infinity,
        bMin = Infinity,
        bMax = -Infinity
      for (const v of a) {
        const d = v.x * nx + v.y * ny
        if (d < aMin) {
          aMin = d
        }
        if (d > aMax) {
          aMax = d
        }
      }
      for (const v of b) {
        const d = v.x * nx + v.y * ny
        if (d < bMin) {
          bMin = d
        }
        if (d > bMax) {
          bMax = d
        }
      }
      if (Math.min(aMax, bMax) <= Math.max(aMin, bMin)) {
        return null // a gap on this axis means they are apart
      }
      // The intervals overlap, so b's near face is inside a and this is positive.
      const depth = aMax - bMin
      if (depth < bestDepth) {
        bestDepth = depth
        bestX = nx
        bestY = ny
      }
    }
  }
  if (bestDepth === Infinity) {
    return null
  }
  return { nx: bestX, ny: bestY, depth: bestDepth }
}

// ---------------------------------------------------------------------------
// Convex partition. `convexContact` is a separating-axis test, so it is only
// exact for convex shapes; a ship hull and anything cut from one are concave.
// Partitioning splits such a polygon into convex parts that tile it exactly, so
// contacts stay exact without approximating the outline.
//
// Splits use only diagonals between existing vertices, so a part is a list of
// indices into the polygon's own vertex array. That means the parts follow the
// polygon as it rotates and drifts, and need computing only when the outline
// itself changes.
// ---------------------------------------------------------------------------

// Twice the signed area of triangle abc: positive when abc turns anticlockwise.
const turn2 = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

// Do segments a-b and c-d cross at an interior point of both? Shared endpoints
// and collinear touching do not count, which is what a diagonal test needs.
function properlyCross(a, b, c, d) {
  const d1 = turn2(a, b, c),
    d2 = turn2(a, b, d)
  const d3 = turn2(c, d, a),
    d4 = turn2(c, d, b)
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0
}

// Signed area of a ring; the sign is its winding.
function signedArea(ring) {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i],
      q = ring[(i + 1) % ring.length]
    sum += p.x * q.y - q.x * p.y
  }
  return sum / 2
}

// Which vertices turn against the ring's winding. An empty result means convex.
function reflexVertices(ring) {
  const winding = signedArea(ring) >= 0 ? 1 : -1
  const reflex = []
  for (let i = 0; i < ring.length; i++) {
    const prev = ring[(i - 1 + ring.length) % ring.length],
      next = ring[(i + 1) % ring.length]
    if (winding * turn2(prev, ring[i], next) < 0) {
      reflex.push(i)
    }
  }
  return reflex
}

// Is i-j a diagonal: strictly inside the ring and crossing no edge?
function isDiagonal(ring, i, j) {
  const n = ring.length
  if (i === j || (i + 1) % n === j || (j + 1) % n === i) {
    return false
  }
  const a = ring[i],
    b = ring[j]
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n
    if (k === i || k === j || k2 === i || k2 === j) {
      continue
    }
    if (properlyCross(a, b, ring[k], ring[k2])) {
      return false
    }
  }
  return pointInPolygon({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, ring)
}

// The indices from `from` to `to` inclusive, walking the ring forwards.
function walk(indices, from, to) {
  const out = []
  for (let k = from; ; k = (k + 1) % indices.length) {
    out.push(indices[k])
    if (k === to) {
      return out
    }
  }
}

// Partition a simple polygon into convex parts, each a list of indices into
// `vertices`. A convex polygon yields a single part covering every vertex. A
// part that cannot be resolved (degenerate or self-touching input) is returned
// as it is, so callers always get a partition covering the whole outline.
export function convexPartition(vertices) {
  const all = vertices.map((_, i) => i)
  if (vertices.length < 4) {
    return [all]
  }
  const parts = []
  const pending = [all]
  // Each split replaces one ring with two strictly smaller ones, so a
  // triangulation is the worst case and this bound is never reached.
  let guard = 4 * vertices.length + 16
  while (pending.length && guard-- > 0) {
    const indices = pending.pop()
    const ring = indices.map((i) => vertices[i])
    const reflex = ring.length > 3 ? reflexVertices(ring) : []
    if (!reflex.length) {
      parts.push(indices)
      continue
    }
    const from = reflex[0]
    // A diagonal joining two reflex vertices resolves both at once, so try
    // those first; a cut to any other vertex still resolves `from`, just less
    // efficiently. Fewer parts means fewer contact tests later.
    const candidates = []
    for (let step = 2; step < ring.length - 1; step++) {
      candidates.push((from + step) % ring.length)
    }
    candidates.sort((a, b) => reflex.includes(b) - reflex.includes(a))
    const split = candidates.find((candidate) => isDiagonal(ring, from, candidate))
    if (split === undefined) {
      parts.push(indices) // no diagonal resolves it; leave the ring whole
      continue
    }
    pending.push(walk(indices, from, split), walk(indices, split, from))
  }
  return parts.concat(pending)
}

// How far the polygon reaches from `centre` in direction (ux, uy).
export function supportDistance(vertices, centre, ux, uy) {
  let far = 0
  for (const p of vertices) {
    const d = (p.x - centre.x) * ux + (p.y - centre.y) * uy
    if (d > far) {
      far = d
    }
  }
  return far
}

// How far along a->b the centreline first enters the polygon, or null if it
// never does. Zero when `a` is already inside. Used to stop a beam at the near
// face of a ship rather than at a circle drawn around it.
function segmentCentrelineEntry(a, b, vertices) {
  if (vertices.length < 3) {
    return null
  }
  if (pointInPolygon(a, vertices)) {
    return 0
  }
  let nearest = null
  for (let i = 0; i < vertices.length; i++) {
    const hit = segmentIntersection(a, b, vertices[i], vertices[(i + 1) % vertices.length])
    if (!hit) {
      continue
    }
    const along = Math.hypot(hit.x - a.x, hit.y - a.y)
    if (nearest === null || along < nearest) {
      nearest = along
    }
  }
  return nearest
}

// How far along a->b a beam of the given half-width first touches the polygon,
// or null if it never does. A beam is a capsule and not a line: the view draws
// it `2 * halfWidth` across, so a shot whose bright edge covers a hull is a shot
// that connects. Testing the centreline instead leaves a beam visibly laid over
// a ship registering nothing.
//
// The reachable region is the polygon grown by halfWidth, which is the union of
// the polygon itself, a disc at every vertex and a slab along every edge. Each
// is solved exactly and the nearest contact wins, so no part of the outline is
// approximated.
export function segmentPolygonEntry(a, b, vertices, halfWidth = 0) {
  const direct = segmentCentrelineEntry(a, b, vertices)
  if (halfWidth <= 0 || direct === 0) {
    return direct
  }
  let nearest = direct
  const consider = (value) => {
    if (value !== null && (nearest === null || value < nearest)) {
      nearest = value
    }
  }
  for (let i = 0; i < vertices.length; i++) {
    const p = vertices[i],
      q = vertices[(i + 1) % vertices.length]
    consider(segmentCircleEntry(a, b, p, halfWidth))
    let nx = -(q.y - p.y),
      ny = q.x - p.x
    const len = Math.hypot(nx, ny)
    if (len < 1e-9) {
      continue
    }
    nx /= len
    ny /= len
    for (const side of [halfWidth, -halfWidth]) {
      const hit = segmentIntersection(
        a,
        b,
        { x: p.x + nx * side, y: p.y + ny * side },
        { x: q.x + nx * side, y: q.y + ny * side },
      )
      if (hit) {
        consider(Math.hypot(hit.x - a.x, hit.y - a.y))
      }
    }
  }
  return nearest
}

// How far along a->b the segment first enters the circle, or null if it never
// does. Zero when `a` is already inside. The circle counterpart of
// segmentPolygonEntry, for a surface that really is round - a shield bubble is
// drawn as one, so a circle is the shape and not a proxy for it.
export function segmentCircleEntry(a, b, centre, radius) {
  if (radius <= 0) {
    return null
  }
  const dx = b.x - a.x,
    dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  if (length < 1e-9) {
    return null
  }
  const ux = dx / length,
    uy = dy / length
  // closest approach of the infinite line, measured along it
  const along = (centre.x - a.x) * ux + (centre.y - a.y) * uy
  const px = a.x + ux * along,
    py = a.y + uy * along
  const perpendicularDistance = Math.hypot(centre.x - px, centre.y - py)
  if (perpendicularDistance >= radius) {
    return null
  }
  const half = Math.sqrt(radius * radius - perpendicularDistance * perpendicularDistance)
  if (along - half > length || along + half < 0) {
    return null // the circle lies wholly beyond one end of the segment
  }
  return Math.max(0, along - half)
}

// How far the outline lies from an interior point along a direction. Zero when
// the ray never meets it, which a sane outline cannot do. Used to place
// something on a body at a bearing rather than at one of its vertices, so
// several of them can be spread around it whatever shape it is.
export function boundaryDistance(vertices, from, ux, uy, maxReach) {
  const to = { x: from.x + ux * maxReach, y: from.y + uy * maxReach }
  let nearest = 0
  for (let i = 0; i < vertices.length; i++) {
    const hit = segmentIntersection(from, to, vertices[i], vertices[(i + 1) % vertices.length])
    if (!hit) {
      continue
    }
    const along = Math.hypot(hit.x - from.x, hit.y - from.y)
    if (nearest === 0 || along < nearest) {
      nearest = along
    }
  }
  return nearest
}

// How far along the ray from `from` in direction (ux, uy) the point is still
// inside an axis-aligned rectangle, i.e. where it leaves for good. Zero when the
// ray never passes through it at all. Used to put something beyond the view
// rather than merely beyond the arena.
export function rayExitDistance(from, ux, uy, centre, halfWidth, halfHeight) {
  let exit = Infinity
  for (const [origin, direction, half, middle] of [
    [from.x, ux, halfWidth, centre.x],
    [from.y, uy, halfHeight, centre.y],
  ]) {
    const lo = middle - half,
      hi = middle + half
    if (Math.abs(direction) < 1e-9) {
      if (origin < lo || origin > hi) {
        return 0 // parallel to this pair of edges and outside them
      }
      continue // parallel and between them, so this axis never ends the ray
    }
    exit = Math.min(exit, Math.max((lo - origin) / direction, (hi - origin) / direction))
  }
  return exit === Infinity || exit < 0 ? 0 : exit
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

// Take a slab out of a polygon rather than cutting it in two: everything within `halfWidth` of
// the line is gone, and what is left either side comes back. Two ordinary slices, each keeping
// only the pieces on the far side of its own edge, so the middle belongs to neither and is not
// returned at all.
//
// Three answers, and a caller has to tell them apart:
//   null  the line does not pass through the polygon, so there is nothing to take out. The same
//         answer an ordinary slice gives for a graze.
//   []    the polygon was narrower than the slab and there is nothing left of it.
//   [..]  what survives either side. One piece means the slab reached past one edge of it.
export function sliceOutSlab(vertices, pointOnLine, normal, halfWidth) {
  // Checked on the centre line, because that is what decides whether this is a cut at all. With
  // it established, an edge that fails to cut is one the slab has swallowed that side of.
  if (slicePolygon(vertices, pointOnLine, normal).length < 2) {
    return null
  }
  const length = Math.hypot(normal.x, normal.y) || 1
  const ux = normal.x / length,
    uy = normal.y / length
  const outer = []
  for (const side of [1, -1]) {
    const edge = {
      x: pointOnLine.x + ux * halfWidth * side,
      y: pointOnLine.y + uy * halfWidth * side,
    }
    for (const part of slicePolygon(vertices, edge, { x: ux, y: uy })) {
      const centre = polygonCentroid(part)
      const beyond = (centre.x - edge.x) * ux + (centre.y - edge.y) * uy
      // Only what lies past this edge, and only where the edge actually cut: a single part
      // sitting on the near side is the whole polygon, which this side has no claim on.
      if (Math.sign(beyond) === side && polygonArea(part) < polygonArea(vertices)) {
        outer.push(part)
      }
    }
  }
  return outer
}

// Which way is out of a polygon, at a point inside it: the outward normal of the edge nearest that
// point. Oriented away from the centroid, so it does not depend on which way the outline is wound.
//
// For a turret sitting on a rock this is the direction it can shoot in without shooting through its
// own rock, and it is asked of the outline as it stands rather than remembered: a rock spins, and a
// piece cut off one has a different nearest edge and a different middle to be outward of.
export function outwardNormal(vertices, point) {
  const middle = polygonCentroid(vertices)
  let best = null,
    nearest = Infinity
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i],
      b = vertices[(i + 1) % vertices.length]
    const ex = b.x - a.x,
      ey = b.y - a.y
    const len = ex * ex + ey * ey
    // Where along the edge the point lies, held to the edge itself so a corner answers as a corner.
    const along = len > 0 ? clamp(((point.x - a.x) * ex + (point.y - a.y) * ey) / len, 0, 1) : 0
    const cx = a.x + ex * along,
      cy = a.y + ey * along
    const away = (point.x - cx) ** 2 + (point.y - cy) ** 2
    if (away < nearest) {
      nearest = away
      best = { x: -ey, y: ex, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
    }
  }
  if (!best) {
    return { x: 1, y: 0 }
  }
  const length = Math.hypot(best.x, best.y) || 1
  let nx = best.x / length,
    ny = best.y / length
  if ((best.mid.x - middle.x) * nx + (best.mid.y - middle.y) * ny < 0) {
    nx = -nx
    ny = -ny
  }
  return { x: nx, y: ny }
}
