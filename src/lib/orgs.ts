import type { Org } from "@/lib/types"

export const allVtubersOrg: Org = {
  name: "All Vtubers",
  short: "Vtuber",
  name_jp: null,
}

export const preferredOrgNames = [
  "Hololive",
  "Nijisanji",
  "VSpo",
  "Neo-Porte",
  "774inc",
  "Varium",
  "RK Music",
  "Riot Music",
]

export function formatOrgDisplayName(name: string): string {
  return name === "VSpo" ? "VSPO" : name || ""
}

export function normalizeSelectedHomeOrgs(orgs: string[]): string[] {
  return [
    ...new Set((orgs || []).filter((name) => name && name !== "All Vtubers")),
  ]
}

export function normalizeOrgs(payload: unknown): Org[] {
  const raw = Array.isArray(payload)
    ? payload
    : (Object.values((payload || {}) as Record<string, unknown>) as Org[])

  const sorted = raw
    .filter((org): org is Org => !!org && typeof org.name === "string")
    .sort(
      (a, b) =>
        a.name.toLowerCase().charCodeAt(0) -
        b.name.toLowerCase().charCodeAt(0)
    )

  return [allVtubersOrg, ...sorted]
}

export function makeLiveCacheKey(orgTargets: string[]) {
  const targets = (orgTargets || []).filter(Boolean)
  return JSON.stringify(targets.length ? [...targets].sort() : ["All Vtubers"])
}
