import type { NextRequest } from "next/server"

import {
  holodexSpoofHeaders,
  holodexTarget,
  upstreamResponse,
} from "@/lib/holodex-proxy"

export const runtime = "nodejs"

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const { path } = await context.params
  const target = holodexTarget("statics", path, new URL(request.url).search)
  return upstreamResponse(
    await fetch(target, { headers: holodexSpoofHeaders() })
  )
}
