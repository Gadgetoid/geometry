// Tests for the pure geometry in src/math.js. No DOM, no game state.
//
// slicePolygon gets the most attention: it is what turns a laser into cut rock,
// it has to cope with concave hulls that split into more than two pieces, and
// its half-edge walk fails quietly (via a guard counter) rather than throwing.

import test from "node:test"
import assert from "node:assert/strict"

import {
  mulberry32,
  clamp,
  lerp,
  polygonArea,
  polygonCentroid,
  boundingRadius,
  convexHull,
  pointInPolygon,
  segmentIntersection,
  countBeamCrossings,
  slicePolygon,
  convexContact,
  convexPartition,
  supportDistance,
  distanceTo,
  bearingTo,
  shortestTurn,
} from "../src/math.js"

const point = (x, y) => ({ x, y })
const SQUARE = [point(0, 0), point(10, 0), point(10, 10), point(0, 10)]

// A square with a notch cut out of the bottom middle, so a horizontal cut low
// down crosses the boundary four times and yields three pieces.
const NOTCHED = [
  point(0, 0),
  point(3, 0),
  point(3, 7),
  point(7, 7),
  point(7, 0),
  point(10, 0),
  point(10, 10),
  point(0, 10),
]

const closeTo = (actual, expected, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  )

test("mulberry32 is deterministic and stays in range", () => {
  const a = mulberry32(12345)
  const b = mulberry32(12345)
  const first = Array.from({ length: 50 }, () => a())
  const second = Array.from({ length: 50 }, () => b())
  assert.deepEqual(first, second)
  for (const value of first) {
    assert.ok(value >= 0 && value < 1, `${value} out of range`)
  }
  // a different seed diverges
  const other = mulberry32(12346)
  assert.notEqual(first[0], other())
})

test("clamp and lerp", () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-1, 0, 10), 0)
  assert.equal(clamp(11, 0, 10), 10)
  assert.equal(lerp(0, 10, 0.25), 2.5)
  assert.equal(lerp(10, 0, 0.25), 7.5)
})

test("distanceTo and bearingTo measure between two points", () => {
  assert.equal(distanceTo(point(0, 0), point(3, 4)), 5)
  assert.equal(distanceTo(point(3, 4), point(0, 0)), 5, "and either way round")
  assert.equal(distanceTo(point(-2, -2), point(-2, -2)), 0)

  const from = point(4, 4)
  assert.equal(bearingTo(from, point(9, 4)), 0, "east")
  assert.equal(bearingTo(from, point(4, 9)), Math.PI / 2, "south, y running down")
  assert.equal(bearingTo(from, point(-1, 4)), Math.PI, "west")
  assert.equal(bearingTo(from, point(4, -1)), -Math.PI / 2, "north")
  // A turret sitting exactly over its target must not draw a NaN barrel.
  assert.equal(bearingTo(from, from), 0)
})

// A heading accumulates without bound (nothing normalises Ship.angle), so this
// has to hold for inputs well outside one turn. The idiom it replaces,
// ((to - from + 3 * PI) % 2PI) - PI, is only correct while to - from > -3 * PI.
test("shortestTurn is the short way round, at any angle", () => {
  const close = (a, b, what) =>
    assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a.toFixed(4)} is not ${b.toFixed(4)}`)

  close(shortestTurn(0, 0), 0, "no turn")
  close(shortestTurn(0, 1), 1, "a short turn is itself")
  close(shortestTurn(0, Math.PI * 2 - 0.5), -0.5, "just short of a full turn goes back")
  close(shortestTurn(0.5, -0.5), -1, "across zero")

  // never further than half a turn, whatever it is given
  for (const from of [-30, -9.5, -3, 0, 3, 9.5, 30]) {
    for (const to of [-Math.PI, -1, 0, 1, Math.PI]) {
      const turn = shortestTurn(from, to)
      assert.ok(Math.abs(turn) <= Math.PI + 1e-9, `${from} to ${to} turned ${turn}`)
      // and it lands on the target bearing, give or take whole turns
      const landed = from + turn
      const off = Math.abs(((landed - to) / (Math.PI * 2)) % 1)
      assert.ok(off < 1e-9 || Math.abs(off - 1) < 1e-9, `${from} to ${to} landed at ${landed}`)
    }
  }
})

test("polygonArea is winding-independent", () => {
  assert.equal(polygonArea(SQUARE), 100)
  assert.equal(polygonArea([...SQUARE].reverse()), 100)
  assert.equal(polygonArea([point(0, 0), point(4, 0), point(0, 3)]), 6)
  assert.equal(polygonArea(NOTCHED), 72)
})

test("polygonCentroid finds the area-weighted centre", () => {
  const c = polygonCentroid(SQUARE)
  closeTo(c.x, 5)
  closeTo(c.y, 5)
})

test("polygonCentroid falls back to the vertex average when degenerate", () => {
  // a zero-area sliver: all points collinear
  const c = polygonCentroid([point(0, 0), point(2, 0), point(4, 0)])
  closeTo(c.x, 2)
  closeTo(c.y, 0)
})

test("boundingRadius measures to the furthest vertex", () => {
  closeTo(boundingRadius(SQUARE, point(5, 5)), Math.hypot(5, 5))
  closeTo(boundingRadius(SQUARE, point(0, 0)), Math.hypot(10, 10))
})

test("convexHull discards interior points", () => {
  const hull = convexHull([...SQUARE, point(5, 5), point(2, 3)])
  assert.equal(hull.length, 4)
  assert.equal(polygonArea(hull), 100)
})

test("convexHull passes through fewer than three points", () => {
  assert.equal(convexHull([point(1, 1)]).length, 1)
  assert.equal(convexHull([point(1, 1), point(2, 2)]).length, 2)
})

test("pointInPolygon", () => {
  assert.equal(pointInPolygon(point(5, 5), SQUARE), true)
  assert.equal(pointInPolygon(point(-1, 5), SQUARE), false)
  assert.equal(pointInPolygon(point(15, 5), SQUARE), false)
  // inside the bounding box but within the notch, so outside the shape
  assert.equal(pointInPolygon(point(5, 3), NOTCHED), false)
  assert.equal(pointInPolygon(point(5, 9), NOTCHED), true)
})

test("segmentIntersection", () => {
  const hit = segmentIntersection(point(0, 0), point(10, 10), point(0, 10), point(10, 0))
  closeTo(hit.x, 5)
  closeTo(hit.y, 5)
  // parallel
  assert.equal(segmentIntersection(point(0, 0), point(10, 0), point(0, 1), point(10, 1)), null)
  // would cross if extended, but the segments do not reach
  assert.equal(segmentIntersection(point(0, 0), point(1, 0), point(5, -1), point(5, 1)), null)
})

test("countBeamCrossings", () => {
  const through = { a: point(-5, 5), b: point(15, 5) }
  assert.equal(countBeamCrossings(through, SQUARE), 2)
  const missing = { a: point(-5, 20), b: point(15, 20) }
  assert.equal(countBeamCrossings(missing, SQUARE), 0)
  // a beam stopping inside the shape only crosses on the way in
  const stopping = { a: point(-5, 5), b: point(5, 5) }
  assert.equal(countBeamCrossings(stopping, SQUARE), 1)
})

test("slicePolygon halves a convex polygon and conserves area", () => {
  const pieces = slicePolygon(SQUARE, point(5, 5), point(0, 1))
  assert.equal(pieces.length, 2)
  const areas = pieces.map(polygonArea).sort((a, b) => a - b)
  closeTo(areas[0], 50, 1e-6)
  closeTo(areas[1], 50, 1e-6)
})

test("slicePolygon cuts off-centre without losing area", () => {
  const pieces = slicePolygon(SQUARE, point(5, 2), point(0, 1))
  assert.equal(pieces.length, 2)
  const total = pieces.reduce((sum, p) => sum + polygonArea(p), 0)
  closeTo(total, 100, 1e-6)
  const areas = pieces.map(polygonArea).sort((a, b) => a - b)
  closeTo(areas[0], 20, 1e-6)
  closeTo(areas[1], 80, 1e-6)
})

test("slicePolygon returns the polygon intact when the line misses it", () => {
  const pieces = slicePolygon(SQUARE, point(5, 50), point(0, 1))
  assert.equal(pieces.length, 1)
  closeTo(polygonArea(pieces[0]), 100, 1e-6)
})

test("slicePolygon leaves a polygon whole when the line only touches a vertex", () => {
  const triangle = [point(0, 0), point(10, 0), point(5, 10)]
  const pieces = slicePolygon(triangle, point(5, 10), point(0, 1))
  assert.equal(pieces.length, 1)
  closeTo(polygonArea(pieces[0]), 50, 1e-6)
})

test("slicePolygon splits a concave polygon into three pieces", () => {
  // a horizontal cut at y=3 passes through both legs of the notched square,
  // crossing the boundary four times
  const pieces = slicePolygon(NOTCHED, point(5, 3), point(0, 1))
  assert.equal(pieces.length, 3)
  const areas = pieces.map(polygonArea).sort((a, b) => a - b)
  closeTo(areas[0], 9, 1e-6)
  closeTo(areas[1], 9, 1e-6)
  closeTo(areas[2], 54, 1e-6)
  closeTo(
    areas.reduce((sum, a) => sum + a, 0),
    polygonArea(NOTCHED),
    1e-6,
  )
})

test("slicePolygon conserves area across many random cuts", () => {
  const rng = mulberry32(99)
  for (let i = 0; i < 200; i++) {
    const hull = convexHull(
      Array.from({ length: 9 }, () => {
        const a = rng() * Math.PI * 2
        const r = 20 + rng() * 40
        return point(Math.cos(a) * r, Math.sin(a) * r)
      }),
    )
    const angle = rng() * Math.PI * 2
    const normal = point(Math.cos(angle), Math.sin(angle))
    const on = point((rng() - 0.5) * 40, (rng() - 0.5) * 40)
    const pieces = slicePolygon(hull, on, normal)
    const total = pieces.reduce((sum, p) => sum + polygonArea(p), 0)
    closeTo(total, polygonArea(hull), 1e-6)
  }
})

test("slicePolygon passes through degenerate input", () => {
  const line = [point(0, 0), point(1, 1)]
  const pieces = slicePolygon(line, point(0, 0), point(0, 1))
  assert.equal(pieces.length, 1)
  assert.equal(pieces[0].length, 2)
})

// ---------------------------------------------------------------------------
// Contact solving
// ---------------------------------------------------------------------------

// Independent overlap test, deliberately not sharing code with convexContact:
// any edge crossing, or either polygon containing the other's vertex.
function polygonsOverlap(a, b) {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const hit = segmentIntersection(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])
      if (hit) {
        return true
      }
    }
  }
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a)
}

const shifted = (poly, dx, dy) => poly.map((p) => point(p.x + dx, p.y + dy))

test("supportDistance measures reach in a direction", () => {
  const centre = point(5, 5)
  closeTo(supportDistance(SQUARE, centre, 1, 0), 5)
  closeTo(supportDistance(SQUARE, centre, 0, 1), 5)
  const diag = Math.SQRT1_2
  closeTo(supportDistance(SQUARE, centre, diag, diag), Math.hypot(5, 5), 1e-9)
})

test("convexContact ignores separated polygons", () => {
  assert.equal(convexContact(SQUARE, shifted(SQUARE, 20, 0), point(5, 5), point(25, 5)), null)
  assert.equal(convexContact(SQUARE, shifted(SQUARE, 0, 40), point(5, 5), point(5, 45)), null)
})

// The centres only orient the normal; they must not decide whether the pair
// touches. bodyContact compares part against part while passing the whole
// bodies' centres, so a part pair can easily be handed centres pointing the
// opposite way to their own arrangement. Testing only `aMax > bMin` read that as
// an overlap 30 wide, which is what put a spurious push between debris pieces
// that were a unit apart.
test("convexContact ignores separated polygons whatever centres it is given", () => {
  const a = SQUARE // x in [0, 10]
  const b = shifted(SQUARE, 20, 0) // x in [20, 30], plainly clear of it
  assert.equal(polygonsOverlap(a, b), false, "the pair must really be apart")
  // centres the right way round, and deliberately the wrong way round
  assert.equal(convexContact(a, b, point(5, 5), point(25, 5)), null)
  assert.equal(convexContact(a, b, point(100, 5), point(0, 5)), null)
  assert.equal(convexContact(a, b, point(0, 0), point(0, 0)), null)
})

test("convexContact reports the shallowest separating push", () => {
  const b = shifted(SQUARE, 8, 0)
  const hit = convexContact(SQUARE, b, point(5, 5), point(13, 5))
  closeTo(hit.depth, 2)
  closeTo(hit.nx, 1)
  closeTo(hit.ny, 0)
})

test("convexContact normal always points from a to b", () => {
  const b = shifted(SQUARE, -8, 0)
  const hit = convexContact(SQUARE, b, point(5, 5), point(-3, 5))
  closeTo(hit.depth, 2)
  closeTo(hit.nx, -1)
  closeTo(hit.ny, 0)
})

test("convexContact separates an overlapping pair in one application", () => {
  const b = shifted(SQUARE, 7, 3)
  const hit = convexContact(SQUARE, b, point(5, 5), point(12, 8))
  assert.ok(hit, "expected an overlap")
  // overlap is 3 wide in x against 7 tall in y, so the shallow way out is +x
  closeTo(hit.depth, 3)
  closeTo(hit.nx, 1)
  // the push lands them exactly flush, so nudge past that to test separation
  const clear = shifted(b, hit.nx * (hit.depth + 1e-6), hit.ny * (hit.depth + 1e-6))
  assert.equal(polygonsOverlap(SQUARE, clear), false)
})

test("convexContact agrees with an independent overlap test on random hulls", () => {
  const rng = mulberry32(4242)
  let overlapping = 0
  for (let i = 0; i < 500; i++) {
    const hull = (ox, oy) =>
      convexHull(
        Array.from({ length: 7 }, () => {
          const a = rng() * Math.PI * 2
          const r = 10 + rng() * 25
          return point(ox + Math.cos(a) * r, oy + Math.sin(a) * r)
        }),
      )
    const a = hull(0, 0)
    const b = hull((rng() - 0.5) * 90, (rng() - 0.5) * 90)
    const expected = polygonsOverlap(a, b)
    const hit = convexContact(a, b, polygonCentroid(a), polygonCentroid(b))
    assert.equal(!!hit, expected, `disagreed on pair ${i}`)
    if (hit) {
      overlapping++
      // applying the push must actually resolve the overlap
      const moved = shifted(b, hit.nx * (hit.depth + 1e-6), hit.ny * (hit.depth + 1e-6))
      assert.equal(polygonsOverlap(a, moved), false, `push did not separate pair ${i}`)
    }
  }
  assert.ok(overlapping > 50, `expected a decent number of overlaps, got ${overlapping}`)
})

// ---- convexPartition ------------------------------------------------------
// Contacts are solved part against part, so a partition is only correct if the
// parts are all convex and together they tile the original exactly.

const partsOf = (verts) => convexPartition(verts).map((part) => part.map((i) => verts[i]))

function isConvex(vertices) {
  let winding = 0
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i],
      b = vertices[(i + 1) % vertices.length],
      c = vertices[(i + 2) % vertices.length]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < 1e-9) {
      continue
    }
    const sign = Math.sign(cross)
    if (winding === 0) {
      winding = sign
    } else if (sign !== winding) {
      return false
    }
  }
  return true
}

// An L: one reflex corner, so two parts and no new vertices.
const L_SHAPE = [
  { x: 0, y: 0 },
  { x: 60, y: 0 },
  { x: 60, y: 20 },
  { x: 20, y: 20 },
  { x: 20, y: 60 },
  { x: 0, y: 60 },
]

test("convexPartition leaves a convex polygon whole", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ]
  assert.deepEqual(convexPartition(square), [[0, 1, 2, 3]])
})

test("convexPartition splits a concave polygon into convex parts", () => {
  const parts = partsOf(L_SHAPE)
  assert.ok(parts.length >= 2)
  for (const part of parts) {
    assert.ok(isConvex(part), "every part must be convex")
  }
})

test("convexPartition conserves area", () => {
  const total = partsOf(L_SHAPE).reduce((sum, part) => sum + polygonArea(part), 0)
  assert.ok(Math.abs(total - polygonArea(L_SHAPE)) < 1e-9)
})

test("convexPartition indexes the original vertices, so parts follow it", () => {
  for (const part of convexPartition(L_SHAPE)) {
    for (const index of part) {
      assert.ok(Number.isInteger(index) && index >= 0 && index < L_SHAPE.length)
    }
  }
})

test("convexPartition handles random concave polygons", () => {
  const rng = mulberry32(99)
  for (let trial = 0; trial < 200; trial++) {
    const count = 5 + Math.floor(rng() * 8)
    const poly = []
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2
      const radius = 20 + rng() * 80 // a wandering radius makes it concave
      poly.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
    }
    const parts = partsOf(poly)
    const total = parts.reduce((sum, part) => sum + polygonArea(part), 0)
    assert.ok(
      Math.abs(total - polygonArea(poly)) < 1e-6 * Math.max(1, polygonArea(poly)),
      "parts must tile the polygon",
    )
    for (const part of parts) {
      assert.ok(isConvex(part), "every part must be convex")
    }
  }
})

test("convexPartition passes through degenerate input", () => {
  assert.deepEqual(convexPartition([]), [[]])
  assert.deepEqual(convexPartition([{ x: 0, y: 0 }]), [[0]])
})

test("a separating-axis test on a concave outline reports a contact across its notch", () => {
  // Why the partition exists: a square parked in the L's notch touches nothing,
  // but SAT on the whole concave outline says they overlap. Solved part against
  // part, the same pair comes out apart.
  const inNotch = [
    { x: 30, y: 30 },
    { x: 55, y: 30 },
    { x: 55, y: 55 },
    { x: 30, y: 55 },
  ]
  const centreOf = (v) => ({
    x: v.reduce((s, p) => s + p.x, 0) / v.length,
    y: v.reduce((s, p) => s + p.y, 0) / v.length,
  })
  assert.ok(
    convexContact(L_SHAPE, inNotch, centreOf(L_SHAPE), centreOf(inNotch)),
    "whole concave outline: phantom contact",
  )
  const apart = partsOf(L_SHAPE).every(
    (part) => !convexContact(part, inNotch, centreOf(part), centreOf(inNotch)),
  )
  assert.ok(apart, "partitioned: correctly apart")
})
