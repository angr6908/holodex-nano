"use client"

import { memo, useEffect, useState, useSyncExternalStore } from "react"
import type { MouseEvent } from "react"
import { Clock, Radio } from "lucide-react"

import {
  getClickedVideoIds,
  getServerClickedVideoIds,
  markVideoClicked,
  subscribeClickedVideos,
} from "@/lib/clicked-videos"
import type { HolodexVideo } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  channelDisplayName,
  externalVideoUrl,
  formatCount,
  formatDuration,
  formatUpcomingTime,
  formatVideoEndTime,
  getLiveViewerCount,
  videoImage,
  videoTitle,
} from "@/lib/video-utils"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

const UPCOMING_TICK_MS = 30_000

type VideoCardProps = {
  video: HolodexVideo
  eagerThumbnail?: boolean
  priorityThumbnail?: boolean
}

const tickListeners = new Set<() => void>()
let tickInterval: number | null = null

function subscribeUpcomingTick(listener: () => void) {
  tickListeners.add(listener)
  if (tickInterval === null) {
    tickInterval = window.setInterval(() => {
      tickListeners.forEach((notify) => notify())
    }, UPCOMING_TICK_MS)
  }
  return () => {
    tickListeners.delete(listener)
    if (!tickListeners.size && tickInterval !== null) {
      window.clearInterval(tickInterval)
      tickInterval = null
    }
  }
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

function VideoCardComponent({
  video,
  eagerThumbnail = false,
  priorityThumbnail = false,
}: VideoCardProps) {
  const [now, setNow] = useState(0)
  const clickedVideoIds = useSyncExternalStore(
    subscribeClickedVideos,
    getClickedVideoIds,
    getServerClickedVideoIds
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
    update()
    return subscribeUpcomingTick(update)
  }, [isUpcoming])

  const anchorHandlers = {
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      event.stopPropagation()
      if (hasTextSelection()) {
        event.preventDefault()
        return
      }
      markVideoClicked(video.id)
    },
    onAuxClick: (event: MouseEvent<HTMLAnchorElement>) => {
      event.stopPropagation()
      if (event.button === 1) markVideoClicked(video.id)
    },
  }

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
      className="video-card h-full cursor-pointer p-0 data-[size=sm]:py-0"
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
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        tabIndex={-1}
        aria-hidden="true"
        className="isolate relative block aspect-video w-full overflow-hidden rounded-t-xl bg-muted"
        {...anchorHandlers}
      >
        {image ? (
          // biome-ignore lint/performance/noImgElement: thumbnails are remote and sized by CSS; next/image adds no value here
          <img
            src={image}
            width={640}
            height={360}
            alt=""
            decoding={priorityThumbnail ? "sync" : "async"}
            draggable={false}
            fetchPriority={priorityThumbnail ? "high" : "auto"}
            loading={eagerThumbnail ? "eager" : "lazy"}
            className="video-card-thumbnail"
          />
        ) : null}
        {durationText ? (
          <Badge
            variant="secondary"
            className="pointer-events-none absolute right-2 bottom-2 z-[1] h-6 rounded-md border-0 bg-black/75 px-2 text-xs font-medium text-white shadow-sm transition-none hover:bg-black/75"
          >
            {durationText}
          </Badge>
        ) : null}
      </a>
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
            {...anchorHandlers}
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

export function videoRenderEqual(a: HolodexVideo, b: HolodexVideo) {
  if (a === b) return true

  return (
    a.id === b.id &&
    a.title === b.title &&
    a.jp_name === b.jp_name &&
    a.type === b.type &&
    a.status === b.status &&
    a.thumbnail === b.thumbnail &&
    a.link === b.link &&
    a.duration === b.duration &&
    a.available_at === b.available_at &&
    a.start_actual === b.start_actual &&
    a.start_scheduled === b.start_scheduled &&
    getLiveViewerCount(a) === getLiveViewerCount(b) &&
    a.channel?.name === b.channel?.name &&
    a.channel?.english_name === b.channel?.english_name &&
    a.channel?.twitch === b.channel?.twitch
  )
}

function videoCardPropsEqual(previous: VideoCardProps, next: VideoCardProps) {
  return (
    (previous.eagerThumbnail || false) === (next.eagerThumbnail || false) &&
    (previous.priorityThumbnail || false) ===
      (next.priorityThumbnail || false) &&
    videoRenderEqual(previous.video, next.video)
  )
}

export const VideoCard = memo(VideoCardComponent, videoCardPropsEqual)
