"use client"

import {
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Building2, ChevronDown, RotateCcw } from "lucide-react"

import type { Org } from "@/lib/types"
import {
  allVtubersOrg,
  formatOrgDisplayName,
  preferredOrgNames,
} from "@/lib/orgs"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

type HomeOrgMultiSelectProps = {
  orgs: Org[]
  orgsLoading: boolean
  orgsError: string | null
  selectedNames: string[]
  fetchOrgs: () => Promise<Org[]>
  onDraftChange?: (draft: string[]) => void
  onApply: (value: string[]) => void
}

let measureContext: CanvasRenderingContext2D | null = null

function getMeasureContext() {
  if (!measureContext && typeof document !== "undefined") {
    measureContext = document.createElement("canvas").getContext("2d")
  }
  return measureContext
}

function orgCountLabel(count: number) {
  return `${count} ${count === 1 ? "Org" : "Orgs"}`
}

function buildOrgSelectionLabel(
  selectedNames: string[],
  labelWidth: number,
  font: string
) {
  if (selectedNames.length === 0) return allVtubersOrg.name

  const selectedLabels = selectedNames.map((name) => formatOrgDisplayName(name))
  const context = labelWidth ? getMeasureContext() : null
  if (!context) return selectedLabels.join(" + ")
  context.font = font

  const fits = (label: string) => context.measureText(label).width <= labelWidth
  if (fits(selectedLabels.join(" + "))) return selectedLabels.join(" + ")

  for (
    let visibleCount = selectedLabels.length - 1;
    visibleCount >= 1;
    visibleCount--
  ) {
    const remainingCount = selectedLabels.length - visibleCount
    const label = `${selectedLabels.slice(0, visibleCount).join(" + ")} + ${orgCountLabel(remainingCount)}`
    if (fits(label)) return label
  }

  return orgCountLabel(selectedNames.length)
}

export function HomeOrgMultiSelect({
  orgs,
  orgsLoading,
  orgsError,
  selectedNames,
  fetchOrgs,
  onDraftChange,
  onApply,
}: HomeOrgMultiSelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [draftSelectedNames, setDraftSelectedNames] = useState<string[]>([])
  const [labelMetrics, setLabelMetrics] = useState({
    font: "",
    width: 0,
  })
  const labelRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!orgs.length) void fetchOrgs()
  }, [fetchOrgs, orgs.length])

  const selectableOrgs = useMemo(
    () => (orgs || []).filter((org) => org.name !== allVtubersOrg.name),
    [orgs]
  )

  const workingSelectedNames = open ? draftSelectedNames : selectedNames

  const quickSelectOrgOptions = useMemo(() => {
    const available = new Set(selectableOrgs.map((org) => org.name))
    return preferredOrgNames
      .filter((name) => available.has(name))
      .map((name) => ({ value: name, label: formatOrgDisplayName(name) }))
  }, [selectableOrgs])

  const filteredOrgs = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return selectableOrgs
    return selectableOrgs.filter((org) =>
      [org.name, org.short, org.name_jp]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query))
    )
  }, [selectableOrgs, search])

  useLayoutEffect(() => {
    const label = labelRef.current
    if (!label) return

    const updateLabelMetrics = () => {
      const style = window.getComputedStyle(label)
      const next = {
        font: style.font,
        width: label.getBoundingClientRect().width,
      }
      setLabelMetrics((current) =>
        current.font === next.font && current.width === next.width
          ? current
          : next
      )
    }

    updateLabelMetrics()
    const observer = new ResizeObserver(updateLabelMetrics)
    observer.observe(label)
    return () => observer.disconnect()
  }, [])

  const triggerLabel = useMemo(
    () =>
      buildOrgSelectionLabel(selectedNames, labelMetrics.width, labelMetrics.font),
    [labelMetrics.font, labelMetrics.width, selectedNames]
  )

  async function openSelector() {
    if (!orgs.length) await fetchOrgs()
    setDraftSelectedNames([...selectedNames])
    setSearch("")
    setOpen(true)
  }

  function closeSelector(nextOpen: boolean) {
    if (nextOpen) {
      void openSelector()
      return
    }
    setOpen(false)
    setSearch("")
    startTransition(() => applySelection(draftSelectedNames))
  }

  function toggleName(name: string) {
    const next = draftSelectedNames.includes(name)
      ? draftSelectedNames.filter((value) => value !== name)
      : [...draftSelectedNames, name]
    setDraftSelectedNames(next)
    onDraftChange?.(next)
  }

  function clearSelection() {
    setDraftSelectedNames([])
    onDraftChange?.([])
  }

  function applySelection(nextRaw: string[]) {
    const nextSelection = [...new Set(nextRaw)]
    const prevSelection = [...selectedNames]
    const changed =
      nextSelection.length !== prevSelection.length ||
      nextSelection.some((name, index) => name !== prevSelection[index])
    if (changed) onApply(nextSelection)
  }

  return (
    <Popover open={open} onOpenChange={closeSelector}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className="h-8 w-52 min-w-0 shrink justify-start gap-1.5 px-2.5 md:w-72"
          />
        }
      >
        <Building2 className="shrink-0" />
        <span ref={labelRef} className="min-w-0 flex-1 truncate text-left">
          {labelMetrics.width > 0 ? triggerLabel : null}
        </span>
        <ChevronDown className="ml-auto shrink-0" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--anchor-width)] max-w-[calc(100vw-1rem)] p-0"
        initialFocus={false}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search organizations"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-[28rem]">
            {orgsError ? (
              <Alert variant="destructive">
                <AlertTitle>Organization load failed</AlertTitle>
                <AlertDescription>{orgsError}</AlertDescription>
              </Alert>
            ) : null}

            <CommandGroup heading="Quick Select">
              <div className="flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant={
                    workingSelectedNames.length === 0 ? "default" : "secondary"
                  }
                  onClick={clearSelection}
                >
                  {allVtubersOrg.name}
                </Button>
                {quickSelectOrgOptions.map((option) => {
                  const selected = workingSelectedNames.includes(option.value)
                  return (
                    <Button
                      key={option.value}
                      type="button"
                      size="sm"
                      variant={selected ? "default" : "secondary"}
                      onClick={() => toggleName(option.value)}
                    >
                      {option.label}
                    </Button>
                  )
                })}
              </div>
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup
              heading={
                workingSelectedNames.length
                  ? `${workingSelectedNames.length} selected`
                  : "Organizations"
              }
            >
              {orgsLoading && !selectableOrgs.length ? (
                <CommandEmpty>Loading organizations</CommandEmpty>
              ) : null}

              {!orgsLoading && filteredOrgs.length === 0 ? (
                <CommandEmpty>No organizations found</CommandEmpty>
              ) : null}

              {filteredOrgs.map((org) => {
                const selected = workingSelectedNames.includes(org.name)
                return (
                  <CommandItem
                    key={org.name}
                    value={org.name}
                    data-checked={selected}
                    onSelect={() => toggleName(org.name)}
                  >
                    <Checkbox checked={selected} aria-label={org.name} />
                    {formatOrgDisplayName(org.name)}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
          <div className="flex items-center justify-between gap-2 border-t p-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={clearSelection}
            >
              <RotateCcw />
              {allVtubersOrg.name}
            </Button>
            <Button type="button" size="sm" onClick={() => closeSelector(false)}>
              Apply
            </Button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
