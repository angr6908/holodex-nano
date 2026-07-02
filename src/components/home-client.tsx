"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { fetchAllLive, fetchOrgs, fetchVideos } from "@/lib/holodex"
import {
  readStoredHomeLive,
  writeStoredHomeLive,
} from "@/lib/home-live-cache"
import {
  makeLiveCacheKey,
  normalizeSelectedHomeOrgs,
} from "@/lib/orgs"
import { preloadVideoThumbnails } from "@/lib/thumbnail-preload"
import type { HolodexVideo, Org } from "@/lib/types"
import {
  dedupeVideos,
  extractItems,
  getTwitchLogin,
  getLiveViewerCount,
  videoEndTimestamp,
  videoTemporalComparator,
} from "@/lib/video-utils"
import {
  enrichLiveVideosWithTwitchViewerCounts,
  mergeTwitchViewerCountsIntoVideos,
  readCachedTwitchViewerCounts,
} from "@/lib/twitch"
import { HolodexLogo } from "@/components/holodex-logo"
import { HomeOrgMultiSelect } from "@/components/home-org-multi-select"
import { VideoCard } from "@/components/video-card"
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
const API_MAX_LIMIT = 100
const PAGE_LENGTH = 25
const PREFETCH_PAGE_COUNT = 2
const PAGE_THUMBNAIL_PRELOAD_LIMIT = PAGE_LENGTH
const EAGER_THUMBNAIL_COUNT = 10
// Upper bound on how long after its start an archived stream can end. The merge
// uses it to translate the API's available_at (start) pagination frontier into
// a safe end-time cutoff. Streams never run longer than 12h here, so this is an
// exact bound: the committed prefix is guaranteed stable.
const MAX_STREAM_DURATION_MS = 12 * 60 * 60 * 1000
// Safety valve so a pathologically dense selection can't fetch forever to fill
// one page; we show whatever is safely committed instead.
const MAX_FETCH_ROUNDS_PER_LOAD = 12
const DEFAULT_HOME_ORGS = ["VSpo", "Neo-Porte", "Riot Music", "RK Music", "REJECT"]
const INITIAL_LIVE_REFRESH = { force: true, minutes: 2 } as const
const HOME_LIVE_QUERY = {
  type: "placeholder,stream",
  include: "mentions",
  limit: API_MAX_LIMIT,
}

type TabValue = "live" | "archive" | "clips"
type PagedTabValue = Exclude<TabValue, "live">
type TabState = {
  currentPage: number
  items: HolodexVideo[]
  knownPages: number
  canLoadMore: boolean
  loading: boolean
  error: string | null
}

type PagedSource = {
  ensure: (count: number) => Promise<void>
  slice: (offset: number, limit: number) => HolodexVideo[]
  committedCount: () => number
  isExhausted: () => boolean
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
    items: [],
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
  if (typeof window === "undefined") return [...DEFAULT_HOME_ORGS]
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(HOME_SELECTED_ORGS_KEY) || "null"
    )
    return Array.isArray(parsed)
      ? normalizeSelectedHomeOrgs(parsed)
      : [...DEFAULT_HOME_ORGS]
  } catch {
    return [...DEFAULT_HOME_ORGS]
  }
}

function readStoredOrgs() {
  if (typeof window === "undefined") return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ORGS_STORAGE_KEY) || "{}")
    return Array.isArray(parsed.orgs) ? (parsed.orgs as Org[]) : []
  } catch {
    return []
  }
}

function liveFingerprint(arr: HolodexVideo[]) {
  return (arr || [])
    .map(
      (video) =>
        `${video.id}:${video.status}:${video.available_at}:${video.start_scheduled}:${getLiveViewerCount(video)}`
    )
    .join(",")
}

function sortHomeLiveVideos(videos: HolodexVideo[]) {
  const merged = dedupeVideos(videos || [])
  merged.sort(videoTemporalComparator)
  return merged
}

function applyCachedTwitchViewerCounts(videos: HolodexVideo[]) {
  const deduped = dedupeVideos(videos || [])
  const twitchLogins = [
    ...new Set(
      deduped
        .filter((video) => video.status === "live")
        .map((video) => getTwitchLogin(video))
        .filter((login): login is string => Boolean(login))
    ),
  ]
  const cachedCounts = readCachedTwitchViewerCounts(twitchLogins)
  return mergeTwitchViewerCountsIntoVideos(deduped, cachedCounts)
}

function prepareHomeLiveVideos(videos: HolodexVideo[]) {
  return sortHomeLiveVideos(applyCachedTwitchViewerCounts(videos))
}

async function enrichLiveVideosBestEffort(videos: HolodexVideo[]) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      enrichLiveVideosWithTwitchViewerCounts(videos),
      new Promise<HolodexVideo[]>((resolve) => {
        timeoutId = setTimeout(
          () => resolve(videos),
          TWITCH_ENRICH_TIMEOUT_MS
        )
      }),
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

function availableAtMs(video: HolodexVideo) {
  const time = new Date(video.available_at || "").getTime()
  return Number.isFinite(time) ? time : 0
}

// Newest-ending first. Archived streams are ordered by when they ended
// (start + duration); clips have no duration so this is just their timestamp.
function pagedComparator(a: HolodexVideo, b: HolodexVideo) {
  const delta = videoEndTimestamp(b) - videoEndTimestamp(a)
  if (delta !== 0) return delta
  return String(b.id).localeCompare(String(a.id))
}

function upcomingStartMs(video: HolodexVideo) {
  const time = new Date(video.start_scheduled || video.available_at || "").getTime()
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY
}

function upcomingComparator(a: HolodexVideo, b: HolodexVideo) {
  const delta = upcomingStartMs(a) - upcomingStartMs(b)
  if (delta !== 0) return delta
  const aPlaceholder = a.type === "placeholder" ? 1 : 0
  const bPlaceholder = b.type === "placeholder" ? 1 : 0
  if (aPlaceholder !== bPlaceholder) return aPlaceholder - bPlaceholder
  return String(a.id).localeCompare(String(b.id))
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

function cacheKeyForTab(tabValue: PagedTabValue, orgTargets: string[]) {
  return [
    "vlx",
    "home",
    tabValue,
    "pages",
    `limit-${API_MAX_LIMIT}`,
    JSON.stringify(orgTargets),
    tabValue === "archive" ? "lang-en" : "lang-all",
  ].join("-")
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
  maxKeyAheadMs: number
): PagedSource {
  const baseQuery = { ...query, paginated: false }
  const orgItems: HolodexVideo[][] = orgTargets.map(() => [])
  const orgOffset: number[] = orgTargets.map(() => 0)
  const orgExhausted: boolean[] = orgTargets.map(() => false)
  // available_at of the oldest item fetched so far per org. Orgs that have not
  // fetched yet hold +Infinity so the first round fetches all of them. This
  // decreases monotonically as we page, so the committed set only ever grows.
  const orgFrontier: number[] = orgTargets.map(() => Number.POSITIVE_INFINITY)

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

  const fetchOrg = async (index: number) => {
    try {
      const payload = await fetchVideos({
        ...baseQuery,
        org: orgTargets[index],
        limit: API_MAX_LIMIT,
        offset: orgOffset[index],
      })
      const items = extractItems(payload)
      if (items.length > 0) {
        orgItems[index] = orgItems[index].concat(items)
        orgOffset[index] += items.length
        orgFrontier[index] = availableAtMs(items[items.length - 1])
      }
      if (items.length < API_MAX_LIMIT) orgExhausted[index] = true
    } catch {
      orgExhausted[index] = true
    }
  }

  const fetchMoreOnce = () => {
    if (inflight) return inflight
    if (allExhausted()) return Promise.resolve()

    // Push the frontier down by fetching from whichever non-exhausted org(s)
    // currently cap it. Advancing the laggard keeps every page boundary stable.
    const pending = orgTargets
      .map((_, index) => index)
      .filter((index) => !orgExhausted[index])
    const cutoff = Math.max(...pending.map((index) => orgFrontier[index]))
    const targets = pending.filter((index) => orgFrontier[index] === cutoff)

    inflight = Promise.all(targets.map(fetchOrg)).then(() => {
      version++
      inflight = null
    })
    return inflight
  }

  return {
    ensure: async (count) => {
      let rounds = 0
      while (
        committed().length < count &&
        !allExhausted() &&
        rounds < MAX_FETCH_ROUNDS_PER_LOAD
      ) {
        rounds++
        await fetchMoreOnce()
      }
    },
    slice: (offset, limit) => committed().slice(offset, offset + limit),
    committedCount: () => committed().length,
    isExhausted: allExhausted,
  }
}

const pagedSources = new Map<string, PagedSource>()

function getPagedSource(
  tabValue: PagedTabValue,
  selectedHomeOrgs: string[],
  fresh: boolean
) {
  const orgTargets = selectedHomeOrgs.length ? selectedHomeOrgs : ["All Vtubers"]
  const cacheKey = cacheKeyForTab(tabValue, orgTargets)
  if (fresh) pagedSources.delete(cacheKey)
  let source = pagedSources.get(cacheKey)
  if (!source) {
    // Only archived streams carry a duration that pushes end time past start;
    // clips end at their timestamp, so no look-ahead is needed for them.
    const maxKeyAheadMs = tabValue === "archive" ? MAX_STREAM_DURATION_MS : 0
    source = createPagedSource(buildTabQuery(tabValue), orgTargets, maxKeyAheadMs)
    pagedSources.set(cacheKey, source)
  }
  return source
}

function clearPagedSources() {
  pagedSources.clear()
}

function VideoGrid({ videos }: { videos: HolodexVideo[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {videos.map((video, index) => (
        <VideoCard
          key={video.id}
          video={video}
          eagerThumbnail={index < EAGER_THUMBNAIL_COUNT}
        />
      ))}
    </div>
  )
}

function GridSkeleton() {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
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
  const { currentPage, items, knownPages, canLoadMore, loading, error } = state
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

      {items.length ? <VideoGrid videos={items} /> : null}

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
  const [orgs, setOrgs] = useState<Org[]>([])
  const [orgsLoading, setOrgsLoading] = useState(false)
  const [orgsError, setOrgsError] = useState<string | null>(null)
  const [selectedHomeOrgs, setSelectedHomeOrgsState] =
    useState<string[]>(() => [...DEFAULT_HOME_ORGS])
  const [tab, setTab] = useState<TabValue>("live")
  const [homeLive, setHomeLive] = useState<HolodexVideo[]>([])
  const [homeLoading, setHomeLoading] = useState(true)
  const [homeError, setHomeError] = useState<string | null>(null)
  const [homeLastLiveUpdate, setHomeLastLiveUpdate] = useState(0)
  const [homeLiveCacheKey, setHomeLiveCacheKey] = useState(
    () => makeLiveCacheKey(DEFAULT_HOME_ORGS)
  )
  const [storageHydrated, setStorageHydrated] = useState(false)
  const [tabStates, setTabStates] = useState(initialTabStates)

  const orgsRef = useRef<Org[]>([])
  const orgsInflight = useRef<Promise<Org[]> | null>(null)
  const selectedHomeOrgsRef = useRef(selectedHomeOrgs)
  const homeStateRef = useRef<HomeStateSnapshot>({
    homeLive,
    homeError,
    homeLastLiveUpdate,
    homeLiveCacheKey,
  })
  const homeInflight = useRef<Promise<void> | null>(null)
  const homeFetchSeq = useRef(0)
  const tabStatesRef = useRef(tabStates)
  const tabFetchSeq = useRef<Record<PagedTabValue, number>>({
    archive: 0,
    clips: 0,
  })
  const previousSelectedKey = useRef(JSON.stringify(selectedHomeOrgs))

  const syncHomeState = useCallback(
    (
      next: HomeStateSnapshot,
      opts: { loading: boolean; preserveLiveIdentity?: boolean }
    ) => {
      setHomeLive((previous) =>
        opts.preserveLiveIdentity &&
        liveFingerprint(next.homeLive) === liveFingerprint(previous)
          ? previous
          : next.homeLive
      )
      setHomeError(next.homeError)
      setHomeLastLiveUpdate(next.homeLastLiveUpdate)
      setHomeLiveCacheKey(next.homeLiveCacheKey)
      setHomeLoading(opts.loading)
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

    orgsRef.current = storedOrgs
    selectedHomeOrgsRef.current = storedSelected
    setOrgs(storedOrgs)
    setSelectedHomeOrgsState(storedSelected)
    previousSelectedKey.current = JSON.stringify(storedSelected)

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
  }, [syncHomeState])

  useEffect(() => {
    orgsRef.current = orgs
  }, [orgs])

  useEffect(() => {
    selectedHomeOrgsRef.current = selectedHomeOrgs
  }, [selectedHomeOrgs])

  useEffect(() => {
    homeStateRef.current = {
      homeLive,
      homeError,
      homeLastLiveUpdate,
      homeLiveCacheKey,
    }
  }, [homeError, homeLastLiveUpdate, homeLive, homeLiveCacheKey])

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
          window.localStorage.setItem(
            ORGS_STORAGE_KEY,
            JSON.stringify({ orgs: fresh })
          )
          return fresh
        })
        .finally(() => {
          orgsInflight.current = null
          setOrgsLoading(false)
        })
      return orgsInflight.current
    }

    if (current.length > 0) {
      loadFresh()
        .then((fresh) => {
          if (
            JSON.stringify(fresh.map((org) => org.name)) !==
            JSON.stringify((orgsRef.current || []).map((org) => org.name))
          ) {
            setOrgs(fresh)
            orgsRef.current = fresh
          }
        })
        .catch((error) => {
          setOrgsError(errorMessage(error))
        })
      return current
    }

    try {
      const fresh = await loadFresh()
      setOrgs(fresh)
      orgsRef.current = fresh
      return fresh
    } catch (error) {
      setOrgsError(errorMessage(error))
      return []
    }
  }, [])

  const fetchHomeLive = useCallback(
    (opts: { force?: boolean; minutes?: number } = {}) => {
      if (isDocumentHidden() && !opts.force) {
        return null
      }

      const { force = false, minutes = 5 } = opts
      const orgTargets = selectedHomeOrgsRef.current.length
        ? selectedHomeOrgsRef.current
        : ["All Vtubers"]
      const nextCacheKey = makeLiveCacheKey(orgTargets)
      const current = homeStateRef.current
      const cacheChanged = current.homeLiveCacheKey !== nextCacheKey
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
      if (cacheChanged && visibleLive.length === 0) {
        const cachedHomeLive = readStoredHomeLive(nextCacheKey)
        if (cachedHomeLive) {
          visibleLive = prepareHomeLiveVideos(cachedHomeLive.videos)
          visibleLastUpdate = cachedHomeLive.updatedAt
        }
      }

      syncHomeState(
        {
          homeLive: visibleLive,
          homeError: null,
          homeLastLiveUpdate: visibleLastUpdate,
          homeLiveCacheKey: nextCacheKey,
        },
        { loading: visibleLive.length === 0, preserveLiveIdentity: true }
      )

      const seq = ++homeFetchSeq.current
      const commitLive = (videos: HolodexVideo[]) => {
        if (seq !== homeFetchSeq.current) return
        const merged = prepareHomeLiveVideos(videos)
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

      const request = fetchAllLive(orgTargets, HOME_LIVE_QUERY)
        .then(async (response) => {
          if (seq !== homeFetchSeq.current) return
          const enriched = await enrichLiveVideosBestEffort(response)
          if (seq !== homeFetchSeq.current) return
          commitLive(enriched)
        })
        .catch((error) => {
          if (seq !== homeFetchSeq.current) return
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
    async (tabValue: PagedTabValue, page = 1, force = false) => {
      const requestedPage = Math.max(1, page)
      const needed = requestedPage * PAGE_LENGTH
      const seq = ++tabFetchSeq.current[tabValue]
      const source = getPagedSource(tabValue, selectedHomeOrgsRef.current, force)

      const ready = !force && source.committedCount() >= needed
      if (!ready) {
        setTabStates((current) => ({
          ...current,
          [tabValue]: { ...current[tabValue], loading: true, error: null },
        }))
      }

      try {
        await source.ensure(needed)
        if (seq !== tabFetchSeq.current[tabValue]) return

        const exhausted = source.isExhausted()
        const committedCount = source.committedCount()
        const maxPage = Math.max(1, Math.ceil(committedCount / PAGE_LENGTH))
        const finalPage = exhausted
          ? Math.min(requestedPage, maxPage)
          : requestedPage
        const items = source.slice((finalPage - 1) * PAGE_LENGTH, PAGE_LENGTH)
        preloadVideoThumbnails(items, PAGE_THUMBNAIL_PRELOAD_LIMIT)

        setTabStates((current) => ({
          ...current,
          [tabValue]: {
            currentPage: finalPage,
            items,
            knownPages: Math.max(finalPage, maxPage),
            canLoadMore: !exhausted,
            loading: false,
            error: null,
          },
        }))

        // Warm the next pages so navigation is instant, and reveal any newly
        // known page numbers without disturbing the visible page.
        if (!exhausted) {
          void source
            .ensure((finalPage + PREFETCH_PAGE_COUNT) * PAGE_LENGTH)
            .then(() => {
              if (seq !== tabFetchSeq.current[tabValue]) return
              setTabStates((current) => {
                const tabState = current[tabValue]
                const nextKnown = Math.max(
                  tabState.currentPage,
                  Math.ceil(source.committedCount() / PAGE_LENGTH)
                )
                const nextCanLoadMore = !source.isExhausted()
                if (
                  nextKnown === tabState.knownPages &&
                  nextCanLoadMore === tabState.canLoadMore
                ) {
                  return current
                }
                return {
                  ...current,
                  [tabValue]: {
                    ...tabState,
                    knownPages: nextKnown,
                    canLoadMore: nextCanLoadMore,
                  },
                }
              })
            })
            .catch(() => {})
        }
      } catch (error) {
        if (seq !== tabFetchSeq.current[tabValue]) return
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

  const refreshAll = useCallback(() => {
    if (isDocumentHidden()) return
    void fetchHomeLive({ force: true })
    for (const tabValue of ["archive", "clips"] as PagedTabValue[]) {
      void loadTabPage(tabValue, tabStatesRef.current[tabValue].currentPage, true)
    }
  }, [fetchHomeLive, loadTabPage])

  function setSelectedHomeOrgs(nextRaw: string[]) {
    const next = normalizeSelectedHomeOrgs(nextRaw)
    setSelectedHomeOrgsState(next)
    selectedHomeOrgsRef.current = next
    window.localStorage.setItem(HOME_SELECTED_ORGS_KEY, JSON.stringify(next))
  }

  useEffect(() => {
    if (!storageHydrated) return
    void loadOrgs()
    void fetchHomeLive(INITIAL_LIVE_REFRESH)
    void loadTabPage("archive", 1)
    void loadTabPage("clips", 1)
  }, [fetchHomeLive, loadOrgs, loadTabPage, storageHydrated])

  const selectedKey = JSON.stringify(selectedHomeOrgs)

  useEffect(() => {
    if (!storageHydrated) return
    if (previousSelectedKey.current === selectedKey) return
    previousSelectedKey.current = selectedKey
    clearPagedSources()
    setTabStates(initialTabStates())
    void fetchHomeLive(INITIAL_LIVE_REFRESH)
    for (const tabValue of ["archive", "clips"] as PagedTabValue[]) {
      void loadTabPage(tabValue, 1, true)
    }
  }, [fetchHomeLive, loadTabPage, selectedKey, storageHydrated])

  useEffect(() => {
    if (!storageHydrated) return
    const interval = window.setInterval(refreshAll, AUTO_REFRESH_MS)
    return () => window.clearInterval(interval)
  }, [refreshAll, storageHydrated])

  const liveStreams = useMemo(
    () =>
      homeLive
        .filter((video) => video.status === "live")
        .sort((a, b) => getLiveViewerCount(b) - getLiveViewerCount(a)),
    [homeLive]
  )
  const upcomingStreams = useMemo(
    () =>
      homeLive
        .filter((video) => video.status === "upcoming")
        .sort(upcomingComparator),
    [homeLive]
  )

  const archiveState = tabStates.archive
  const clipsState = tabStates.clips

  const changeTab = (value: string) => {
    const nextTab = value as TabValue
    if (isPagedTabValue(nextTab)) {
      const tabState = tabStatesRef.current[nextTab]
      if (!tabState.items.length && !tabState.loading && !tabState.error) {
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
              onApply={setSelectedHomeOrgs}
            />
          </header>

          <div className="flex items-center justify-between gap-2">
            <TabsList variant="line">
              <TabsTrigger value="live">Live</TabsTrigger>
              <TabsTrigger value="archive">Archive</TabsTrigger>
              <TabsTrigger value="clips">Clips</TabsTrigger>
            </TabsList>
          </div>
        </div>

        <TabsContent value="live" forceMount>
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

        <TabsContent value="archive" forceMount>
          <PagedTabContent
            tabValue="archive"
            state={archiveState}
            onPageChange={changePagedTabPage}
          />
        </TabsContent>

        <TabsContent value="clips" forceMount>
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
