# Provider Quota Service

id: quota-service
parent: provider-quota-widget

## Context

This work item creates the core service for fetching quota/usage data from provider APIs. It establishes the data fetching layer that the UI will consume, following patterns from [opencode-bar](https://github.com/kargnas/opencode-bar).

The sidebar needs quota data, but first we need a reliable way to fetch and normalize it across different provider APIs (Anthropic, OpenAI, OpenRouter, Gemini).

## Acceptance Criteria

- [x] Create `packages/opencode/src/provider/quota.ts` with `ProviderQuota` namespace
- [x] Define `QuotaInfo` type with fields for both quota-based and pay-as-you-go providers:
  - `type: "quota-based" | "pay-as-you-go"`
  - `remaining?: number` (0-100 percentage for quota-based)
  - `resetsAt?: Date` (when quota resets)
  - `weeklyUsed?: number` (USD for pay-as-you-go)
  - `weeklyLimit?: number` (USD if set)
  - `totalCredits?: number` (USD remaining)
- [x] Implement `ProviderQuota.fetch(providerID: string): Promise<QuotaInfo | null>` that:
  - Retrieves auth tokens via existing `Auth.get(providerID)`
  - Returns `null` for unsupported providers (no error thrown)
- [x] Implement Anthropic fetcher (`api.anthropic.com/api/oauth/usage`):
  - Uses OAuth access token from auth.json
  - Parses 5-hour window usage and reset time
  - Returns percentage remaining and reset time
- [x] Implement OpenRouter fetcher (`openrouter.ai/api/v1/credits` + `/key`):
  - Uses API key from auth.json
  - Returns credits remaining and weekly cost data

## Technical Notes

### File Location
Create at `packages/opencode/src/provider/quota.ts`

### Auth Integration
Use existing `Auth.get(providerID)` pattern from `packages/opencode/src/auth/index.ts`:
```typescript
const auth = await Auth.get("anthropic")
if (auth?.type === "oauth") {
  // Use auth.access for OAuth token
}
if (auth?.type === "api") {
  // Use auth.key for API key
}
```

### Provider API Details (from opencode-bar)

**Anthropic:**
- Endpoint: `https://api.anthropic.com/api/oauth/usage`
- Auth: `Authorization: Bearer {access_token}`
- Response includes usage buckets with remaining percentage

**OpenRouter:**
- Endpoint: `https://openrouter.ai/api/v1/credits`
- Auth: `Authorization: Bearer {api_key}`
- Returns credits balance

### Style Guidelines
- No `let` statements, prefer `const` with conditionals
- Single-word variable names where possible
- Use Bun APIs (`Bun.fetch` is just `fetch`)
- Avoid `try/catch` - let errors propagate or use Result types

## Estimated Effort

3 hours

## Dependencies

None - uses existing Auth infrastructure

## Notes

2026-02-01: Created as part of provider-quota-widget feature. Focus on Anthropic and OpenRouter first as they have well-documented quota APIs from opencode-bar reference.
2026-02-01: Implemented ProviderQuota fetchers for Anthropic/OpenRouter with QuotaInfo normalization and added tests. Files changed: packages/opencode/src/provider/quota.ts, packages/opencode/src/provider/quota.test.ts
