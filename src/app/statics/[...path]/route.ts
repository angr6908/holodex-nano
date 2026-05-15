import type { NextRequest } from "next/server"

export const runtime = "nodejs"

const API_BASE_URL = "https://holodex.net"

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const { path } = await context.params
  const target = new URL(
    `${API_BASE_URL}/statics/${(path || []).map(encodeURIComponent).join("/")}`
  )
  target.search = new URL(request.url).search

  const upstream = await fetch(target, {
    headers: {
      origin: API_BASE_URL,
      referer: `${API_BASE_URL}/`,
    },
  })
  const headers = new Headers(upstream.headers)
  headers.delete("content-encoding")
  headers.delete("content-length")

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}
