export type Org = {
  name: string
  short?: string | null
  name_jp?: string | null
  [key: string]: unknown
}

export type HolodexChannel = {
  id?: string
  name?: string
  english_name?: string
  org?: string
  group?: string
  suborg?: string
  photo?: string
  twitch?: string
}

export type HolodexVideo = {
  id: string
  title?: string
  jp_name?: string
  type?: string
  status?: "live" | "upcoming" | "past" | "missing" | string
  topic_id?: string
  available_at?: string
  start_actual?: string
  start_scheduled?: string
  duration?: number
  thumbnail?: string
  live_viewers?: number
  ccv?: number
  channel_id?: string
  channel?: HolodexChannel
  mentions?: HolodexChannel[]
  clips?: unknown[] | number
  link?: string
  placeholderType?: string
  certainty?: string
  [key: string]: unknown
}
