import { Log } from "@/log"
import { Auth } from "../auth"

export type QuotaInfo = {
  type: "quota-based" | "pay-as-you-go"
  remaining?: number
  resetsAt?: Date
  weeklyUsed?: number
  weeklyLimit?: number
  totalCredits?: number
}

const log = Log.create({ service: "provider-quota" })
const cache = new Map<string, { data: QuotaInfo; fetchedAt: number }>()
const TTL = 60_000

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null) return false
  if (Array.isArray(value)) return false
  return typeof value === "object"
}

const stringFrom = (value: unknown) => (typeof value === "string" ? value : undefined)

const numberFrom = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const dateFrom = (value: unknown) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === "number") {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date
  }
  if (typeof value === "string") {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date
  }
  return undefined
}

const percentFrom = (value: unknown) => {
  const num = numberFrom(value)
  if (num === undefined) return undefined
  const scaled = num <= 1 ? num * 100 : num
  return Math.min(100, Math.max(0, scaled))
}

const dataFrom = (value: unknown) => {
  if (!isRecord(value)) return undefined
  if (isRecord(value.data)) return value.data
  return value
}

const valueFrom = (value: Record<string, unknown> | undefined, keys: string[]) => {
  if (!value) return undefined
  for (const key of keys) {
    const found = value[key]
    if (found !== undefined) return found
  }
  return undefined
}

const responseFrom = async (providerID: string, url: string, init?: RequestInit) => {
  log.info("fetch start", { providerID, url })
  const res = await fetch(url, init).catch(() => null)
  if (!res) {
    log.warn("fetch failed", { providerID, reason: "network" })
    return { res: null, rate: false }
  }
  if (res.status === 401 || res.status === 403) {
    log.warn("reauth needed", { providerID, status: res.status })
    return { res: null, rate: false }
  }
  if (res.status === 429) {
    log.warn("rate limited", { providerID, status: res.status })
    return { res: null, rate: true }
  }
  if (!res.ok) {
    log.warn("fetch failed", { providerID, status: res.status })
    return { res: null, rate: false }
  }
  return { res, rate: false }
}

const usageList = (value: Record<string, unknown> | undefined) => {
  const raw = valueFrom(value, ["usage", "usage_buckets", "usageBuckets", "buckets"])
  if (Array.isArray(raw)) return raw
  if (isRecord(raw) && Array.isArray(raw.data)) return raw.data
  return []
}

const isFiveHour = (value: unknown) => {
  if (!isRecord(value)) return false
  const type = stringFrom(valueFrom(value, ["type", "period", "window"]))
  if (!type) return false
  return type.includes("5") && type.includes("h")
}

const anthropicInfo = async (): Promise<QuotaInfo | null> => {
  const auth = await Auth.get("anthropic")
  if (!auth || auth.type !== "oauth") return null

  const fallback = cache.get("anthropic")?.data ?? null

  const result = await responseFrom("anthropic", "https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${auth.access}`,
    },
  })
  if (!result.res) {
    if (result.rate) return fallback
    return null
  }

  const body = await result.res.json().catch(() => null)
  if (!body) {
    log.warn("fetch failed", { providerID: "anthropic", reason: "parse" })
    return null
  }
  const root = dataFrom(body)
  const quota = isRecord(root) ? root.quota : undefined
  const bucket = isRecord(quota)
    ? quota
    : (() => {
        const list = usageList(isRecord(root) ? root : undefined)
        const pick = list.find(isFiveHour) ?? list[0]
        return isRecord(pick) ? pick : undefined
      })()

  const resetValue =
    valueFrom(bucket, ["reset_time", "resetTime", "resets_at", "resetAt"]) ??
    valueFrom(isRecord(root) ? root : undefined, ["reset_time", "resetTime", "resets_at", "resetAt"])
  const resetsAt = dateFrom(resetValue)

  const remainingValue = valueFrom(bucket, [
    "percentage_remaining",
    "percentageRemaining",
    "remaining_percentage",
    "remaining",
  ])
  const usedValue = valueFrom(bucket, ["percentage_used", "percentageUsed", "used_percentage", "usage"])
  const remaining = (() => {
    const direct = percentFrom(remainingValue)
    if (direct !== undefined) return direct
    const used = percentFrom(usedValue)
    if (used === undefined) return undefined
    return Math.min(100, Math.max(0, 100 - used))
  })()

  if (remaining === undefined && !resetsAt) return null

  return {
    type: "quota-based",
    remaining,
    resetsAt,
  }
}

const openrouterInfo = async (): Promise<QuotaInfo | null> => {
  const auth = await Auth.get("openrouter")
  if (!auth || auth.type !== "api") return null

  const fallback = cache.get("openrouter")?.data ?? null

  const headers = { Authorization: `Bearer ${auth.key}` }
  const creditsRes = await responseFrom("openrouter", "https://openrouter.ai/api/v1/credits", {
    headers,
  })
  if (!creditsRes.res) {
    if (creditsRes.rate) return fallback
    return null
  }

  const creditsBody = await creditsRes.res.json().catch(() => null)
  if (!creditsBody) {
    log.warn("fetch failed", { providerID: "openrouter", reason: "parse" })
    return null
  }
  const credits = dataFrom(creditsBody)
  const total = numberFrom(valueFrom(credits, ["total_credits", "totalCredits"]))
  const used = numberFrom(valueFrom(credits, ["total_usage", "totalUsage"]))
  const totalCredits = (() => {
    if (total === undefined) return undefined
    if (used === undefined) return Math.max(0, total)
    return Math.max(0, total - used)
  })()

  const keyRes = await responseFrom("openrouter", "https://openrouter.ai/api/v1/key", { headers })
  if (!keyRes.res) {
    if (keyRes.rate) return fallback
    return null
  }

  const keyBody = await keyRes.res.json().catch(() => null)
  if (!keyBody) {
    log.warn("fetch failed", { providerID: "openrouter", reason: "parse" })
    return null
  }
  const key = dataFrom(keyBody)
  const weeklyUsed = numberFrom(valueFrom(key, ["usage_weekly", "usageWeekly"]))
  const limit = numberFrom(valueFrom(key, ["limit", "limit_usd", "limitUsd"]))
  const reset = stringFrom(valueFrom(key, ["limit_reset", "limitReset"]))
  const weeklyLimit = reset && reset.includes("week") ? limit : undefined

  const hasData = [weeklyUsed, weeklyLimit, totalCredits].some((value) => typeof value === "number")
  if (!hasData) return null

  return {
    type: "pay-as-you-go",
    weeklyUsed,
    weeklyLimit,
    totalCredits,
  }
}

const copilotInfo = async (): Promise<QuotaInfo | null> => {
  const auth = await Auth.get("github-copilot")
  if (!auth || auth.type !== "oauth") return null

  const fallback = cache.get("github-copilot")?.data ?? null

  const result = await responseFrom("github-copilot", "https://api.github.com/copilot/usage", {
    headers: {
      Authorization: `Bearer ${auth.access}`,
      Accept: "application/vnd.github+json",
    },
  })
  if (!result.res) {
    if (result.rate) return fallback
    return null
  }

  const body = await result.res.json().catch(() => null)
  if (!body) {
    log.warn("fetch failed", { providerID: "github-copilot", reason: "parse" })
    return null
  }

  const root = dataFrom(body)
  if (!isRecord(root)) return null

  const remaining = percentFrom(valueFrom(root, ["percentage_remaining", "percentageRemaining", "remaining_percentage"]))
  const resetsAt = dateFrom(valueFrom(root, ["reset_time", "resetTime", "resets_at", "resetAt"]))

  if (remaining === undefined && !resetsAt) return null

  return {
    type: "quota-based",
    remaining,
    resetsAt,
  }
}

export namespace ProviderQuota {
  export async function fetch(providerID: string): Promise<QuotaInfo | null> {
    if (providerID === "anthropic") return anthropicInfo()
    if (providerID === "openrouter") return openrouterInfo()
    if (providerID === "github-copilot" || providerID === "github-copilot-enterprise") return copilotInfo()
    // opencode requires browser cookie auth, not API key - quota not available via CLI
    if (providerID === "opencode") return null
    return null
  }

  export async function fetchCached(providerID: string): Promise<QuotaInfo | null> {
    const entry = cache.get(providerID)
    const now = Date.now()

    if (entry && now - entry.fetchedAt < TTL) {
      log.info("cache hit", { providerID })
      return entry.data
    }

    log.info("cache miss, fetching", { providerID })
    const data = await ProviderQuota.fetch(providerID)
    if (!data) return null
    if (entry && data === entry.data) return data

    cache.set(providerID, { data, fetchedAt: now })
    return data
  }
}
