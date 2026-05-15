import type { NextRequest } from "next/server"

export const runtime = "nodejs"

const API_BASE_URL = "https://holodex.net"

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const { path } = await context.params
  const target = new URL(
    `${API_BASE_URL}/api/${(path || []).map(encodeURIComponent).join("/")}`
  )
  target.search = new URL(request.url).search

  const headers = new Headers(request.headers)
  headers.set("origin", API_BASE_URL)
  headers.set("referer", `${API_BASE_URL}/`)
  headers.delete("host")

  if (process.env.HOLODEX_API_KEY && !headers.has("x-apikey")) {
    headers.set("x-apikey", process.env.HOLODEX_API_KEY)
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = await request.arrayBuffer()
  }

  const upstream = await fetch(target, init)
  const outHeaders = new Headers(upstream.headers)
  outHeaders.delete("content-encoding")
  outHeaders.delete("content-length")

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  })
}

export const GET = proxy
export const POST = proxy
export const PUT = proxy
export const PATCH = proxy
export const DELETE = proxy
export const HEAD = proxy
export const OPTIONS = proxy
