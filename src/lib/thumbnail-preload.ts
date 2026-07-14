import type { HolodexVideo } from "@/lib/types"
import { videoImage } from "@/lib/video-utils"

type PreloadEntry = {
  image: HTMLImageElement
  ready: Promise<void>
}

const preloadedSources = new Map<string, PreloadEntry>()

function preloadSource(source: string) {
  const existing = preloadedSources.get(source)
  if (existing) return existing.ready

  const image = new window.Image()
  image.decoding = "async"

  const ready = new Promise<void>((resolve) => {
    image.onload = () => {
      if (typeof image.decode === "function") {
        void image.decode().catch(() => {}).then(resolve)
      } else {
        resolve()
      }
    }
    image.onerror = () => {
      preloadedSources.delete(source)
      resolve()
    }
  })

  preloadedSources.set(source, { image, ready })
  image.src = source
  return ready
}

export function preloadVideoThumbnails(videos: HolodexVideo[]) {
  if (typeof window === "undefined") return Promise.resolve()

  const sources = [
    ...new Set(
      videos
        .map((video) => videoImage(video))
        .filter((source): source is string => Boolean(source))
    ),
  ]

  return Promise.all(sources.map(preloadSource)).then(() => undefined)
}
