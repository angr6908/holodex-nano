export function readJsonStorage(key: string): unknown {
  if (typeof window === "undefined") return null
  try {
    return JSON.parse(window.localStorage.getItem(key) || "null")
  } catch {
    return null
  }
}

export function writeJsonStorage(key: string, value: unknown) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}
