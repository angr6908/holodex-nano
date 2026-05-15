"use client"

import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { Clock, Radio } from "lucide-react"

import type { HolodexVideo } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  channelDisplayName,
  externalVideoUrl,
  formatCount,
  formatDuration,
  formatVideoEndTime,
  getLiveViewerCount,
  videoImage,
  videoTitle,
} from "@/lib/video-utils"
import { AspectRatio } from "@/components/ui/aspect-ratio"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const CLICKED_VIDEO_STORAGE_KEY = "holodex-nano-clicked-videos"
const CLICKED_VIDEO_EVENT = "holodex-nano-clicked-video"

function readClickedVideoSnapshot() {
  if (typeof window === "undefined") return "[]"
  return window.localStorage.getItem(CLICKED_VIDEO_STORAGE_KEY) || "[]"
}

function parseClickedVideoIds(snapshot: string) {
  try {
    const parsed = JSON.parse(snapshot)
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set<string>()
  } catch {
    return new Set<string>()
  }
}

function subscribeClickedVideos(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange)
  window.addEventListener(CLICKED_VIDEO_EVENT, onStoreChange)
  return () => {
    window.removeEventListener("storage", onStoreChange)
    window.removeEventListener(CLICKED_VIDEO_EVENT, onStoreChange)
  }
}

function markVideoClicked(videoId: string) {
  const clickedIds = parseClickedVideoIds(readClickedVideoSnapshot())
  clickedIds.add(videoId)
  window.localStorage.setItem(
    CLICKED_VIDEO_STORAGE_KEY,
    JSON.stringify([...clickedIds])
  )
  window.dispatchEvent(new Event(CLICKED_VIDEO_EVENT))
}

function hasTextSelection() {
  const selection = window.getSelection?.()
  return Boolean(
    selection && !selection.isCollapsed && selection.toString().trim()
  )
}

function selectElementText(element: HTMLElement) {
  const selection = window.getSelection?.()
  if (!selection) return

  const range = document.createRange()
  range.selectNodeContents(element)
  selection.removeAllRanges()
  selection.addRange(range)
}

function upcomingTimestamp(video: HolodexVideo) {
  return video.start_scheduled || video.available_at || video.start_actual || ""
}

function formatCountdown(ms: number) {
  if (ms <= 0) return "soon"
  const totalMinutes = Math.ceil(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (!hours) return `${totalMinutes}m`
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

function formatUpcomingTime(video: HolodexVideo, now: number) {
  const value = upcomingTimestamp(video)
  if (!value) return ""

  const time = new Date(value)
  if (!Number.isFinite(time.getTime())) return ""

  const diff = time.getTime() - now
  if (diff > 0 && diff < TWO_HOURS_MS) return formatCountdown(diff)

  const today = new Date(now)
  const isToday = time.toDateString() === today.toDateString()

  return new Intl.DateTimeFormat("en", {
    month: isToday ? undefined : "short",
    day: isToday ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(time)
}

export function VideoCard({ video }: { video: HolodexVideo }) {
  const [now, setNow] = useState(0)
  const clickedVideoSnapshot = useSyncExternalStore(
    subscribeClickedVideos,
    readClickedVideoSnapshot,
    () => "[]"
  )
  const clickedVideoIds = useMemo(
    () => parseClickedVideoIds(clickedVideoSnapshot),
    [clickedVideoSnapshot]
  )
  const title = videoTitle(video)
  const titleClicked = clickedVideoIds.has(video.id)
  const channelName = channelDisplayName(video)
  const image = videoImage(video)
  const viewers = getLiveViewerCount(video)
  const viewerText = formatCount(viewers)
  const href = externalVideoUrl(video)
  const isLive = video.status === "live"
  const isUpcoming = video.status === "upcoming"
  const isPast = !isLive && !isUpcoming
  const showLiveViewers = isLive && viewers > 0
  const upcomingTime = isUpcoming && now ? formatUpcomingTime(video, now) : ""
  const durationText = isPast ? formatDuration(video.duration) : ""
  const endTimeText = isPast ? formatVideoEndTime(video) : ""

  useEffect(() => {
    if (!isUpcoming) return
    const update = () => setNow(Date.now())
    const timeout = window.setTimeout(update, 0)
    const interval = window.setInterval(update, 30_000)
    return () => {
      window.clearTimeout(timeout)
      window.clearInterval(interval)
    }
  }, [isUpcoming])

  function openVideo() {
    markVideoClicked(video.id)
    window.open(href, "_blank", "noopener,noreferrer")
  }

  function handleOpen() {
    if (hasTextSelection()) return
    openVideo()
  }

  return (
    <Card
      size="sm"
      role="link"
      tabIndex={0}
      className="h-full cursor-pointer p-0 data-[size=sm]:py-0"
      onClick={handleOpen}
      onAuxClick={(event) => {
        if (event.button === 1) openVideo()
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        handleOpen()
      }}
      onDragStart={(event) => event.preventDefault()}
    >
      <AspectRatio
        ratio={16 / 9}
        className="relative overflow-hidden rounded-t-xl"
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt=""
            draggable={false}
            loading="lazy"
            className="h-full w-full select-none object-cover"
          />
        ) : null}
        {durationText ? (
          <Badge
            variant="secondary"
            className="pointer-events-none absolute right-2 bottom-2 h-6 rounded-md border-0 bg-black/75 px-2 text-xs font-medium text-white shadow-sm hover:bg-black/75"
          >
            {durationText}
          </Badge>
        ) : null}
      </AspectRatio>
      <CardHeader className="pb-2.5">
        <CardTitle className="line-clamp-2 min-h-[2lh]">
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "select-text no-underline",
              titleClicked
                ? "text-muted-foreground"
                : "text-foreground"
            )}
            onClick={(event) => {
              event.stopPropagation()
              if (hasTextSelection()) {
                event.preventDefault()
                return
              }
              markVideoClicked(video.id)
            }}
            onAuxClick={(event) => {
              event.stopPropagation()
              if (event.button === 1) markVideoClicked(video.id)
            }}
            onMouseDown={(event) => {
              if (event.button === 2) selectElementText(event.currentTarget)
            }}
            onContextMenu={(event) => selectElementText(event.currentTarget)}
          >
            {title || video.id}
          </a>
        </CardTitle>
        <CardDescription className="flex select-none items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{channelName}</span>
          {showLiveViewers ? (
            <span
              className="inline-flex shrink-0 items-center gap-1"
              aria-label={`${viewerText} watching`}
              title={`${viewerText} watching`}
            >
              <Radio className="size-3.5" aria-hidden="true" />
              {viewerText}
            </span>
          ) : null}
          {upcomingTime ? (
            <span
              className="inline-flex shrink-0 items-center gap-1"
              aria-label={`Starts ${upcomingTime}`}
              title={`Starts ${upcomingTime}`}
            >
              <Clock className="size-3.5" aria-hidden="true" />
              {upcomingTime}
            </span>
          ) : null}
          {endTimeText ? (
            <span
              className="shrink-0 text-muted-foreground"
              aria-label={`Ended ${endTimeText}`}
              title={`Ended ${endTimeText}`}
            >
              {endTimeText}
            </span>
          ) : null}
        </CardDescription>
      </CardHeader>
    </Card>
  )
}
