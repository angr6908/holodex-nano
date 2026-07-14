export const HOLODEX_BASE_URL = "https://holodex.net"

export function holodexTarget(prefix: string, path: string[], search: string) {
  const target = new URL(
    `${HOLODEX_BASE_URL}/${prefix}/${(path || []).map(encodeURIComponent).join("/")}`
  )
  target.search = search
  return target
}

export function holodexSpoofHeaders(base?: HeadersInit) {
  const headers = new Headers(base)
  headers.set("origin", HOLODEX_BASE_URL)
  headers.set("referer", `${HOLODEX_BASE_URL}/`)
  return headers
}

export function upstreamResponse(upstream: Response) {
  const headers = new Headers(upstream.headers)
  headers.delete("content-encoding")
  headers.delete("content-length")
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}
