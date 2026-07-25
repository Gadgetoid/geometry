// What the game remembers between sessions, in IndexedDB: the best score, the run in
// progress, and the settings. Best-effort throughout, and every failure is swallowed
// so the game still runs where storage is unavailable (over file:// it may be
// blocked, and then nothing is remembered but nothing breaks either).

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("geometry2", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("kv")
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// One key/value store, so a new thing to remember is a new key and nothing else.
async function load(key) {
  try {
    const db = await openDatabase()
    const request = db.transaction("kv", "readonly").objectStore("kv").get(key)
    const value = await new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    })
    return value ?? null
  } catch {
    return null
  }
}

async function save(key, value) {
  try {
    const db = await openDatabase()
    db.transaction("kv", "readwrite").objectStore("kv").put(value, key)
  } catch {
    /* ignore */
  }
}

async function remove(key) {
  try {
    const db = await openDatabase()
    db.transaction("kv", "readwrite").objectStore("kv").delete(key)
  } catch {
    /* ignore */
  }
}

export const loadBest = () => load("best")
export const saveBest = (best) => save("best", best)

// The run in progress, so closing the game does not throw away an evening's
// upgrades. Written at the shop, which is the one point where nothing is in flight.
export const loadRun = () => load("run")
export const saveRun = (run) => save("run", run)
export const clearRun = () => remove("run")

// Volume and the rest, kept apart from the run so resetting progress does not also
// reset how loud the game is.
export const loadSettings = () => load("settings")
export const saveSettings = (settings) => save("settings", settings)

// Control bindings, on their own key so resetting progress or settings does not
// also throw away a player's remapped controls.
export const loadBindings = () => load("bindings")
export const saveBindings = (bindings) => save("bindings", bindings)
