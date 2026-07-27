// The ship editor is a single module inside ship-editor.html, so nothing else in
// the suite touches it and a fault there is only found by opening the page. This
// boots it against a stub DOM and runs a few frames, which is enough to catch the
// kind of break that a syntax check cannot see: a binding read before it is
// initialised, a helper that no longer exists, a registry renamed out from under
// it.
//
// Running frames is the point. The draw loop is where most of that shows, and a
// requestAnimationFrame that never calls back sees none of it.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const noop = () => {}

// Enough of an element for the editor to build its panels against.
function element(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    children: [],
    value: "",
    textContent: "",
    innerHTML: "",
    checked: false,
    hidden: false,
    clientWidth: 800,
    clientHeight: 600,
    width: 800,
    height: 600,
    append: (...kids) => el.children.push(...kids),
    appendChild: (kid) => (el.children.push(kid), kid),
    prepend: (...kids) => el.children.unshift(...kids),
    addEventListener: noop,
    removeEventListener: noop,
    setAttribute: noop,
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    remove: noop,
    focus: noop,
    select: noop,
    getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
    // Every 2D context call is a no-op; only that they are reached matters here.
    getContext: () =>
      new Proxy(
        { canvas: { width: 800, height: 600 }, measureText: () => ({ width: 10 }) },
        { get: (target, key) => (key in target ? target[key] : noop), set: () => true },
      ),
  }
  return el
}

function stubDom(stored = null) {
  const previous = new Map()
  const storage = { removed: [], written: [] }
  const set = (key, value) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  let frames = 0
  set("document", {
    getElementById: () => element(),
    createElement: (tag) => element(tag),
    createElementNS: (_ns, tag) => element(tag),
    querySelector: () => element(),
    querySelectorAll: () => [],
    addEventListener: noop,
    body: element(),
    documentElement: element(),
    fonts: { ready: Promise.resolve() },
  })
  set("window", {
    addEventListener: noop,
    removeEventListener: noop,
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
  })
  set("navigator", { clipboard: { writeText: async () => {} }, userAgent: "node" })
  set("location", { search: "", protocol: "file:", hostname: "" })
  set("localStorage", {
    getItem: () => stored,
    setItem: (_key, value) => storage.written.push(value),
    removeItem: (key) => storage.removed.push(key),
  })
  set(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
  set("prompt", () => null)
  set("alert", noop)
  set("requestAnimationFrame", (fn) => {
    if (frames++ < 3) {
      queueMicrotask(() => fn(frames * 16))
    }
    return frames
  })
  set("cancelAnimationFrame", noop)
  return {
    framesRun: () => frames,
    storage,
    restore() {
      for (const [key, descriptor] of previous) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor)
        } else {
          delete globalThis[key]
        }
      }
    },
  }
}

// The module imports ./src/*.js, so it has to run from the same directory the page
// does. Written beside it and removed again whatever happens. The query string
// keeps each boot out of the module cache.
//
// `expose` is a list of the module's own bindings to hand back, which is how a test
// can drive the editor rather than only watch it start. The page has nothing in it
// for the sake of being tested: the line that reaches in is written here.
async function boot(dom, tag, expose = []) {
  const page = readFileSync(join(root, "ship-editor.html"), "utf8")
  const body = page.match(/<script type="module">([\s\S]*?)<\/script>/)
  assert.ok(body, "ship-editor.html must hold one module script")
  const probe = expose.length
    ? `\nglobalThis.__editor = { ${expose.join(", ")}, setShip: (s) => { ship = s } }\n`
    : ""
  const scratch = join(root, `.editor-under-test-${tag}.mjs`)
  writeFileSync(scratch, body[1] + probe)
  try {
    await import(`${scratch}?t=${tag}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    return globalThis.__editor
  } finally {
    dom.restore()
    unlinkSync(scratch)
  }
}

test("the ship editor loads and draws against the registries it reads", async () => {
  const dom = stubDom()
  await boot(dom, "fresh")
  assert.ok(dom.framesRun() > 0, "the draw loop must have run at least one frame")
})

test("the editor throws away saved state from before the units changed", async () => {
  // What a browser was left holding when outlines moved to world units: a hull a
  // tenth of the size it should be, and a grid step no longer on offer, which
  // together look exactly like the editor being broken.
  const stale = JSON.stringify({
    ship: {
      outline: [
        [1.4, 0],
        [-0.8, -0.85],
        [-0.4, 0],
        [-0.8, 0.85],
      ],
      mass: 1,
    },
    options: { grid: 0.05 },
  })
  const dom = stubDom(stale)
  await boot(dom, "stale")
  assert.ok(
    dom.storage.removed.includes("geometry-ship-editor"),
    "a payload with no version must be cleared rather than loaded",
  )
})

// The editor is what writes config.js, so a model change that does not reach it is
// a change that quietly cannot be authored: every ship design has been through here
// and out the other side wrong at least once. Loading each design and reading the
// snippet back is the check that catches it.
test("every design in config.js survives a trip through the editor", async () => {
  const dom = stubDom()
  const editor = await boot(dom, "roundtrip", ["fromType", "snippet", "derived", "SHIP_TYPES"])
  const { fromType, snippet, derived, setShip, SHIP_TYPES } = editor

  for (const [key, type] of Object.entries(SHIP_TYPES)) {
    setShip(fromType(type, "rival", key))
    const out = snippet()

    // The core, and whatever the design fits inside it. The editor knew nothing of
    // cores when they landed, so it wrote the core hardpoint out as empty.
    const core = (type.loadout || []).find((entry) => entry.core)
    assert.match(out, new RegExp(`core: "${core.core}"`), `${key} states its core`)
    for (const [slot, id] of Object.entries(core.fitted || {})) {
      assert.match(out, new RegExp(`${slot}: "${id}"`), `${key} keeps ${id} in its ${slot} slot`)
    }

    // An arm is a chance, so losing the chance changes how often the hull turns up
    // carrying the thing.
    for (const [name, arm] of Object.entries(type.arms || {})) {
      assert.match(out, new RegExp(`${name}: \\{`), `${key} keeps its ${name} arm`)
      assert.match(
        out,
        new RegExp(`chancePerSector: ${arm.chancePerSector}`),
        `${key}'s ${name} arm keeps its per-sector chance`,
      )
    }

    // What its wreckage is made of decides what colour it burns, so a hull is plated
    // with its own faction's stuff.
    const plating = type.faction === "alien" ? "ALIEN_PLATING" : "SHIP_PLATING"
    assert.match(out, new RegExp(`debrisMaterial: ${plating},`), `${key} keeps its plating`)

    // Stating a derived field freezes it, so the editor writes none of them.
    for (const field of ["accel", "maxSpeed", "turnRate", "drag", "energyMax", "regen", "hull:"]) {
      assert.doesNotMatch(out, new RegExp(`\\b${field}`), `${key} does not state ${field}`)
    }
    // A spawn block that says nothing about how many may be alive means no limit.
    assert.equal(
      /maxConcurrent/.test(out),
      type.spawn.maxConcurrent !== undefined,
      `${key} keeps whether it limits how many are alive at once`,
    )

    // And what it flies like is still what config.js says it flies like.
    const stats = derived()
    for (const field of ["accel", "maxSpeed", "turnRate", "energyMax", "regen", "hull"]) {
      assert.equal(stats[field], type[field], `${key} derives the same ${field}`)
    }
  }
})

test("the player's hardpoints are the shop's, and the editor leaves them to it", async () => {
  const dom = stubDom()
  const { fromType, snippet, setShip, PLAYER_TYPE, EQUIPMENT } = await boot(dom, "player", [
    "fromType",
    "snippet",
    "PLAYER_TYPE",
    "EQUIPMENT",
  ])
  setShip(fromType(PLAYER_TYPE, "player", "player"))
  const out = snippet()

  // Everything the shop fits is named against a hardpoint, and stating it here
  // instead would hand the player whatever the editor happened to be showing.
  // Only what the yard offers for this hull: a locked option is another hull's own kit,
  // and a design that carries one states it like any other module.
  for (const [slot, spec] of Object.entries(EQUIPMENT)) {
    for (const option of spec.options.filter((entry) => !entry.locked)) {
      assert.doesNotMatch(out, new RegExp(option.id), `${slot}'s ${option.id} is the shop's to fit`)
    }
  }
  assert.match(out, /faction: "player"/, "the player's hull says which faction it is")
  assert.match(out, /confineRadius: 13/, "and how far the arena lets it reach")
  assert.match(out, /startingSpecials: \["oreMagnet"\]/, "and what it launches carrying")
  assert.match(out, /core: "minerCore"/, "the core is the hull's own, so it is stated")
})
