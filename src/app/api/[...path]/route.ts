import type { NextRequest } from "next/server"

import {
  holodexSpoofHeaders,
  holodexTarget,
  upstreamResponse,
} from "@/lib/holodex-proxy"


async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const { path } = await context.params
  const target = holodexTarget("api", path, new URL(request.url).search)

  const headers = holodexSpoofHeaders(request.headers)
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

  return upstreamResponse(await fetch(target, init))
}

export const GET = proxy
export const POST = proxy
export const PUT = proxy
export const PATCH = proxy
export const DELETE = proxy
export const HEAD = proxy
export const OPTIONS = proxy
