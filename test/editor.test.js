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

function stubDom() {
  const previous = new Map()
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
  set("localStorage", { getItem: () => null, setItem: noop, removeItem: noop })
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

test("the ship editor loads and draws against the registries it reads", async () => {
  const page = readFileSync(join(root, "ship-editor.html"), "utf8")
  const body = page.match(/<script type="module">([\s\S]*?)<\/script>/)
  assert.ok(body, "ship-editor.html must hold one module script")

  // The module imports ./src/*.js, so it has to run from the same directory the
  // page does. Written beside it and removed again whatever happens.
  const scratch = join(root, ".editor-under-test.mjs")
  writeFileSync(scratch, body[1])
  const dom = stubDom()
  try {
    await import(`${scratch}?t=${Date.now()}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(dom.framesRun() > 0, "the draw loop must have run at least one frame")
  } finally {
    dom.restore()
    unlinkSync(scratch)
  }
})
