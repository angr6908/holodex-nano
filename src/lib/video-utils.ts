import type { HolodexVideo } from "@/lib/types"

export const TWITCH_VIDEO_URL_REGEX =
  /(?:(?:https?:|)\/\/|)(?:www\.)?twitch\.tv\/([\w-]+)/i

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
  return (
    new Date(a.available_at || "").getTime() -
    new Date(b.available_at || "").getTime()
  )
}

export function videoEndTimestamp(video: HolodexVideo) {
  if (!video) return 0
  const start = video.start_actual || video.available_at || video.start_scheduled
  const startTime = new Date(start || "").getTime()
  if (!Number.isFinite(startTime)) return 0
  if (
    video.status === "past" &&
    video.type === "stream" &&
    Number(video.duration) > 0
  ) {
    return startTime + Number(video.duration) * 1000
  }
  return startTime
}

function formatRelativeOrDateTime(timestamp: number) {
  if (!timestamp || !Number.isFinite(timestamp)) return ""

  const diff = timestamp - Date.now()
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
  if (abs < 60_000) return diff > 0 ? "soon" : "just now"
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute")
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour")
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp)
}

export function sortVideosForTab(items: HolodexVideo[], isArchive: boolean) {
  if (!isArchive) {
    return [...(items || [])].sort((a, b) => videoTemporalComparator(b, a))
  }

  return (items || [])
    .map((item, index) => ({
      item,
      index,
      endTime: videoEndTimestamp(item),
      id: String(item?.id || ""),
    }))
    .sort(
      (a, b) =>
        b.endTime - a.endTime || b.id.localeCompare(a.id) || a.index - b.index
    )
    .map(({ item }) => item)
}

export function getLiveViewerCount(video?: HolodexVideo | null) {
  const value = Number(video?.live_viewers ?? video?.ccv ?? 0)
  return Number.isFinite(value) ? value : 0
}

export function formatCount(n: unknown) {
  const value = typeof n === "string" ? Number(n) : Number(n || 0)
  return new Intl.NumberFormat("en", {
    compactDisplay: "short",
    notation: "compact",
    maximumSignificantDigits: 3,
  }).format(Number.isFinite(value) ? value : 0)
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

export function getVideoThumbnails(ytVideoKey: string, useWebP = false) {
  const base = `https://i.ytimg.com/vi${useWebP ? "_webp" : ""}/${ytVideoKey}`
  const ext = useWebP ? "webp" : "jpg"
  const src = (q: string) => `${base}/${q}.${ext}`
  return {
    default: src("default"),
    medium: src("mqdefault"),
    standard: src("sddefault"),
    maxres: src("maxresdefault"),
  }
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

export function channelPhoto(channelId?: string, size = 150) {
  return channelId ? `/statics/channelImg/${channelId}/${size}.png` : ""
}

export function videoImage(video: HolodexVideo) {
  if (!video) return ""
  if (video.thumbnail) return staticThumbnailPath(video.thumbnail)
  const twitchLogin = getTwitchLogin(video)
  if (twitchLogin) {
    return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${encodeURIComponent(
      twitchLogin
    )}-640x360.jpg`
  }
  if (video.type === "placeholder") {
    return channelPhoto(video.channel_id || video.channel?.id)
  }
  return getVideoThumbnails(video.id).standard
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
  const uploadTime = new Date(video.available_at || "").getTime()
  const computedEndTime = videoEndTimestamp(video)
  const endTime =
    computedEndTime > Date.now() && Number.isFinite(uploadTime)
      ? uploadTime
      : computedEndTime
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
  const start = new Date(video.start_scheduled || "").getTime()
  if (!Number.isFinite(start)) return true
  return Date.now() <= start + 2 * 60 * 60 * 1000
}
