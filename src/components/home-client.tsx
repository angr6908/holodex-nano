"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { fetchAllLive, fetchOrgs, fetchVideos } from "@/lib/holodex"
import {
  makeLiveCacheKey,
  normalizeSelectedHomeOrgs,
} from "@/lib/orgs"
import type { HolodexVideo, Org } from "@/lib/types"
import {
  dedupeVideos,
  extractItems,
  getTwitchLogin,
  getLiveViewerCount,
  sortVideosForTab,
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
const API_MAX_LIMIT = 100
const PAGE_LENGTH = 24
const PREFETCH_PAGE_COUNT = 2

type TabValue = "live" | "archive" | "clips"
type PagedTabValue = Exclude<TabValue, "live">
type TabState = {
  pages: Record<number, HolodexVideo[]>
  pageHasMore: Record<number, boolean>
  loading: boolean
  error: string | null
  currentPage: number
}

type PagedDataCacheEntry = {
  page1: Promise<HolodexVideo[]>
  getCurrentItems: () => HolodexVideo[]
  fetchMore: () => Promise<void>
  isExhausted: () => boolean
}

type CommitHomeLiveOptions = {
  final?: boolean
  allowEmpty?: boolean
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

const pagedDataCache = new Map<string, PagedDataCacheEntry>()

function emptyTabState(): TabState {
  return {
    pages: {},
    pageHasMore: {},
    loading: false,
    error: null,
    currentPage: 1,
  }
}

function initialTabStates() {
  return {
    archive: emptyTabState(),
    clips: emptyTabState(),
  }
}

function readStoredSelectedOrgs() {
  if (typeof window === "undefined") return ["Hololive"]
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(HOME_SELECTED_ORGS_KEY) || "null"
    )
    return Array.isArray(parsed) ? normalizeSelectedHomeOrgs(parsed) : ["Hololive"]
  } catch {
    return ["Hololive"]
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

function buildTabQuery(tabValue: PagedTabValue): Record<string, unknown> {
  const isArchive = tabValue === "archive"
  return {
    status: isArchive ? "past,missing" : "past",
    type: isArchive ? "stream" : "clip",
    lang: "en",
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
    "lang-en",
  ].join("-")
}

function startPagedFetch(
  cacheKey: string,
  query: Record<string, unknown>,
  orgTargets: string[],
  tabValue: PagedTabValue
) {
  if (pagedDataCache.has(cacheKey)) return

  const baseQuery = { ...query, paginated: false }
  const isArchive = tabValue === "archive"
  const allOrgItems: HolodexVideo[][] = orgTargets.map(() => [])
  const orgOffsets: number[] = orgTargets.map(() => 0)
  const orgExhausted: boolean[] = orgTargets.map(() => false)
  let inflightFetch: Promise<void> | null = null
  let currentItems: HolodexVideo[] = []

  const mergeAll = () => {
    currentItems = sortVideosForTab(dedupeVideos(allOrgItems.flat()), isArchive)
  }

  const orgPage1Promises = orgTargets.map((org, index) =>
    fetchVideos({ ...baseQuery, org, limit: API_MAX_LIMIT, offset: 0 })
      .then((payload) => {
        allOrgItems[index] = extractItems(payload)
        orgOffsets[index] = API_MAX_LIMIT
        if (allOrgItems[index].length < API_MAX_LIMIT) orgExhausted[index] = true
        return allOrgItems[index]
      })
      .catch(() => {
        orgExhausted[index] = true
        allOrgItems[index] = []
        return []
      })
  )

  const page1 = Promise.all(orgPage1Promises).then(() => {
    mergeAll()
    return currentItems
  })

  const fetchMore = (): Promise<void> => {
    if (inflightFetch) return inflightFetch
    if (orgExhausted.every(Boolean)) return Promise.resolve()

    inflightFetch = Promise.all(
      orgTargets.map(async (org, index) => {
        if (orgExhausted[index]) return
        try {
          const payload = await fetchVideos({
            ...baseQuery,
            org,
            limit: API_MAX_LIMIT,
            offset: orgOffsets[index],
          })
          const items = extractItems(payload)
          allOrgItems[index] = [...allOrgItems[index], ...items]
          orgOffsets[index] += API_MAX_LIMIT
          if (items.length < API_MAX_LIMIT) orgExhausted[index] = true
        } catch {
          orgExhausted[index] = true
        }
      })
    ).then(() => {
      mergeAll()
      inflightFetch = null
    })

    return inflightFetch
  }

  pagedDataCache.set(cacheKey, {
    page1,
    getCurrentItems: () => currentItems,
    fetchMore,
    isExhausted: () => orgExhausted.every(Boolean),
  })
}

async function resolveTabPage(
  tabValue: PagedTabValue,
  selectedHomeOrgs: string[],
  offset: number,
  limit: number
) {
  const query = buildTabQuery(tabValue)
  const orgTargets = selectedHomeOrgs.length ? selectedHomeOrgs : ["All Vtubers"]

  const cacheKey = cacheKeyForTab(tabValue, orgTargets)
  startPagedFetch(cacheKey, query, orgTargets, tabValue)

  const cached = pagedDataCache.get(cacheKey)
  if (!cached) return { items: [], hasMore: false }

  await cached.page1
  while (offset + limit > cached.getCurrentItems().length && !cached.isExhausted()) {
    await cached.fetchMore()
  }

  const snapshot = cached.getCurrentItems()
  const slice = snapshot.slice(offset, offset + limit)
  if (
    !cached.isExhausted() &&
    snapshot.length - (offset + limit) < limit * PREFETCH_PAGE_COUNT
  ) {
    void cached.fetchMore()
  }

  return {
    items: slice,
    hasMore: !cached.isExhausted() || offset + limit < snapshot.length,
  }
}

function VideoGrid({ videos }: { videos: HolodexVideo[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {videos.map((video) => (
        <VideoCard key={video.id} video={video} />
      ))}
    </div>
  )
}

function GridSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 12 }).map((_, index) => (
        <div key={index} className="space-y-3">
          <Skeleton className="aspect-video w-full" />
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ))}
    </div>
  )
}

function visiblePaginationItems(state: TabState) {
  const currentPage = state.currentPage
  const loadedPages = Object.keys(state.pages).map(Number)
  const hasNextPage = Boolean(state.pageHasMore[currentPage])
  const maxLoadedPage = Math.max(1, ...loadedPages)
  const maxReachablePage = Math.max(
    maxLoadedPage,
    hasNextPage ? currentPage + 1 : currentPage
  )
  const pageSet = new Set([1, currentPage])

  if (currentPage > 1) pageSet.add(currentPage - 1)
  if (currentPage < maxReachablePage) pageSet.add(currentPage + 1)
  for (const page of loadedPages) {
    if (Math.abs(page - currentPage) <= 1) pageSet.add(page)
  }

  const pages = Array.from(pageSet)
    .filter((page) => page >= 1 && page <= maxReachablePage)
    .sort((a, b) => a - b)

  const items: Array<number | "ellipsis"> = []
  for (const page of pages) {
    const previous = items.at(-1)
    if (typeof previous === "number" && page - previous > 1) {
      items.push("ellipsis")
    }
    items.push(page)
  }

  if (hasNextPage) items.push("ellipsis")
  return items
}

function pageItems(state: TabState) {
  return state.pages[state.currentPage] || []
}

function PagedTabContent({
  tabValue,
  state,
  items,
  paginationItems,
  hasNextPage,
  onPageChange,
}: {
  tabValue: PagedTabValue
  state: TabState
  items: HolodexVideo[]
  paginationItems: Array<number | "ellipsis">
  hasNextPage: boolean
  onPageChange: (tabValue: PagedTabValue, page: number) => void
}) {
  const copy = pagedTabCopy[tabValue]
  const showPagination = items.length > 0 || state.currentPage > 1 || hasNextPage

  return (
    <div className="space-y-4">
      {state.error ? (
        <Alert variant="destructive">
          <AlertTitle>{copy.errorTitle}</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      {items.length ? <VideoGrid videos={items} /> : null}

      {state.loading && !items.length ? <GridSkeleton /> : null}

      {!state.loading && !items.length ? (
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
            {state.currentPage > 1 ? (
              <PaginationItem>
                <PaginationPrevious
                  href="#"
                  onClick={(event) => {
                    event.preventDefault()
                    onPageChange(tabValue, state.currentPage - 1)
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
                    isActive={item === state.currentPage}
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
            {hasNextPage ? (
              <PaginationItem>
                <PaginationNext
                  href="#"
                  onClick={(event) => {
                    event.preventDefault()
                    onPageChange(tabValue, state.currentPage + 1)
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
  const [selectedHomeOrgs, setSelectedHomeOrgsState] = useState<string[]>([
    "Hololive",
  ])
  const [tab, setTab] = useState<TabValue>("live")
  const [homeLive, setHomeLive] = useState<HolodexVideo[]>([])
  const [homeLoading, setHomeLoading] = useState(true)
  const [homeError, setHomeError] = useState<string | null>(null)
  const [homeLastLiveUpdate, setHomeLastLiveUpdate] = useState(0)
  const [homeLiveCacheKey, setHomeLiveCacheKey] = useState(
    JSON.stringify(["Hololive"])
  )
  const [tabStates, setTabStates] = useState(initialTabStates)

  const orgsRef = useRef<Org[]>([])
  const orgsInflight = useRef<Promise<Org[]> | null>(null)
  const selectedHomeOrgsRef = useRef(selectedHomeOrgs)
  const homeStateRef = useRef({
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

  useEffect(() => {
    const storedOrgs = readStoredOrgs()
    const storedSelected = readStoredSelectedOrgs()
    orgsRef.current = storedOrgs
    selectedHomeOrgsRef.current = storedSelected
    setOrgs(storedOrgs)
    setSelectedHomeOrgsState(storedSelected)
    setHomeLiveCacheKey(makeLiveCacheKey(storedSelected))
  }, [])

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
          setOrgsError(error instanceof Error ? error.message : "Unknown error")
        })
      return current
    }

    try {
      const fresh = await loadFresh()
      setOrgs(fresh)
      orgsRef.current = fresh
      return fresh
    } catch (error) {
      setOrgsError(error instanceof Error ? error.message : "Unknown error")
      return []
    }
  }, [])

  const fetchHomeLive = useCallback(
    (opts: { force?: boolean; minutes?: number } = {}) => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden" &&
        !opts.force
      ) {
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

      if (cacheChanged) setHomeLive([])
      setHomeLiveCacheKey(nextCacheKey)
      setHomeLoading(cacheChanged || current.homeLive.length === 0)
      setHomeError(null)

      const seq = ++homeFetchSeq.current
      const commitLive = (
        videos: HolodexVideo[],
        opts: CommitHomeLiveOptions = {}
      ) => {
        if (seq !== homeFetchSeq.current) return
        const merged = prepareHomeLiveVideos(videos)
        if (!opts.allowEmpty && merged.length === 0) return

        setHomeLive((previous) =>
          liveFingerprint(merged) !== liveFingerprint(previous) ? merged : previous
        )
        if (opts.final) setHomeLastLiveUpdate(Date.now())
        setHomeLoading(false)
        setHomeError(null)
      }

      const liveQuery = {
        type: "placeholder,stream",
        include: "mentions",
        limit: API_MAX_LIMIT,
      }
      const request = fetchAllLive(orgTargets, liveQuery, {
        onPartial: (videos) => commitLive(videos),
      })
        .then((response) => {
          if (seq !== homeFetchSeq.current) return
          commitLive(response, { final: true, allowEmpty: true })
          void enrichLiveVideosWithTwitchViewerCounts(response).then((enriched) => {
            if (seq !== homeFetchSeq.current) return
            const merged = sortHomeLiveVideos(enriched)
            setHomeLive((previous) =>
              liveFingerprint(merged) !== liveFingerprint(previous)
                ? merged
                : previous
            )
          })
        })
        .catch((error) => {
          if (seq !== homeFetchSeq.current) return
          setHomeError(error instanceof Error ? error.message : "Unknown error")
          setHomeLoading(false)
        })
        .finally(() => {
          if (seq === homeFetchSeq.current) homeInflight.current = null
        })

      homeInflight.current = request
      return request
    },
    []
  )

  const loadTabPage = useCallback(
    async (
      tabValue: PagedTabValue,
      page = 1,
      force = false
    ) => {
      const nextPage = Math.max(1, page)
      const currentState = tabStatesRef.current[tabValue]
      if (currentState.loading) return
      if (!force && currentState.pages[nextPage]) {
        setTabStates((current) => ({
          ...current,
          [tabValue]: {
            ...current[tabValue],
            currentPage: nextPage,
            error: null,
          },
        }))
        return
      }

      const offset = (nextPage - 1) * PAGE_LENGTH
      const seq = ++tabFetchSeq.current[tabValue]

      setTabStates((current) => ({
        ...current,
        [tabValue]: {
          ...current[tabValue],
          currentPage: nextPage,
          loading: true,
          error: null,
        },
      }))

      try {
        const result = await resolveTabPage(
          tabValue,
          selectedHomeOrgsRef.current,
          offset,
          PAGE_LENGTH
        )
        if (seq !== tabFetchSeq.current[tabValue]) return

        setTabStates((current) => ({
          ...current,
          [tabValue]: {
            ...current[tabValue],
            pages: {
              ...current[tabValue].pages,
              [nextPage]: result.items,
            },
            pageHasMore: {
              ...current[tabValue].pageHasMore,
              [nextPage]: result.hasMore,
            },
            loading: false,
            error: null,
            currentPage: nextPage,
          },
        }))
      } catch (error) {
        if (seq !== tabFetchSeq.current[tabValue]) return
        setTabStates((current) => ({
          ...current,
          [tabValue]: {
            ...current[tabValue],
            loading: false,
            error: error instanceof Error ? error.message : "Unknown error",
          },
        }))
      }
    },
    []
  )

  function setSelectedHomeOrgs(nextRaw: string[]) {
    const next = normalizeSelectedHomeOrgs(nextRaw)
    setSelectedHomeOrgsState(next)
    selectedHomeOrgsRef.current = next
    window.localStorage.setItem(HOME_SELECTED_ORGS_KEY, JSON.stringify(next))
  }

  useEffect(() => {
    void loadOrgs()
    void fetchHomeLive({ force: true, minutes: 2 })
  }, [fetchHomeLive, loadOrgs])

  const selectedKey = JSON.stringify(selectedHomeOrgs)

  useEffect(() => {
    if (previousSelectedKey.current === selectedKey) return
    previousSelectedKey.current = selectedKey
    pagedDataCache.clear()
    setTabStates(initialTabStates())
    void fetchHomeLive({ force: true, minutes: 2 })
    if (tab !== "live") void loadTabPage(tab, 1, true)
  }, [fetchHomeLive, loadTabPage, selectedKey, tab])

  useEffect(() => {
    if (tab === "live") return
    const currentState = tabStatesRef.current[tab]
    if (!currentState.pages[currentState.currentPage]) {
      void loadTabPage(tab, currentState.currentPage)
    }
  }, [loadTabPage, tab])

  const live = useMemo(
    () =>
      [...homeLive].sort(
        (a, b) => getLiveViewerCount(b) - getLiveViewerCount(a)
      ),
    [homeLive]
  )

  const lives = live.filter((video) => video.status === "live")
  const upcoming = live
    .filter((video) => video.status === "upcoming")
    .sort((v1, v2) => {
      if (v1.available_at !== v2.available_at) return 0
      if (v1.type === "placeholder" && v2.type === "placeholder") return 0
      return v1.type === "placeholder" ? 1 : -1
    })

  const archiveState = tabStates.archive
  const archiveItems = pageItems(archiveState)
  const archivePaginationItems = visiblePaginationItems(archiveState)
  const archiveHasNextPage = Boolean(
    archiveState.pageHasMore[archiveState.currentPage]
  )
  const clipsState = tabStates.clips
  const clipsItems = pageItems(clipsState)
  const clipsPaginationItems = visiblePaginationItems(clipsState)
  const clipsHasNextPage = Boolean(clipsState.pageHasMore[clipsState.currentPage])
  const changePagedTabPage = (tabValue: PagedTabValue, page: number) => {
    void loadTabPage(tabValue, page)
    window.scrollTo({ top: 0, left: 0, behavior: "auto" })
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 pb-4">
      <Tabs value={tab} onValueChange={(value) => setTab(value as TabValue)}>
        <div className="sticky top-0 z-10 -mx-4 -mb-1 flex flex-col gap-4 bg-background px-4 pt-4 pb-3">
          <header className="flex items-center justify-between gap-2 min-w-0">
            <Link
              href="/"
              aria-label="Holodex Nano"
              className="flex min-w-0 shrink items-center gap-2.5 pr-2 text-left no-underline select-none min-[960px]:pr-4"
              onClick={(event) => {
                event.preventDefault()
                setTab("live")
                window.scrollTo({ top: 0, left: 0, behavior: "auto" })
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

        <TabsContent value="live">
          {homeError ? (
            <Alert variant="destructive">
              <AlertTitle>Live load failed</AlertTitle>
              <AlertDescription>{homeError}</AlertDescription>
            </Alert>
          ) : null}

          {homeLoading ? <GridSkeleton /> : null}

          {!homeLoading && !homeError && !lives.length && !upcoming.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No streams</EmptyTitle>
                <EmptyDescription>
                  Change organizations or refresh the live feed.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {lives.length ? <VideoGrid videos={lives} /> : null}

          {lives.length && upcoming.length ? <Separator className="my-4" /> : null}

          {upcoming.length ? <VideoGrid videos={upcoming} /> : null}
        </TabsContent>

        <TabsContent value="archive">
          <PagedTabContent
            tabValue="archive"
            state={archiveState}
            items={archiveItems}
            paginationItems={archivePaginationItems}
            hasNextPage={archiveHasNextPage}
            onPageChange={changePagedTabPage}
          />
        </TabsContent>

        <TabsContent value="clips">
          <PagedTabContent
            tabValue="clips"
            state={clipsState}
            items={clipsItems}
            paginationItems={clipsPaginationItems}
            hasNextPage={clipsHasNextPage}
            onPageChange={changePagedTabPage}
          />
        </TabsContent>
      </Tabs>
    </main>
  )
}
