import { writeJsonStorage } from "@/lib/storage"

const STORAGE_KEY = "holodex-nano-clicked-videos"
const CLICKED_EVENT = "holodex-nano-clicked-video"

const emptyClickedIds = new Set<string>()
let cachedSnapshot: string | null = null
let cachedIds = emptyClickedIds

export function getClickedVideoIds() {
  const snapshot = window.localStorage.getItem(STORAGE_KEY) || "[]"
  if (snapshot !== cachedSnapshot) {
    cachedSnapshot = snapshot
    try {
      const parsed = JSON.parse(snapshot)
      cachedIds = Array.isArray(parsed)
        ? new Set(parsed.map(String))
        : new Set<string>()
    } catch {
      cachedIds = new Set<string>()
    }
  }
  return cachedIds
}

export function getServerClickedVideoIds() {
  return emptyClickedIds
}

export function subscribeClickedVideos(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange)
  window.addEventListener(CLICKED_EVENT, onStoreChange)
  return () => {
    window.removeEventListener("storage", onStoreChange)
    window.removeEventListener(CLICKED_EVENT, onStoreChange)
  }
}

export function markVideoClicked(videoId: string) {
  const ids = new Set(getClickedVideoIds())
  ids.add(videoId)
  writeJsonStorage(STORAGE_KEY, [...ids])
  window.dispatchEvent(new Event(CLICKED_EVENT))
}
