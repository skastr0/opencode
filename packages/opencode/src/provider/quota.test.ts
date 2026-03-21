import { test, expect, afterEach } from "bun:test"
import { ProviderQuota } from "./quota"
import type { QuotaInfo } from "./quota"

const quota = ProviderQuota as { fetch: (providerID: string) => Promise<QuotaInfo | null> }
const fetcher = quota.fetch
const clock = Date.now

afterEach(() => {
  quota.fetch = fetcher
  Date.now = clock
})

test("quota module exports ProviderQuota and QuotaInfo", () => {
  const info: QuotaInfo = {
    type: "quota-based",
    remaining: 50,
  }

  expect(info.type).toBe("quota-based")
  expect(typeof ProviderQuota.fetch).toBe("function")
})

test("fetch returns null for unsupported provider", async () => {
  const result = await ProviderQuota.fetch("unsupported")
  expect(result).toBeNull()
})

test("fetchCached caches within TTL", async () => {
  const count = { value: 0 }
  const first: QuotaInfo = {
    type: "quota-based",
    remaining: 40,
  }
  const second: QuotaInfo = {
    type: "quota-based",
    remaining: 20,
  }

  quota.fetch = async () => {
    count.value += 1
    return count.value === 1 ? first : second
  }
  Date.now = () => 0

  const once = await ProviderQuota.fetchCached("cache-hit")
  const twice = await ProviderQuota.fetchCached("cache-hit")

  expect(once).toBe(first)
  expect(twice).toBe(first)
  expect(count.value).toBe(1)
})

test("fetchCached refetches after TTL", async () => {
  const count = { value: 0 }
  const first: QuotaInfo = {
    type: "quota-based",
    remaining: 60,
  }
  const second: QuotaInfo = {
    type: "quota-based",
    remaining: 10,
  }
  const now = { value: 0 }

  quota.fetch = async () => {
    count.value += 1
    return count.value === 1 ? first : second
  }
  Date.now = () => now.value

  const once = await ProviderQuota.fetchCached("cache-expire")
  now.value = 60_001
  const twice = await ProviderQuota.fetchCached("cache-expire")

  expect(once).toBe(first)
  expect(twice).toBe(second)
  expect(count.value).toBe(2)
})
