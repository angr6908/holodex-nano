import { TWITCH_GQL_URL, TWITCH_WEB_CLIENT_ID } from "@/lib/twitch"


export async function POST(request: Request) {
  const body = await request.text()
  const upstream = await fetch(TWITCH_GQL_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "client-id": request.headers.get("client-id") || TWITCH_WEB_CLIENT_ID,
      "content-type": "application/json",
      origin: "https://www.twitch.tv",
      referer: "https://www.twitch.tv/",
    },
    body,
  })

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: {
      "content-type":
        upstream.headers.get("content-type") || "application/json",
    },
  })
}
