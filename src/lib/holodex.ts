import type { HolodexVideo, Org } from "@/lib/types"
import { allVtubersOrg, normalizeOrgs } from "@/lib/orgs"
import { dedupeVideos, isLiveInsideScheduleWindow } from "@/lib/video-utils"

export const HOLODEX_PAGE_LIMIT = 100
export type FetchPriority = NonNullable<RequestInit["priority"]>

function qs(obj: Record<string, unknown> = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== "") {
      params.append(key, String(value))
    }
  }
  return params.toString()
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Holodex request failed: ${response.status}`)
  }
  return response.json() as Promise<T>
}

let activeFetches = 0
const activityListeners = new Set<() => void>()

function notifyActivityListeners() {
  for (const listener of activityListeners) listener()
}

function trackActivity<T>(promise: Promise<T>) {
  const settle = () => {
    activeFetches--
    notifyActivityListeners()
  }
  activeFetches++
  notifyActivityListeners()
  promise.then(settle, settle)
  return promise
}

export function subscribeFetchActivity(listener: () => void) {
  activityListeners.add(listener)
  return () => {
    activityListeners.delete(listener)
  }
}

export function isFetchActive() {
  return activeFetches > 0
}

function fetchApi<T>(
  path: string,
  query: Record<string, unknown> = {},
  silent = false,
  priority: FetchPriority = "auto"
): Promise<T> {
  const request = fetch(`/api/v2/${path}?${qs(query)}`, {
    headers: { accept: "application/json" },
    priority,
  }).then((response) => readJson<T>(response))
  return silent || priority === "low" ? request : trackActivity(request)
}

const PREFETCH_TTL_MS = 30_000
const prefetchCache = new Map<
  string,
  { promise: Promise<unknown>; at: number }
>()

function prefetchKey(path: string, query: Record<string, unknown>) {
  const params = new URLSearchParams(qs(query))
  params.sort()
  return `${path}?${params.toString()}`
}

export function prefetchApi(
  path: string,
  query: Record<string, unknown> = {},
  priority: FetchPriority = "auto"
) {
  const now = Date.now()
  for (const [key, entry] of prefetchCache) {
    if (now - entry.at >= PREFETCH_TTL_MS) prefetchCache.delete(key)
  }
  const key = prefetchKey(path, query)
  if (prefetchCache.has(key)) return
  const promise = fetchApi<unknown>(path, query, false, priority)
  promise.catch(() => prefetchCache.delete(key))
  prefetchCache.set(key, { promise, at: now })
}

function takePrefetched<T>(path: string, query: Record<string, unknown>) {
  const key = prefetchKey(path, query)
  const entry = prefetchCache.get(key)
  if (!entry) return null
  prefetchCache.delete(key)
  if (Date.now() - entry.at >= PREFETCH_TTL_MS) return null
  return entry.promise as Promise<T>
}

export function fetchOrgs(): Promise<Org[]> {
  return trackActivity(
    fetch("/statics/orgs.json", {
      headers: { accept: "application/json" },
    })
      .then((response) => readJson<unknown>(response))
      .then(normalizeOrgs)
  )
}

async function fetchAllPages(
  query: Record<string, unknown>,
  silent = false,
  priority: FetchPriority = "auto"
): Promise<HolodexVideo[]> {
  const limit = Number(query.limit) || HOLODEX_PAGE_LIMIT
  const all: HolodexVideo[] = []
  let offset = 0
  while (true) {
    const pageQuery = { ...query, offset }
    const raw = await (takePrefetched<HolodexVideo[]>("live", pageQuery) ??
      fetchApi<HolodexVideo[]>("live", pageQuery, silent, priority))
    all.push(...raw.filter(isLiveInsideScheduleWindow))
    if (raw.length < limit) break
    offset += limit
  }
  return all
}

export async function fetchAllLive(
  orgs: string[] = [],
  query: Record<string, unknown> = {},
  silent = false,
  priority: FetchPriority = "auto"
): Promise<HolodexVideo[]> {
  const targets = (orgs || []).filter(Boolean)
  if (targets.length === 0 || targets.includes(allVtubersOrg.name)) {
    return fetchAllPages({ ...query, org: allVtubersOrg.name }, silent, priority)
  }

  const responses = await Promise.allSettled(
    targets.map((org) => fetchAllPages({ ...query, org }, silent, priority))
  )

  const fulfilled = responses
    .filter((result): result is PromiseFulfilledResult<HolodexVideo[]> => {
      return result.status === "fulfilled"
    })
    .flatMap((result) => result.value)

  if (fulfilled.length > 0) {
    return dedupeVideos(fulfilled)
  }

  const firstError = responses.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  )?.reason
  throw firstError instanceof Error
    ? firstError
    : new Error("Holodex live load failed")
}

export function fetchVideos(
  query: Record<string, unknown> = {},
  silent = false,
  priority: FetchPriority = "auto"
) {
  return (
    takePrefetched<unknown>("videos", query) ??
    fetchApi<unknown>("videos", query, silent, priority)
  )
}
