// High-score persistence in IndexedDB. Best-effort: failures are swallowed so
// the game still runs (e.g. over file://, where IndexedDB may be blocked).

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("geometry2", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("kv")
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function loadBest() {
  try {
    const db = await openDatabase()
    const request = db.transaction("kv", "readonly").objectStore("kv").get("best")
    const value = await new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    })
    return value || null
  } catch {
    return null
  }
}

export async function saveBest(best) {
  try {
    const db = await openDatabase()
    db.transaction("kv", "readwrite").objectStore("kv").put(best, "best")
  } catch {
    /* ignore */
  }
}
