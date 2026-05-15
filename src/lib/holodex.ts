import type { HolodexVideo, Org } from "@/lib/types"
import { normalizeOrgs } from "@/lib/orgs"
import { dedupeVideos, isLiveInsideScheduleWindow } from "@/lib/video-utils"

type FetchAllLiveOptions = {
  onPartial?: (videos: HolodexVideo[]) => void
}

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

export async function fetchLive(
  query: Record<string, unknown> = {}
): Promise<HolodexVideo[]> {
  const response = await fetch(`/api/v2/live?${qs(query)}`, {
    headers: { accept: "application/json" },
  })
  const data = await readJson<HolodexVideo[]>(response)
  return data.filter(isLiveInsideScheduleWindow)
}

export async function fetchAllLive(
  orgs: string[] = [],
  query: Record<string, unknown> = {},
  options: FetchAllLiveOptions = {}
): Promise<HolodexVideo[]> {
  const targets = (orgs || []).filter(Boolean)
  if (targets.length === 0 || targets.includes("All Vtubers")) {
    const videos = await fetchLive({ ...query, org: "All Vtubers" })
    options.onPartial?.(videos)
    return videos
  }

  const partial: HolodexVideo[] = []
  const responses = await Promise.allSettled(
    targets.map(async (org) => {
      const videos = await fetchLive({ ...query, org })
      partial.push(...videos)
      options.onPartial?.(dedupeVideos(partial))
      return videos
    })
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
