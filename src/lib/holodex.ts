import type { HolodexVideo, Org } from "@/lib/types"
import { normalizeOrgs } from "@/lib/orgs"
import { dedupeVideos, isLiveInsideScheduleWindow } from "@/lib/video-utils"

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

export async function fetchOrgs(): Promise<Org[]> {
  const response = await fetch("/statics/orgs.json", {
    headers: { accept: "application/json" },
  })
  return normalizeOrgs(await readJson<unknown>(response))
}

async function fetchLiveRaw(
  query: Record<string, unknown> = {}
): Promise<HolodexVideo[]> {
  const response = await fetch(`/api/v2/live?${qs(query)}`, {
    headers: { accept: "application/json" },
  })
  return readJson<HolodexVideo[]>(response)
}


async function fetchAllPages(
  query: Record<string, unknown>
): Promise<HolodexVideo[]> {
  const limit = Number(query.limit) || 100
  const all: HolodexVideo[] = []
  let offset = 0
  while (true) {
    const raw = await fetchLiveRaw({ ...query, offset })
    all.push(...raw.filter(isLiveInsideScheduleWindow))
    if (raw.length < limit) break
    offset += limit
  }
  return all
}

export async function fetchAllLive(
  orgs: string[] = [],
  query: Record<string, unknown> = {}
): Promise<HolodexVideo[]> {
  const targets = (orgs || []).filter(Boolean)
  if (targets.length === 0 || targets.includes("All Vtubers")) {
    return fetchAllPages({ ...query, org: "All Vtubers" })
  }

  const responses = await Promise.allSettled(
    targets.map((org) => fetchAllPages({ ...query, org }))
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

export async function fetchVideos(query: Record<string, unknown> = {}) {
  const response = await fetch(`/api/v2/videos?${qs(query)}`, {
    headers: { accept: "application/json" },
  })
  return readJson<unknown>(response)
}
