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
  distanceToSegment,
  countBeamCrossings,
  slicePolygon,
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

test("distanceToSegment clamps to the endpoints", () => {
  closeTo(distanceToSegment(5, 3, 0, 0, 10, 0), 3)
  closeTo(distanceToSegment(-4, 0, 0, 0, 10, 0), 4) // past the A end
  closeTo(distanceToSegment(14, 0, 0, 0, 10, 0), 4) // past the B end
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
