import type { HolodexVideo } from "@/lib/types"
import { getTwitchLogin } from "@/lib/video-utils"

const TWITCH_GQL_ENDPOINTS = ["/twitch-gql", "https://gql.twitch.tv/gql"] as const
const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"
const CACHE_TTL_MS = 60_000
const STORAGE_KEY = "holodex-nano-twitch-viewer-counts"

const viewerCountCache = new Map<string, { ts: number; value: number }>()
const inflightRequests = new Map<string, Promise<Record<string, number>>>()

function normalizeLogin(login: string) {
  return login.trim().toLowerCase()
}

function readPersistedCache() {
  if (typeof window === "undefined" || viewerCountCache.size) return
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}")
    Object.entries(parsed || {}).forEach(([login, entry]) => {
      const value = entry as { ts?: number; value?: number }
      if (Number.isFinite(value.ts) && Number.isFinite(value.value)) {
        viewerCountCache.set(normalizeLogin(login), {
          ts: Number(value.ts),
          value: Number(value.value),
        })
      }
    })
  } catch {}
}

function persistViewerCountCache() {
  if (typeof window === "undefined") return
  try {
    const now = Date.now()
    const serializable = Object.fromEntries(
      Array.from(viewerCountCache.entries()).filter(
        ([, entry]) => now - entry.ts <= CACHE_TTL_MS
      )
    )
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable))
  } catch {}
}

function getCachedViewerCount(login: string) {
  readPersistedCache()
  const normalized = normalizeLogin(login)
  const cached = viewerCountCache.get(normalized)
  if (!cached) return null
  if (Date.now() - cached.ts > CACHE_TTL_MS) {
    viewerCountCache.delete(normalized)
    persistViewerCountCache()
    return null
  }
  return cached.value
}

function setCachedViewerCount(login: string, value: number) {
  viewerCountCache.set(normalizeLogin(login), {
    ts: Date.now(),
    value: Number.isFinite(value) ? value : 0,
  })
}

function buildViewerCountQuery(logins: string[]) {
  const fields = logins
    .map(
      (login, index) =>
        `u${index}: user(login: ${JSON.stringify(login)}) { stream { viewersCount } }`
    )
    .join("\n")
  return `query HolodexTwitchLiveViewerCounts {\n${fields}\n}`
}

async function requestViewerCounts(logins: string[]) {
  const body = JSON.stringify({ query: buildViewerCountQuery(logins) })
  let lastError: unknown = null

  for (const endpoint of TWITCH_GQL_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "client-id": TWITCH_WEB_CLIENT_ID,
          "content-type": "application/json",
        },
        body,
      })
      if (!response.ok) {
        lastError = new Error(`Twitch GQL request failed: ${response.status}`)
        continue
      }
      const payload = await response.json()
      const data = Array.isArray(payload) ? payload[0]?.data : payload?.data
      return logins.reduce(
        (acc, login, index) => {
          const value = Number(data?.[`u${index}`]?.stream?.viewersCount ?? 0)
          acc[login] = Number.isFinite(value) ? value : 0
          return acc
        },
        {} as Record<string, number>
      )
    } catch (error) {
      lastError = error
    }
  }

  throw lastError ?? new Error("Unable to resolve Twitch viewer counts")
}

export function readCachedTwitchViewerCounts(logins: string[]) {
  return [...new Set((logins || []).map((login) => normalizeLogin(login)))].reduce(
    (acc, login) => {
      const cached = getCachedViewerCount(login)
      if (cached !== null) acc[login] = cached
      return acc
    },
    {} as Record<string, number>
  )
}

export async function fetchTwitchViewerCounts(logins: string[]) {
  const normalized = [
    ...new Set(
      (logins || [])
        .filter((login): login is string => typeof login === "string" && !!login.trim())
        .map(normalizeLogin)
    ),
  ]
  if (!normalized.length) return {}

  const cachedCounts = readCachedTwitchViewerCounts(normalized)
  const missing = normalized.filter((login) => cachedCounts[login] === undefined)
  if (!missing.length) return cachedCounts

  const key = missing.join(",")
  let request = inflightRequests.get(key)
  if (!request) {
    request = requestViewerCounts(missing)
      .then((counts) => {
        Object.entries(counts).forEach(([login, value]) =>
          setCachedViewerCount(login, value)
        )
        persistViewerCountCache()
        return counts
      })
      .finally(() => inflightRequests.delete(key))
    inflightRequests.set(key, request)
  }

  try {
    return { ...cachedCounts, ...(await request) }
  } catch {
    return cachedCounts
  }
}

export function mergeTwitchViewerCountsIntoVideos(
  videos: HolodexVideo[],
  counts: Record<string, number>
) {
  return (videos || []).map((video) => {
    const twitchLogin = getTwitchLogin(video)
    if (!twitchLogin || counts[twitchLogin] === undefined) return video
    if (video.live_viewers === counts[twitchLogin]) return video
    return { ...video, live_viewers: counts[twitchLogin] }
  })
}

export async function enrichLiveVideosWithTwitchViewerCounts(
  videos: HolodexVideo[]
) {
  const logins = [
    ...new Set(
      (videos || [])
        .filter((video) => video?.status === "live")
        .map((video) => getTwitchLogin(video))
        .filter((login): login is string => !!login)
    ),
  ]
  if (!logins.length) return videos
  const counts = await fetchTwitchViewerCounts(logins)
  return mergeTwitchViewerCountsIntoVideos(videos, counts)
}
