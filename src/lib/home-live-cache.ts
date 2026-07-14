import type { HolodexVideo } from "@/lib/types"
import { readJsonStorage, writeJsonStorage } from "@/lib/storage"

const HOME_LIVE_STORAGE_KEY = "holodex-nano-home-live"
const HOME_LIVE_CACHE_TTL_MS = 10 * 60 * 1000

type StoredHomeLive = {
  updatedAt: number
  videos: HolodexVideo[]
}

function slimHomeLiveVideo(video: HolodexVideo): HolodexVideo {
  return {
    id: video.id,
    title: video.title,
    jp_name: video.jp_name,
    type: video.type,
    status: video.status,
    topic_id: video.topic_id,
    available_at: video.available_at,
    start_actual: video.start_actual,
    start_scheduled: video.start_scheduled,
    duration: video.duration,
    thumbnail: video.thumbnail,
    live_viewers: video.live_viewers,
    ccv: video.ccv,
    channel_id: video.channel_id,
    channel: video.channel
      ? {
          id: video.channel.id,
          name: video.channel.name,
          english_name: video.channel.english_name,
          org: video.channel.org,
          group: video.channel.group,
          suborg: video.channel.suborg,
          twitch: video.channel.twitch,
        }
      : undefined,
    link: video.link,
    placeholderType: video.placeholderType,
    certainty: video.certainty,
  }
}

export function readStoredHomeLive(cacheKey: string): StoredHomeLive | null {
  const parsed = readJsonStorage(HOME_LIVE_STORAGE_KEY) as {
    cacheKey?: string
    updatedAt?: number
    videos?: HolodexVideo[]
  } | null

  if (
    parsed?.cacheKey !== cacheKey ||
    !Array.isArray(parsed.videos) ||
    !Number.isFinite(parsed.updatedAt)
  ) {
    return null
  }

  const updatedAt = Number(parsed.updatedAt)
  if (Date.now() - updatedAt > HOME_LIVE_CACHE_TTL_MS) return null
  return { updatedAt, videos: parsed.videos }
}

export function writeStoredHomeLive(cacheKey: string, videos: HolodexVideo[]) {
  const updatedAt = Date.now()
  writeJsonStorage(HOME_LIVE_STORAGE_KEY, {
    cacheKey,
    updatedAt,
    videos: videos.map(slimHomeLiveVideo),
  })
  return updatedAt
}
