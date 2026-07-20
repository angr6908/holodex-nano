"use client"

import Link from "next/link"
import { LoaderCircle } from "lucide-react"
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import {
  HOLODEX_PAGE_LIMIT,
  fetchAllLive,
  fetchOrgs,
  fetchVideos,
  isFetchActive,
  prefetchApi,
  subscribeFetchActivity,
} from "@/lib/holodex"
import type { FetchPriority } from "@/lib/holodex"
import {
  readStoredHomeLive,
  writeStoredHomeLive,
} from "@/lib/home-live-cache"
import {
  allVtubersOrg,
  makeLiveCacheKey,
  normalizeSelectedHomeOrgs,
  resolveOrgTargets,
} from "@/lib/orgs"
import { readJsonStorage, writeJsonStorage } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { preloadVideoThumbnails } from "@/lib/thumbnail-preload"
import type { HolodexVideo, Org } from "@/lib/types"
import {
  dedupeVideos,
  extractItems,
  getLiveViewerCount,
  parseTimeMs,
  upcomingStartTimestamp,
  videoEndTimestamp,
  videoTemporalComparator,
} from "@/lib/video-utils"
import {
  applyCachedTwitchViewerCounts,
  enrichLiveVideosWithTwitchViewerCounts,
} from "@/lib/twitch"
import { HolodexLogo } from "@/components/holodex-logo"
import { HomeOrgMultiSelect } from "@/components/home-org-multi-select"
import { VideoCard, videoRenderEqual } from "@/components/video-card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"

const HOME_SELECTED_ORGS_KEY = "holodex-nano-selected-orgs"
const ORGS_STORAGE_KEY = "holodex-nano-orgs"
const TWITCH_ENRICH_TIMEOUT_MS = 2500
const AUTO_REFRESH_MS = 60_000
const PAGE_LENGTH = 25
const PREFETCH_PAGE_COUNT = 2
const EAGER_THUMBNAIL_COUNT = 10
// Upper bound on how long after its start an archived stream can end. The merge
// uses it to translate the API's available_at (start) pagination frontier into
// a safe end-time cutoff. Streams never run longer than 12h here, so this is an
// exact bound: the committed prefix is guaranteed stable.
const MAX_STREAM_DURATION_MS = 12 * 60 * 60 * 1000
// Safety valve so a pathologically dense selection can't fetch forever to fill
// one page; we show whatever is safely committed instead.
const MAX_FETCH_ROUNDS_PER_LOAD = 12
const DEFAULT_HOME_ORGS = ["VSpo", "Neo-Porte", "RK Music"]
const HOME_LIVE_QUERY = {
  type: "placeholder,stream",
  include: "mentions",
  limit: HOLODEX_PAGE_LIMIT,
}
const VIDEO_GRID_CLASS = "grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"

type TabValue = "live" | "archive" | "clips"
type PagedTabValue = Exclude<TabValue, "live">
type TabState = {
  currentPage: number
  pages: Map<number, HolodexVideo[]>
  knownPages: number
  canLoadMore: boolean
  loading: boolean
  error: string | null
}

type PagedSource = {
  ensure: (
    count: number,
    silent?: boolean,
    priority?: FetchPriority
  ) => Promise<void>
  slice: (offset: number, limit: number) => HolodexVideo[]
  committedCount: () => number
  isExhausted: () => boolean
  snapshot: () => Map<string, PagedOrgSnapshot>
}

type PagedOrgSnapshot = {
  items: HolodexVideo[]
  offset: number
  exhausted: boolean
  frontier: number
}

type HomeStateSnapshot = {
  homeLive: HolodexVideo[]
  homeError: string | null
  homeLastLiveUpdate: number
  homeLiveCacheKey: string
}

const pagedTabCopy: Record<
  PagedTabValue,
  {
    errorTitle: string
    emptyTitle: string
    emptyDescription: string
  }
> = {
  archive: {
    errorTitle: "Archive load failed",
    emptyTitle: "No archive videos",
    emptyDescription: "This organization selection has no archive results.",
  },
  clips: {
    errorTitle: "Clips load failed",
    emptyTitle: "No clips",
    emptyDescription: "This organization selection has no clip results.",
  },
}

function emptyTabState(): TabState {
  return {
    currentPage: 1,
    pages: new Map(),
    knownPages: 1,
    canLoadMore: false,
    loading: true,
    error: null,
  }
}

function initialTabStates() {
  return {
    archive: emptyTabState(),
    clips: emptyTabState(),
  }
}

function isDocumentHidden() {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error"
}

function readStoredSelectedOrgs() {
  const parsed = readJsonStorage(HOME_SELECTED_ORGS_KEY)
  return Array.isArray(parsed)
    ? normalizeSelectedHomeOrgs(parsed)
    : [...DEFAULT_HOME_ORGS]
}

function readStoredOrgs() {
  const parsed = readJsonStorage(ORGS_STORAGE_KEY) as { orgs?: unknown } | null
  return Array.isArray(parsed?.orgs) ? (parsed.orgs as Org[]) : []
}

function videoListRenderEqual(a: HolodexVideo[], b: HolodexVideo[]) {
  return (
    a.length === b.length &&
    a.every((video, index) => videoRenderEqual(video, b[index]))
  )
}

function tabPagesEqual(
  a: Map<number, HolodexVideo[]>,
  b: Map<number, HolodexVideo[]>
) {
  if (a.size !== b.size) return false
  for (const [page, items] of a) {
    if (b.get(page) !== items) return false
  }
  return true
}

function filterVideosByOrgs(videos: HolodexVideo[], orgTargets: string[]) {
  const targets = new Set(orgTargets)
  return videos.filter((video) => {
    if (video.channel?.org && targets.has(video.channel.org)) return true
    return (video.mentions || []).some(
      (mention) => mention.org && targets.has(mention.org)
    )
  })
}

function liveFingerprint(arr: HolodexVideo[]) {
  return (arr || [])
    .map(
      (video) =>
        `${video.id}:${video.status}:${video.available_at}:${video.start_scheduled}:${getLiveViewerCount(video)}`
    )
    .join(",")
}

function prepareHomeLiveVideos(videos: HolodexVideo[]) {
  const merged = applyCachedTwitchViewerCounts(dedupeVideos(videos || []))
  merged.sort(videoTemporalComparator)
  return merged
}

async function enrichLiveVideosBestEffort(
  videos: HolodexVideo[],
  force = false,
  priority: FetchPriority = "auto"
) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const request = enrichLiveVideosWithTwitchViewerCounts(videos, {
    force,
    priority,
  })
  try {
    return await Promise.race([
      request.then((enriched) => ({ videos: enriched, lateResult: null })),
      new Promise<{
        videos: HolodexVideo[]
        lateResult: Promise<HolodexVideo[]>
      }>((resolve) => {
        timeoutId = setTimeout(
          () => resolve({ videos, lateResult: request }),
          TWITCH_ENRICH_TIMEOUT_MS
        )
      }),
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

// Newest-ending first. Archived streams are ordered by when they ended
// (start + duration); clips have no duration so this is just their timestamp.
function pagedComparator(a: HolodexVideo, b: HolodexVideo) {
  const delta = videoEndTimestamp(b) - videoEndTimestamp(a)
  if (delta !== 0) return delta
  return String(b.id).localeCompare(String(a.id))
}

function upcomingStartMs(video: HolodexVideo) {
  return upcomingStartTimestamp(video) || Number.POSITIVE_INFINITY
}

function upcomingComparator(a: HolodexVideo, b: HolodexVideo) {
  const delta = upcomingStartMs(a) - upcomingStartMs(b)
  if (delta !== 0) return delta
  const aPlaceholder = a.type === "placeholder" ? 1 : 0
  const bPlaceholder = b.type === "placeholder" ? 1 : 0
  if (aPlaceholder !== bPlaceholder) return aPlaceholder - bPlaceholder
  return String(a.id).localeCompare(String(b.id))
}

function groupHomeVideos(videos: HolodexVideo[]) {
  return {
    liveStreams: videos
      .filter((video) => video.status === "live")
      .sort((a, b) => getLiveViewerCount(b) - getLiveViewerCount(a)),
    upcomingStreams: videos
      .filter((video) => video.status === "upcoming")
      .sort(upcomingComparator),
  }
}

function buildTabQuery(tabValue: PagedTabValue): Record<string, unknown> {
  const isArchive = tabValue === "archive"
  return {
    status: isArchive ? "past,missing" : "past",
    type: isArchive ? "stream" : "clip",
    lang: isArchive ? "en" : undefined,
    paginated: false,
    max_upcoming_hours: 1,
  }
}

// Merges several independently-paginated per-org feeds into one stable,
// newest-ending-first list. The API paginates by available_at (start time), so
// we track the frontier there but commit by end time: an item is only shown
// once nothing still unfetched could end after it. maxKeyAheadMs bounds how far
// an item's end time can run past its start, turning the (monotonic) available_at
// frontier into a safe end-time cutoff. That keeps already-shown pages from
// reordering as more data streams in, which is what made the old version buggy.
function createPagedSource(
  query: Record<string, unknown>,
  orgTargets: string[],
  maxKeyAheadMs: number,
  seed?: Map<string, PagedOrgSnapshot>
): PagedSource {
  const orgItems: HolodexVideo[][] = orgTargets.map(
    (org) => seed?.get(org)?.items.slice() || []
  )
  const orgOffset: number[] = orgTargets.map(
    (org) => seed?.get(org)?.offset || 0
  )
  const orgExhausted: boolean[] = orgTargets.map(
    (org) => seed?.get(org)?.exhausted || false
  )
  // available_at of the oldest item fetched so far per org. Orgs that have not
  // fetched yet hold +Infinity so the first round fetches all of them. This
  // decreases monotonically as we page, so the committed set only ever grows.
  const orgFrontier: number[] = orgTargets.map(
    (org) => seed?.get(org)?.frontier ?? Number.POSITIVE_INFINITY
  )

  let inflight: Promise<void> | null = null
  let version = 0
  let committedCache: HolodexVideo[] = []
  let committedVersion = -1

  const allExhausted = () => orgExhausted.every(Boolean)

  // The latest end time still reachable by an unfetched item: it must start at
  // or before some non-exhausted org's frontier and run at most maxKeyAheadMs.
  const endTimeCutoff = () => {
    let startCutoff = Number.NEGATIVE_INFINITY
    for (let i = 0; i < orgTargets.length; i++) {
      if (!orgExhausted[i]) startCutoff = Math.max(startCutoff, orgFrontier[i])
    }
    return startCutoff + maxKeyAheadMs
  }

  const committed = () => {
    if (committedVersion === version) return committedCache
    const merged = dedupeVideos(orgItems.flat()).sort(pagedComparator)
    if (allExhausted()) {
      committedCache = merged
    } else {
      const cutoff = endTimeCutoff()
      let count = 0
      while (count < merged.length && videoEndTimestamp(merged[count]) > cutoff) {
        count++
      }
      committedCache = merged.slice(0, count)
    }
    committedVersion = version
    return committedCache
  }

  const fetchOrg = async (
    index: number,
    silent: boolean,
    priority: FetchPriority
  ) => {
    try {
      const payload = await fetchVideos(
        {
          ...query,
          org: orgTargets[index],
          limit: HOLODEX_PAGE_LIMIT,
          offset: orgOffset[index],
        },
        silent,
        priority
      )
      const items = extractItems(payload)
      if (items.length > 0) {
        orgItems[index] = orgItems[index].concat(items)
        orgOffset[index] += items.length
        orgFrontier[index] = parseTimeMs(items[items.length - 1].available_at)
      }
      if (items.length < HOLODEX_PAGE_LIMIT) orgExhausted[index] = true
    } catch {
      orgExhausted[index] = true
    }
  }

  const fetchMoreOnce = (silent: boolean, priority: FetchPriority) => {
    if (inflight) return inflight
    if (allExhausted()) return Promise.resolve()

    // Push the frontier down by fetching from whichever non-exhausted org(s)
    // currently cap it. Advancing the laggard keeps every page boundary stable.
    const pending = orgTargets
      .map((_, index) => index)
      .filter((index) => !orgExhausted[index])
    const cutoff = Math.max(...pending.map((index) => orgFrontier[index]))
    const targets = pending.filter((index) => orgFrontier[index] === cutoff)

    inflight = Promise.all(
      targets.map((index) => fetchOrg(index, silent, priority))
    ).then(() => {
      version++
      inflight = null
    })
    return inflight
  }

  return {
    ensure: async (count, silent = false, priority = "auto") => {
      let rounds = 0
      while (
        committed().length < count &&
        !allExhausted() &&
        rounds < MAX_FETCH_ROUNDS_PER_LOAD
      ) {
        rounds++
        await fetchMoreOnce(silent, priority)
      }
    },
    slice: (offset, limit) => committed().slice(offset, offset + limit),
    committedCount: () => committed().length,
    isExhausted: allExhausted,
    snapshot: () =>
      new Map(
        orgTargets.map((org, index) => [
          org,
          {
            items: orgItems[index],
            offset: orgOffset[index],
            exhausted: orgExhausted[index],
            frontier: orgFrontier[index],
          },
        ])
      ),
  }
}

const pagedSources = new Map<string, PagedSource>()

function getPagedSource(
  tabValue: PagedTabValue,
  selectedHomeOrgs: string[],
  fresh: boolean,
  reusableSelection: string[] = []
) {
  const orgTargets = resolveOrgTargets(selectedHomeOrgs)
  const query = buildTabQuery(tabValue)
  const cacheKey = JSON.stringify([tabValue, orgTargets, query])
  if (fresh) pagedSources.delete(cacheKey)
  let source = pagedSources.get(cacheKey)
  if (!source) {
    const reusableTargets = resolveOrgTargets(reusableSelection)
    const reusableKey = JSON.stringify([tabValue, reusableTargets, query])
    const reusableSource =
      !orgTargets.includes(allVtubersOrg.name) &&
      !reusableTargets.includes(allVtubersOrg.name)
        ? pagedSources.get(reusableKey)
        : undefined
    // Only archived streams carry a duration that pushes end time past start;
    // clips end at their timestamp, so no look-ahead is needed for them.
    const maxKeyAheadMs = tabValue === "archive" ? MAX_STREAM_DURATION_MS : 0
    source = createPagedSource(
      query,
      orgTargets,
      maxKeyAheadMs,
      reusableSource?.snapshot()
    )
    pagedSources.set(cacheKey, source)
  }
  return source
}

const VideoGrid = memo(function VideoGrid({
  videos,
  eagerThumbnails = false,
}: {
  videos: HolodexVideo[]
  eagerThumbnails?: boolean
}) {
  return (
    <div className={VIDEO_GRID_CLASS}>
      {videos.map((video, index) => (
        <VideoCard
          key={video.id}
          video={video}
          eagerThumbnail={eagerThumbnails || index < EAGER_THUMBNAIL_COUNT}
          priorityThumbnail={index < EAGER_THUMBNAIL_COUNT}
        />
      ))}
    </div>
  )
})

const serverFetchActivity = () => false

function FetchActivityIndicator() {
  const active = useSyncExternalStore(
    subscribeFetchActivity,
    isFetchActive,
    serverFetchActivity
  )
  return (
    <LoaderCircle
      aria-hidden="true"
      className={cn(
        "size-4 animate-spin text-muted-foreground transition-opacity duration-300",
        active ? "opacity-100" : "opacity-0"
      )}
    />
  )
}

function GridSkeleton() {
  return (
    <div className={VIDEO_GRID_CLASS}>
      {Array.from({ length: PAGE_LENGTH }).map((_, index) => (
        <div key={index} className="space-y-3">
          <Skeleton className="aspect-video w-full" />
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ))}
    </div>
  )
}

function tabPaginationItems(currentPage: number, knownPages: number) {
  const pages = new Set<number>([1, knownPages, currentPage])
  if (currentPage > 1) pages.add(currentPage - 1)
  if (currentPage < knownPages) pages.add(currentPage + 1)

  const ordered = [...pages]
    .filter((page) => page >= 1 && page <= knownPages)
    .sort((a, b) => a - b)

  const items: Array<number | "ellipsis"> = []
  let previous = 0
  for (const page of ordered) {
    if (previous && page - previous > 1) items.push("ellipsis")
    items.push(page)
    previous = page
  }
  return items
}

function isPagedTabValue(value: TabValue): value is PagedTabValue {
  return value !== "live"
}

function scrollToTop() {
  window.scrollTo({ top: 0, left: 0, behavior: "auto" })
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" })
  })
}

function resetToTop() {
  const scrollingElement = document.scrollingElement
  if (scrollingElement) {
    scrollingElement.scrollTop = 0
    scrollingElement.scrollLeft = 0
    return
  }
  document.documentElement.scrollTop = 0
  document.body.scrollTop = 0
}

function PagedTabContent({
  tabValue,
  state,
  onPageChange,
}: {
  tabValue: PagedTabValue
  state: TabState
  onPageChange: (tabValue: PagedTabValue, page: number) => void
}) {
  const copy = pagedTabCopy[tabValue]
  const { currentPage, pages, knownPages, canLoadMore, loading, error } = state
  const items = pages.get(currentPage) || []

  const hasNextPage = canLoadMore || currentPage < knownPages
  const paginationItems = tabPaginationItems(currentPage, knownPages)
  const showPagination = items.length > 0 || currentPage > 1 || hasNextPage

  return (
    <div className="space-y-4">
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{copy.errorTitle}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {[...pages].map(([page, pageItems]) => (
        <div key={page} hidden={page !== currentPage}>
          <VideoGrid videos={pageItems} eagerThumbnails />
        </div>
      ))}

      {loading && !items.length ? <GridSkeleton /> : null}

      {!loading && !items.length && !error ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{copy.emptyTitle}</EmptyTitle>
            <EmptyDescription>{copy.emptyDescription}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {showPagination ? (
        <Pagination className="pt-2">
          <PaginationContent>
            {currentPage > 1 ? (
              <PaginationItem>
                <PaginationPrevious
                  href="#"
                  onClick={(event) => {
                    event.preventDefault()
                    onPageChange(tabValue, currentPage - 1)
                  }}
                />
              </PaginationItem>
            ) : null}
            {paginationItems.map((item, index) => (
              <PaginationItem key={`${item}-${index}`}>
                {item === "ellipsis" ? (
                  <PaginationEllipsis />
                ) : (
                  <PaginationLink
                    href="#"
                    isActive={item === currentPage}
                    onClick={(event) => {
                      event.preventDefault()
                      onPageChange(tabValue, item)
                    }}
                  >
                    {item}
                  </PaginationLink>
                )}
              </PaginationItem>
            ))}
            {canLoadMore ? (
              <PaginationItem>
                <PaginationEllipsis />
              </PaginationItem>
            ) : null}
            {hasNextPage ? (
              <PaginationItem>
                <PaginationNext
                  href="#"
                  onClick={(event) => {
                    event.preventDefault()
                    onPageChange(tabValue, currentPage + 1)
                  }}
                />
              </PaginationItem>
            ) : null}
          </PaginationContent>
        </Pagination>
      ) : null}
    </div>
  )
}

export function HomeClient() {
  const [orgs, setOrgsState] = useState<Org[]>([])
  const [orgsLoading, setOrgsLoading] = useState(false)
  const [orgsError, setOrgsError] = useState<string | null>(null)
  const [selectedHomeOrgs, setSelectedHomeOrgsState] =
    useState<string[]>(() => [...DEFAULT_HOME_ORGS])
  const [tab, setTab] = useState<TabValue>("live")
  const [homeLive, setHomeLive] = useState<HolodexVideo[]>([])
  const [homeLoading, setHomeLoading] = useState(true)
  const [homeError, setHomeError] = useState<string | null>(null)
  const [storageHydrated, setStorageHydrated] = useState(false)
  const [tabStates, setTabStates] = useState(initialTabStates)

  const orgsRef = useRef<Org[]>([])
  const orgsInflight = useRef<Promise<Org[]> | null>(null)
  const selectedHomeOrgsRef = useRef(selectedHomeOrgs)
  const tabRef = useRef<TabValue>(tab)
  const homeStateRef = useRef<HomeStateSnapshot>({
    homeLive: [],
    homeError: null,
    homeLastLiveUpdate: 0,
    homeLiveCacheKey: makeLiveCacheKey(DEFAULT_HOME_ORGS),
  })
  const homeInflight = useRef<Promise<void> | null>(null)
  const homeFetchSeq = useRef(0)
  const tabStatesRef = useRef(tabStates)
  const tabFetchSeq = useRef<Record<PagedTabValue, number>>({
    archive: 0,
    clips: 0,
  })

  const setOrgs = useCallback((next: Org[]) => {
    orgsRef.current = next
    setOrgsState(next)
  }, [])

  const syncHomeState = useCallback(
    (
      next: HomeStateSnapshot,
      opts: { loading?: boolean; preserveLiveIdentity?: boolean }
    ) => {
      setHomeLive((previous) =>
        opts.preserveLiveIdentity &&
        liveFingerprint(next.homeLive) === liveFingerprint(previous)
          ? previous
          : next.homeLive
      )
      setHomeError(next.homeError)
      if (opts.loading !== undefined) setHomeLoading(opts.loading)
      homeStateRef.current = next
    },
    []
  )

  useEffect(() => {
    const storedOrgs = readStoredOrgs()
    const storedSelected = readStoredSelectedOrgs()
    const liveCacheKey = makeLiveCacheKey(storedSelected)
    const cachedHomeLive = readStoredHomeLive(liveCacheKey)
    const cachedVideos = cachedHomeLive
      ? prepareHomeLiveVideos(cachedHomeLive.videos)
      : null

    setOrgs(storedOrgs)
    selectedHomeOrgsRef.current = storedSelected
    setSelectedHomeOrgsState(storedSelected)

    syncHomeState(
      {
        homeLive: cachedVideos || [],
        homeError: null,
        homeLastLiveUpdate: cachedHomeLive?.updatedAt || 0,
        homeLiveCacheKey: liveCacheKey,
      },
      { loading: !cachedVideos }
    )
    setStorageHydrated(true)
  }, [setOrgs, syncHomeState])

  useEffect(() => {
    tabStatesRef.current = tabStates
  }, [tabStates])

  const loadOrgs = useCallback(async () => {
    const current = orgsRef.current || []
    const loadFresh = () => {
      if (orgsInflight.current) return orgsInflight.current
      setOrgsLoading(true)
      setOrgsError(null)
      orgsInflight.current = fetchOrgs()
        .then((fresh) => {
          writeJsonStorage(ORGS_STORAGE_KEY, { orgs: fresh })
          return fresh
        })
        .finally(() => {
          orgsInflight.current = null
          setOrgsLoading(false)
        })
      return orgsInflight.current
    }
    const applyFresh = (fresh: Org[]) => {
      if (
        JSON.stringify(fresh.map((org) => org.name)) !==
        JSON.stringify((orgsRef.current || []).map((org) => org.name))
      ) {
        setOrgs(fresh)
      }
    }

    if (current.length > 0) {
      loadFresh()
        .then(applyFresh)
        .catch((error) => setOrgsError(errorMessage(error)))
      return current
    }

    try {
      const fresh = await loadFresh()
      applyFresh(fresh)
      return fresh
    } catch (error) {
      setOrgsError(errorMessage(error))
      return []
    }
  }, [setOrgs])

  const fetchHomeLive = useCallback(
    (
      opts: {
        force?: boolean
        minutes?: number
        background?: boolean
        silent?: boolean
        priority?: FetchPriority
      } = {}
    ) => {
      if (isDocumentHidden() && !opts.force) {
        return null
      }

      const {
        force = false,
        minutes = 5,
        background = false,
        silent = false,
        priority = "high",
      } = opts
      const orgTargets = resolveOrgTargets(selectedHomeOrgsRef.current)
      const nextCacheKey = makeLiveCacheKey(orgTargets)
      const current = homeStateRef.current
      const cacheChanged = current.homeLiveCacheKey !== nextCacheKey
      let previousTargets: string[] = []
      try {
        const parsed = JSON.parse(current.homeLiveCacheKey)
        if (Array.isArray(parsed)) previousTargets = parsed.map(String)
      } catch {}
      const additiveSelection =
        cacheChanged &&
        !homeInflight.current &&
        previousTargets.length > 0 &&
        !previousTargets.includes(allVtubersOrg.name) &&
        !orgTargets.includes(allVtubersOrg.name) &&
        previousTargets.every((org) => orgTargets.includes(org))
      const removalSelection =
        cacheChanged &&
        previousTargets.length > 0 &&
        !orgTargets.includes(allVtubersOrg.name) &&
        (previousTargets.includes(allVtubersOrg.name) ||
          orgTargets.every((org) => previousTargets.includes(org)))
      const requestTargets = additiveSelection
        ? orgTargets.filter((org) => !previousTargets.includes(org))
        : orgTargets
      if (homeInflight.current && !cacheChanged) return homeInflight.current

      const effectiveLastUpdate = cacheChanged ? 0 : current.homeLastLiveUpdate
      if (
        !force &&
        effectiveLastUpdate &&
        Date.now() - effectiveLastUpdate < minutes * 60_000 &&
        !current.homeError
      ) {
        return null
      }

      let visibleLive = current.homeLive
      let visibleLastUpdate = current.homeLastLiveUpdate
      if (removalSelection && visibleLive.length > 0) {
        visibleLive = filterVideosByOrgs(visibleLive, orgTargets)
      } else if (cacheChanged && visibleLive.length === 0) {
        const cachedHomeLive = readStoredHomeLive(nextCacheKey)
        if (cachedHomeLive) {
          visibleLive = prepareHomeLiveVideos(cachedHomeLive.videos)
          visibleLastUpdate = cachedHomeLive.updatedAt
        }
      }

      syncHomeState(
        {
          homeLive: visibleLive,
          homeError: background ? current.homeError : null,
          homeLastLiveUpdate: visibleLastUpdate,
          homeLiveCacheKey: nextCacheKey,
        },
        {
          loading: background ? undefined : visibleLive.length === 0,
          preserveLiveIdentity: true,
        }
      )

      const seq = ++homeFetchSeq.current
      const commitLive = async (videos: HolodexVideo[]) => {
        if (seq !== homeFetchSeq.current) return
        const merged = prepareHomeLiveVideos(videos)
        void preloadVideoThumbnails(merged)
        const updatedAt = writeStoredHomeLive(nextCacheKey, merged)
        syncHomeState(
          {
            homeLive: merged,
            homeError: null,
            homeLastLiveUpdate: updatedAt,
            homeLiveCacheKey: nextCacheKey,
          },
          { loading: false, preserveLiveIdentity: true }
        )
      }

      const request = fetchAllLive(
        requestTargets,
        HOME_LIVE_QUERY,
        silent,
        priority
      )
        .then(async (response) => {
          if (seq !== homeFetchSeq.current) return
          const baseVideos = additiveSelection
            ? dedupeVideos([...current.homeLive, ...response])
            : response
          if (!homeStateRef.current.homeLive.length) {
            await commitLive(baseVideos)
            if (seq !== homeFetchSeq.current) return
          }
          const enrichment = await enrichLiveVideosBestEffort(
            baseVideos,
            force,
            priority
          )
          if (seq !== homeFetchSeq.current) return
          await commitLive(enrichment.videos)
          if (enrichment.lateResult) {
            void enrichment.lateResult
              .then((lateVideos) => commitLive(lateVideos))
              .catch(() => {})
          }
        })
        .catch((error) => {
          if (seq !== homeFetchSeq.current) return
          if (background) return
          syncHomeState(
            {
              ...homeStateRef.current,
              homeError: errorMessage(error),
            },
            { loading: false, preserveLiveIdentity: true }
          )
        })
        .finally(() => {
          if (seq === homeFetchSeq.current) homeInflight.current = null
        })

      homeInflight.current = request
      return request
    },
    [syncHomeState]
  )

  // Single entry point for showing a paged-tab page. All navigation, initial
  // load, org changes and auto-refresh funnel through here so the rendered
  // page is always derived from one source of truth and never desyncs.
  const loadTabPage = useCallback(
    async (
      tabValue: PagedTabValue,
      page = 1,
      force = false,
      background = false,
      reusableSelection: string[] = [],
      silent = false,
      priority: FetchPriority = "high"
    ) => {
      const requestedPage = Math.max(1, page)
      const needed = requestedPage * PAGE_LENGTH
      const seq = ++tabFetchSeq.current[tabValue]
      const source = getPagedSource(
        tabValue,
        selectedHomeOrgsRef.current,
        force,
        reusableSelection
      )

      const buildPages = (
        previous: Map<number, HolodexVideo[]>,
        throughPage: number
      ) => {
        const maxPage = Math.ceil(source.committedCount() / PAGE_LENGTH)
        const target = Math.min(
          Math.max(throughPage + PREFETCH_PAGE_COUNT, ...previous.keys()),
          maxPage
        )
        const pages = new Map<number, HolodexVideo[]>()
        for (let pageNumber = 1; pageNumber <= target; pageNumber++) {
          const items = source.slice(
            (pageNumber - 1) * PAGE_LENGTH,
            PAGE_LENGTH
          )
          if (!items.length) break
          const prior = previous.get(pageNumber)
          pages.set(
            pageNumber,
            prior && videoListRenderEqual(prior, items) ? prior : items
          )
        }
        return pages
      }

      const commitPage = () => {
        const exhausted = source.isExhausted()
        const committedCount = source.committedCount()
        const maxPage = Math.max(1, Math.ceil(committedCount / PAGE_LENGTH))
        const finalPage = exhausted
          ? Math.min(requestedPage, maxPage)
          : requestedPage
        void preloadVideoThumbnails(
          source.slice((finalPage - 1) * PAGE_LENGTH, PAGE_LENGTH)
        )

        setTabStates((current) => {
          const tabState = current[tabValue]
          const built = buildPages(tabState.pages, finalPage)
          const samePages = tabPagesEqual(tabState.pages, built)
          const knownPages = Math.max(finalPage, maxPage)
          if (
            samePages &&
            tabState.currentPage === finalPage &&
            tabState.knownPages === knownPages &&
            tabState.canLoadMore === !exhausted &&
            !tabState.loading &&
            !tabState.error
          ) {
            return current
          }
          return {
            ...current,
            [tabValue]: {
              currentPage: finalPage,
              pages: samePages ? tabState.pages : built,
              knownPages,
              canLoadMore: !exhausted,
              loading: false,
              error: null,
            },
          }
        })

        // Warm the next pages so navigation is instant, and reveal any newly
        // known page numbers without disturbing the visible page.
        if (!exhausted) {
          void source
            .ensure(
              (finalPage + PREFETCH_PAGE_COUNT) * PAGE_LENGTH,
              silent,
              "low"
            )
            .then(() => {
              if (seq !== tabFetchSeq.current[tabValue]) return
              void preloadVideoThumbnails(
                source.slice(
                  finalPage * PAGE_LENGTH,
                  PREFETCH_PAGE_COUNT * PAGE_LENGTH
                )
              )
              setTabStates((current) => {
                const tabState = current[tabValue]
                const built = buildPages(tabState.pages, tabState.currentPage)
                const samePages = tabPagesEqual(tabState.pages, built)
                const nextKnown = Math.max(
                  tabState.currentPage,
                  Math.ceil(source.committedCount() / PAGE_LENGTH)
                )
                const nextCanLoadMore = !source.isExhausted()
                if (
                  samePages &&
                  nextKnown === tabState.knownPages &&
                  nextCanLoadMore === tabState.canLoadMore
                ) {
                  return current
                }
                return {
                  ...current,
                  [tabValue]: {
                    ...tabState,
                    pages: samePages ? tabState.pages : built,
                    knownPages: nextKnown,
                    canLoadMore: nextCanLoadMore,
                  },
                }
              })
            })
            .catch(() => {})
        }
      }

      if (source.committedCount() >= needed) {
        commitPage()
        return
      }

      if (!background) {
        setTabStates((current) => ({
          ...current,
          [tabValue]: { ...current[tabValue], loading: true, error: null },
        }))
      }

      try {
        await source.ensure(needed, silent, priority)
        if (seq !== tabFetchSeq.current[tabValue]) return
        commitPage()
      } catch (error) {
        if (seq !== tabFetchSeq.current[tabValue]) return
        if (background) return
        setTabStates((current) => ({
          ...current,
          [tabValue]: {
            ...current[tabValue],
            loading: false,
            error: errorMessage(error),
          },
        }))
      }
    },
    []
  )

  // Refresh the live feed and both paged tabs every tick, including tabs that
  // are currently hidden. Keep existing UI mounted while fresh data loads.
  const refreshAll = useCallback(() => {
    if (isDocumentHidden()) return
    const activeTab = tabRef.current
    if (activeTab === "live") {
      void fetchHomeLive({
        force: true,
        background: true,
        silent: true,
        priority: "high",
      })
    } else {
      void loadTabPage(
        activeTab,
        tabStatesRef.current[activeTab].currentPage,
        true,
        true,
        [],
        true,
        "high"
      )
    }

    if (activeTab !== "live") {
      void fetchHomeLive({
        force: true,
        background: true,
        silent: true,
        priority: "low",
      })
    }
    for (const tabValue of ["archive", "clips"] as PagedTabValue[]) {
      if (tabValue === activeTab) continue
      void loadTabPage(
        tabValue,
        tabStatesRef.current[tabValue].currentPage,
        true,
        true,
        [],
        true,
        "low"
      )
    }
  }, [fetchHomeLive, loadTabPage])

  const prefetchDraftOrgs = useCallback((draft: string[]) => {
    const current = new Set(resolveOrgTargets(selectedHomeOrgsRef.current))
    const activeTab = tabRef.current
    const prefetchPaged = (
      tabValue: PagedTabValue,
      org: string,
      priority: FetchPriority
    ) =>
      prefetchApi(
        "videos",
        {
          ...buildTabQuery(tabValue),
          org,
          limit: HOLODEX_PAGE_LIMIT,
          offset: 0,
        },
        priority
      )

    for (const org of resolveOrgTargets(normalizeSelectedHomeOrgs(draft))) {
      if (current.has(org)) continue
      if (isPagedTabValue(activeTab)) {
        prefetchPaged(activeTab, org, "high")
      } else {
        prefetchApi("live", { ...HOME_LIVE_QUERY, org, offset: 0 }, "high")
      }

      if (activeTab !== "live") {
        prefetchApi("live", { ...HOME_LIVE_QUERY, org, offset: 0 }, "low")
      }
      for (const tabValue of ["archive", "clips"] as PagedTabValue[]) {
        if (tabValue !== activeTab) prefetchPaged(tabValue, org, "low")
      }
    }
  }, [])

  function setSelectedHomeOrgs(nextRaw: string[]) {
    const next = normalizeSelectedHomeOrgs(nextRaw)
    const previousSelection = selectedHomeOrgsRef.current
    const selectionKey = JSON.stringify(next)
    if (selectionKey === JSON.stringify(previousSelection)) return
    resetToTop()
    selectedHomeOrgsRef.current = next
    setSelectedHomeOrgsState(next)
    writeJsonStorage(HOME_SELECTED_ORGS_KEY, next)

    const stale = () =>
      JSON.stringify(selectedHomeOrgsRef.current) !== selectionKey
    const refreshLive = () =>
      fetchHomeLive({ force: true, background: true, priority: "high" }) ??
      Promise.resolve()
    const refreshPaged = (
      tabValue: PagedTabValue,
      priority: FetchPriority
    ) => loadTabPage(tabValue, 1, true, true, previousSelection, false, priority)
    const activeTab = tabRef.current
    const primary =
      activeTab === "live" ? refreshLive() : refreshPaged(activeTab, "high")

    void Promise.resolve(primary).then(() => {
      if (stale()) return
      if (activeTab !== "live") {
        void fetchHomeLive({ force: true, background: true, priority: "low" })
      }
      for (const tabValue of ["archive", "clips"] as PagedTabValue[]) {
        if (tabValue !== activeTab) void refreshPaged(tabValue, "low")
      }
    })
  }

  useEffect(() => {
    if (!storageHydrated) return
    void loadOrgs()
    const activeTab = tabRef.current
    if (activeTab === "live") {
      void fetchHomeLive({ force: true, priority: "high" })
    } else {
      void loadTabPage(activeTab, 1, false, false, [], false, "high")
    }
    if (activeTab !== "live") {
      void fetchHomeLive({ force: true, priority: "low" })
    }
    for (const tabValue of ["archive", "clips"] as PagedTabValue[]) {
      if (tabValue !== activeTab) {
        void loadTabPage(tabValue, 1, false, false, [], false, "low")
      }
    }
  }, [fetchHomeLive, loadOrgs, loadTabPage, storageHydrated])

  useEffect(() => {
    if (!storageHydrated) return
    const interval = window.setInterval(refreshAll, AUTO_REFRESH_MS)
    return () => window.clearInterval(interval)
  }, [refreshAll, storageHydrated])

  const { liveStreams, upcomingStreams } = useMemo(
    () => groupHomeVideos(homeLive),
    [homeLive]
  )

  const archiveState = tabStates.archive
  const clipsState = tabStates.clips

  const changeTab = (value: string) => {
    const nextTab = value as TabValue
    tabRef.current = nextTab
    if (isPagedTabValue(nextTab)) {
      const tabState = tabStatesRef.current[nextTab]
      if (!tabState.pages.size && !tabState.loading && !tabState.error) {
        void loadTabPage(nextTab, tabState.currentPage)
      }
    }

    setTab(nextTab)
    scrollToTop()
  }
  const changePagedTabPage = (tabValue: PagedTabValue, page: number) => {
    void loadTabPage(tabValue, page)
    scrollToTop()
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 pb-4">
      <Tabs value={tab} onValueChange={changeTab}>
        <div className="sticky top-0 z-10 -mx-4 -mb-1 flex flex-col gap-4 bg-background px-4 pt-4 pb-3">
          <header className="flex items-center justify-between gap-2 min-w-0">
            <Link
              href="/"
              aria-label="Holodex Nano"
              className="flex min-w-0 shrink items-center gap-2.5 pr-2 text-left no-underline select-none min-[960px]:pr-4"
              onClick={(event) => {
                event.preventDefault()
                changeTab("live")
              }}
            >
              <HolodexLogo
                width={30}
                height={28}
                aria-hidden="true"
                className="block"
              />
              <div className="min-w-0 truncate text-[1.02rem] font-semibold tracking-[0.01em] text-foreground">
                Holodex Nano
              </div>
            </Link>
            <HomeOrgMultiSelect
              orgs={orgs}
              orgsLoading={orgsLoading}
              orgsError={orgsError}
              selectedNames={selectedHomeOrgs}
              fetchOrgs={loadOrgs}
              onDraftChange={prefetchDraftOrgs}
              onApply={setSelectedHomeOrgs}
            />
          </header>

          <div className="flex items-center justify-between gap-2">
            <TabsList variant="line">
              <TabsTrigger value="live">Live</TabsTrigger>
              <TabsTrigger value="archive">Archive</TabsTrigger>
              <TabsTrigger value="clips">Clips</TabsTrigger>
            </TabsList>
            <FetchActivityIndicator />
          </div>
        </div>

        <TabsContent value="live" keepMounted>
          {homeError ? (
            <Alert variant="destructive">
              <AlertTitle>Live load failed</AlertTitle>
              <AlertDescription>{homeError}</AlertDescription>
            </Alert>
          ) : null}

          {homeLoading ? <GridSkeleton /> : null}

          {!homeLoading && !homeError && !liveStreams.length && !upcomingStreams.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No streams</EmptyTitle>
                <EmptyDescription>
                  Change organizations or refresh the live feed.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {liveStreams.length ? <VideoGrid videos={liveStreams} /> : null}

          {liveStreams.length && upcomingStreams.length ? (
            <Separator className="my-4" />
          ) : null}

          {upcomingStreams.length ? <VideoGrid videos={upcomingStreams} /> : null}
        </TabsContent>

        <TabsContent value="archive" keepMounted>
          <PagedTabContent
            tabValue="archive"
            state={archiveState}
            onPageChange={changePagedTabPage}
          />
        </TabsContent>

        <TabsContent value="clips" keepMounted>
          <PagedTabContent
            tabValue="clips"
            state={clipsState}
            onPageChange={changePagedTabPage}
          />
        </TabsContent>
      </Tabs>
    </main>
  )
}
