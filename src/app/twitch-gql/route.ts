export const runtime = "nodejs"

export async function POST(request: Request) {
  const body = await request.text()
  const upstream = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: {
      accept: "application/json",
      "client-id":
        request.headers.get("client-id") || "kimne78kx3ncx6brgo4mv6wki5h1ko",
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
