# Quota Caching and Error Handling

id: quota-cache
parent: provider-quota-widget

## Context

This work item adds the resilience layer for quota fetching: caching with TTL to avoid API spam, and graceful error handling to prevent disrupting the TUI when quota APIs fail.

Without caching, every sidebar render could trigger API calls. Without error handling, a flaky quota API could break the entire sidebar.

## Acceptance Criteria

- [x] Implement in-memory cache in ProviderQuota service:
  - Structure: `Map<providerID, { data: QuotaInfo, fetchedAt: number }>`
  - Default TTL: 60 seconds (configurable)
  - `fetchCached(providerID)` returns cached data if within TTL, else fetches fresh
- [x] Cache is invalidated when:
  - TTL expires (lazy invalidation on next fetch)
  - User explicitly requests refresh (future: not in scope for MVP)
- [x] Error handling for fetch failures:
  - Network errors: return `null`, log warning
  - Auth errors (401/403): return `null`, log that re-auth may be needed
  - Rate limit errors (429): return cached data if available, else `null`
  - Never throw - always return `null` on failure
- [x] Add debug logging via existing `Log.create({ service: "provider-quota" })` pattern
- [x] Widget shows graceful fallback ("--") when service returns `null`

## Technical Notes

### Cache Implementation
```typescript
const cache = new Map<string, { data: QuotaInfo; fetchedAt: number }>()
const TTL = 60_000 // 60 seconds

export async function fetchCached(providerID: string): Promise<QuotaInfo | null> {
  const cached = cache.get(providerID)
  const now = Date.now()

  if (cached && now - cached.fetchedAt < TTL) {
    return cached.data
  }

  const fresh = await fetch(providerID)
  if (fresh) {
    cache.set(providerID, { data: fresh, fetchedAt: now })
  }
  return fresh
}
```

### Logging Pattern
Follow existing pattern from provider.ts:
```typescript
const log = Log.create({ service: "provider-quota" })
log.info("fetching quota", { providerID })
log.warn("quota fetch failed", { providerID, error: e.message })
```

### Error Recovery
Do NOT use try/catch blocks around the main logic. Instead:
1. Check response.ok before parsing
2. Use `.catch(() => null)` for fetch calls
3. Return null early on any failure

### Style Guidelines
- Avoid `let` - use `const` with early returns
- Single function per concern
- No explicit types where inference works

## Estimated Effort

2 hours

## Dependencies

- quota-service (extends the service with caching layer)

## Notes

2026-02-01: Created as part of provider-quota-widget feature. Caching is critical to avoid hammering provider APIs on every render cycle. The 60s TTL balances freshness with API politeness.
2026-02-01: Added cache TTL with fetchCached, resilient quota fetching, and cache tests. Files changed: packages/opencode/src/provider/quota.ts, packages/opencode/src/provider/quota.test.ts, packages/opencode/src/log.ts. Manual refresh remains out of scope.

## Blockers

- 2026-02-01: `bun run lint` fails due to unrelated test failures in `test/normalization.test.ts`, `test/session/llm.test.ts`, and `test/session/prompt-variant.test.ts`.

## Review Notes

2026-02-01: **BLOCKING ISSUE FOUND** - The `fetchCached()` function is implemented correctly in quota.ts, but the sidebar widget (sidebar.tsx:97) calls `ProviderQuota.fetch()` instead of `ProviderQuota.fetchCached()`. This means the cache is never used, defeating the purpose of this work item.

**Fix required:** Change line 97 in sidebar.tsx from:
```typescript
const info = await ProviderQuota.fetch(provider)
```
to:
```typescript
const info = await ProviderQuota.fetchCached(provider)
```
