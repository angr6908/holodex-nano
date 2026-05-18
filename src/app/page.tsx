import { cookies } from "next/headers"
import { HomeClient } from "@/components/home-client"
import type { TabValue } from "@/components/home-client"

export default async function Home() {
  const cookieStore = await cookies()
  const stored = cookieStore.get("holodex-nano-tab")?.value
  const initialTab: TabValue =
    stored === "archive" || stored === "clips" ? stored : "live"
  return <HomeClient initialTab={initialTab} />
}
