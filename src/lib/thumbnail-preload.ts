import type { HolodexVideo } from "@/lib/types"
import { videoImage } from "@/lib/video-utils"

const preloadedSources = new Map<string, HTMLImageElement | true>()

export function preloadVideoThumbnails(videos: HolodexVideo[], limit: number) {
  if (typeof window === "undefined" || limit <= 0) return

  const sources = [
    ...new Set(
      videos
        .map((video) => videoImage(video))
        .filter((source): source is string => Boolean(source))
    ),
  ].slice(0, limit)

  for (const source of sources) {
    if (preloadedSources.has(source)) continue

    const image = new window.Image()
    image.decoding = "async"
    image.onload = () => preloadedSources.set(source, true)
    image.onerror = () => preloadedSources.delete(source)
    preloadedSources.set(source, image)
    image.src = source
  }
}
