import type { HolodexVideo } from "@/lib/types"

export const TWITCH_VIDEO_URL_REGEX =
  /(?:(?:https?:|)\/\/|)(?:www\.)?twitch\.tv\/([\w-]+)/i

export const YOUTUBE_THUMBNAIL_HOST = "https://i.ytimg.com"
export const TWITCH_THUMBNAIL_HOST = "https://static-cdn.jtvnw.net"

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

const relativeTimeFormat = new Intl.RelativeTimeFormat("en", {
  numeric: "auto",
})
const shortDateTimeFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})
const timeOnlyFormat = new Intl.DateTimeFormat("en", {
  hour: "numeric",
  minute: "2-digit",
})
const compactCountFormat = new Intl.NumberFormat("en", {
  compactDisplay: "short",
  notation: "compact",
  maximumSignificantDigits: 3,
})

export function parseTimeMs(value?: string | null) {
  const time = new Date(value || "").getTime()
  return Number.isFinite(time) ? time : 0
}

export function dedupeVideos(videos: HolodexVideo[]) {
  return Array.from(new Map((videos || []).map((video) => [video.id, video])).values())
}

export function extractItems(payload: unknown): HolodexVideo[] {
  if (Array.isArray(payload)) return payload as HolodexVideo[]
  if (!payload || typeof payload !== "object") return []
  return (
    (Object.values(payload).find((value) => Array.isArray(value)) as
      | HolodexVideo[]
      | undefined) || []
  )
}

export function videoTemporalComparator(a: HolodexVideo, b: HolodexVideo) {
  if (a.available_at === b.available_at) {
    return String(a.id).localeCompare(String(b.id))
  }
  return parseTimeMs(a.available_at) - parseTimeMs(b.available_at)
}

const endTimestampCache = new WeakMap<HolodexVideo, number>()

export function videoEndTimestamp(video: HolodexVideo) {
  if (!video) return 0
  const cached = endTimestampCache.get(video)
  if (cached !== undefined) return cached
  const startTime = parseTimeMs(
    video.start_actual || video.available_at || video.start_scheduled
  )
  const endTime =
    startTime &&
    video.status === "past" &&
    video.type === "stream" &&
    Number(video.duration) > 0
      ? startTime + Number(video.duration) * 1000
      : startTime
  endTimestampCache.set(video, endTime)
  return endTime
}

export function upcomingStartTimestamp(video: HolodexVideo) {
  return parseTimeMs(
    video.start_scheduled || video.available_at || video.start_actual
  )
}

function formatRelativeOrDateTime(timestamp: number) {
  if (!timestamp || !Number.isFinite(timestamp)) return ""

  const diff = timestamp - Date.now()
  const abs = Math.abs(diff)
  if (abs < 60_000) return diff > 0 ? "soon" : "just now"
  if (abs < 3_600_000) {
    return relativeTimeFormat.format(Math.round(diff / 60_000), "minute")
  }
  if (abs < 86_400_000) {
    return relativeTimeFormat.format(Math.round(diff / 3_600_000), "hour")
  }
  return shortDateTimeFormat.format(timestamp)
}

function formatCountdown(ms: number) {
  if (ms <= 0) return "soon"
  const totalMinutes = Math.ceil(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (!hours) return `${totalMinutes}m`
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

export function formatUpcomingTime(video: HolodexVideo, now: number) {
  const time = upcomingStartTimestamp(video)
  if (!time) return ""

  const diff = time - now
  if (diff > 0 && diff < TWO_HOURS_MS) return formatCountdown(diff)

  const isToday =
    new Date(time).toDateString() === new Date(now).toDateString()
  return (isToday ? timeOnlyFormat : shortDateTimeFormat).format(time)
}

export function getLiveViewerCount(video?: HolodexVideo | null) {
  const value = Number(video?.live_viewers ?? video?.ccv ?? 0)
  return Number.isFinite(value) ? value : 0
}

export function formatCount(n: unknown) {
  const value = typeof n === "string" ? Number(n) : Number(n || 0)
  return compactCountFormat.format(Number.isFinite(value) ? value : 0)
}

export function decodeHTMLEntities(str = "") {
  return str.replaceAll("&amp;", "&").replaceAll("&quot;", '"')
}

export function videoTitle(video: HolodexVideo) {
  if (!video) return ""
  if (video.type === "placeholder") {
    return decodeHTMLEntities(video.title || video.jp_name || "")
  }
  return decodeHTMLEntities(video.title || "")
}

function isYoutubeVideoId(value?: string) {
  return Boolean(value && /^[\w-]{11}$/.test(value))
}

function youtubeThumbnailUrl(videoId: string) {
  return `${YOUTUBE_THUMBNAIL_HOST}/vi/${encodeURIComponent(videoId)}/sddefault.jpg`
}

export function staticThumbnailPath(
  thumbnail: string,
  size: "default" | "maxres" = "default"
) {
  if (typeof btoa === "undefined") return thumbnail
  const encoded = btoa(thumbnail)
    .replace("+", "-")
    .replace("/", "_")
    .replace(/=+$/, "")
  return `/statics/thumbnail/${size}/${encoded}.jpg`
}

export function videoImage(video: HolodexVideo) {
  if (!video) return ""
  if (video.thumbnail && video.type === "placeholder") {
    return staticThumbnailPath(video.thumbnail)
  }

  const twitchLogin = getTwitchLogin(video)
  if (twitchLogin) {
    return `${TWITCH_THUMBNAIL_HOST}/previews-ttv/live_user_${encodeURIComponent(
      twitchLogin
    )}-640x360.jpg`
  }
  if (isYoutubeVideoId(video.id)) return youtubeThumbnailUrl(video.id)
  return video.thumbnail ? staticThumbnailPath(video.thumbnail) : ""
}

export function channelDisplayName(video: HolodexVideo) {
  return video.channel?.english_name || video.channel?.name || "Unknown channel"
}

export function getTwitchLogin(video?: HolodexVideo | null) {
  if (!video || typeof video !== "object") return null
  const loginFromLink = video.link?.match?.(TWITCH_VIDEO_URL_REGEX)?.[1]
  const login =
    loginFromLink ||
    video.channel?.twitch ||
    (video.type === "twitch" ? video.id : null)
  if (!login || typeof login !== "string") return null
  return login.trim().toLowerCase()
}

export function externalVideoUrl(video: HolodexVideo) {
  if (typeof video.link === "string" && /^https?:\/\//i.test(video.link)) {
    return video.link
  }
  const twitchLogin = getTwitchLogin(video)
  if (twitchLogin) return `https://www.twitch.tv/${twitchLogin}`
  return `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`
}

export function formatVideoEndTime(video: HolodexVideo) {
  const uploadTime = parseTimeMs(video.available_at)
  const computedEndTime = videoEndTimestamp(video)
  const endTime =
    computedEndTime > Date.now() && uploadTime ? uploadTime : computedEndTime
  return formatRelativeOrDateTime(endTime)
}

export function formatDuration(seconds?: number) {
  if (!seconds || !Number.isFinite(Number(seconds))) return ""
  const total = Number(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  return `${m}:${String(s).padStart(2, "0")}`
}

export function isLiveInsideScheduleWindow(video: HolodexVideo) {
  if (video.start_actual) return true
  const start = parseTimeMs(video.start_scheduled)
  if (!start) return true
  return Date.now() <= start + TWO_HOURS_MS
}
