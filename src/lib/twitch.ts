import type { HolodexVideo } from "@/lib/types"
import { readJsonStorage, writeJsonStorage } from "@/lib/storage"
import { getTwitchLogin } from "@/lib/video-utils"

export const TWITCH_GQL_URL = "https://gql.twitch.tv/gql"
export const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"

const TWITCH_GQL_ENDPOINTS = ["/twitch-gql", TWITCH_GQL_URL] as const
const CACHE_TTL_MS = 60_000
const STORAGE_KEY = "holodex-nano-twitch-viewer-counts"

export const TWITCH_OFFLINE = -1

const viewerCountCache = new Map<string, { ts: number; value: number }>()
const inflightRequests = new Map<string, Promise<Record<string, number>>>()
let cacheHydrated = false

function normalizeLogin(login: string) {
  return login.trim().toLowerCase()
}

function readPersistedCache() {
  if (typeof window === "undefined" || cacheHydrated) return
  cacheHydrated = true
  const parsed = readJsonStorage(STORAGE_KEY) as Record<
    string,
    { ts?: number; value?: number }
  > | null
  Object.entries(parsed || {}).forEach(([login, entry]) => {
    if (Number.isFinite(entry?.ts) && Number.isFinite(entry?.value)) {
      viewerCountCache.set(normalizeLogin(login), {
        ts: Number(entry.ts),
        value: Number(entry.value),
      })
    }
  })
}

function persistViewerCountCache() {
  const now = Date.now()
  const serializable = Object.fromEntries(
    Array.from(viewerCountCache.entries()).filter(
      ([, entry]) => now - entry.ts <= CACHE_TTL_MS
    )
  )
  writeJsonStorage(STORAGE_KEY, serializable)
}

function getCachedViewerCount(login: string) {
  readPersistedCache()
  const normalized = normalizeLogin(login)
  const cached = viewerCountCache.get(normalized)
  if (!cached) return null
  if (Date.now() - cached.ts > CACHE_TTL_MS) {
    viewerCountCache.delete(normalized)
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

async function requestViewerCounts(
  logins: string[],
  priority: NonNullable<RequestInit["priority"]>
) {
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
        priority,
      })
      if (!response.ok) {
        lastError = new Error(`Twitch GQL request failed: ${response.status}`)
        continue
      }
      const payload = await response.json()
      const data = Array.isArray(payload) ? payload[0]?.data : payload?.data
      if (!data || typeof data !== "object") {
        lastError = new Error("Twitch GQL response did not include data")
        continue
      }
      return logins.reduce(
        (acc, login, index) => {
          const stream = data?.[`u${index}`]?.stream
          if (!stream) {
            acc[login] = TWITCH_OFFLINE
            return acc
          }
          const value = Number(stream.viewersCount ?? 0)
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

function liveTwitchLogins(videos: HolodexVideo[]) {
  return [
    ...new Set(
      (videos || [])
        .filter((video) => video?.status === "live")
        .map((video) => getTwitchLogin(video))
        .filter((login): login is string => !!login)
    ),
  ]
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

export async function fetchTwitchViewerCounts(
  logins: string[],
  opts: {
    force?: boolean
    priority?: NonNullable<RequestInit["priority"]>
  } = {}
) {
  const normalized = [
    ...new Set(
      (logins || [])
        .filter((login): login is string => typeof login === "string" && !!login.trim())
        .map(normalizeLogin)
    ),
  ]
  if (!normalized.length) return {}

  const cachedCounts = opts.force ? {} : readCachedTwitchViewerCounts(normalized)
  const missing = normalized.filter((login) => cachedCounts[login] === undefined)
  if (!missing.length) return cachedCounts

  const key = missing.join(",")
  let request = inflightRequests.get(key)
  if (!request) {
    request = requestViewerCounts(missing, opts.priority || "auto")
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
  return (videos || []).flatMap((video) => {
    const twitchLogin = getTwitchLogin(video)
    if (!twitchLogin) return [video]
    const count = counts[twitchLogin]
    if (count === TWITCH_OFFLINE) return video.status === "live" ? [] : [video]
    if (count === undefined || video.live_viewers === count) return [video]
    return [{ ...video, live_viewers: count }]
  })
}

export function applyCachedTwitchViewerCounts(videos: HolodexVideo[]) {
  const counts = readCachedTwitchViewerCounts(liveTwitchLogins(videos))
  return mergeTwitchViewerCountsIntoVideos(videos, counts)
}

export async function enrichLiveVideosWithTwitchViewerCounts(
  videos: HolodexVideo[],
  opts: {
    force?: boolean
    priority?: NonNullable<RequestInit["priority"]>
  } = {}
) {
  const logins = liveTwitchLogins(videos)
  if (!logins.length) return videos
  const counts = await fetchTwitchViewerCounts(logins, opts)
  return mergeTwitchViewerCountsIntoVideos(videos, counts)
}
