# Provider Quota Widget for TUI Sidebar

id: provider-quota-widget

## Context

Users currently have no visibility into their provider-level quota consumption (rate limits, weekly usage caps) within the opencode TUI. The sidebar displays session-level metrics (tokens used, context %, session cost) but not account-level quotas.

External tools like [opencode-bar](https://github.com/kargnas/opencode-bar) solve this by reading `auth.json` and querying provider APIs directly. This work item brings that capability natively into the TUI sidebar.

### Why Now
- Users hit rate limits unexpectedly mid-session
- No way to see "quota remaining" without leaving the TUI
- opencode-bar has proven the APIs and data model work

## Acceptance Criteria

- [ ] AC-1: Display current usage percentage for the active provider (e.g., "Claude: 45% used")
- [ ] AC-2: Display time until quota reset (e.g., "resets in 2h 15m")
- [ ] AC-3: Display weekly cost/usage when available (for pay-as-you-go providers like OpenRouter)
- [ ] AC-4: Widget gracefully degrades when quota API unavailable (shows "—" or hides section)
- [ ] AC-5: Quota data is cached with configurable TTL (default 60s) to avoid API spam
- [ ] AC-6: Widget updates reactively when provider changes or new messages arrive

## Technical Context

### Existing Infrastructure to Leverage

| Component | Location | Purpose |
|-----------|----------|---------|
| Auth tokens | [`packages/opencode/src/auth/index.ts`](file:///Users/guilhermecastro/Projects/opencode-fork/packages/opencode/src/auth/index.ts#L37-L70) | OAuth/API tokens already stored in `~/.local/share/opencode/auth.json` |
| Sidebar UI | [`packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`](file:///Users/guilhermecastro/Projects/opencode-fork/packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx#L60-L108) | Existing context/cost display section to extend |
| Provider state | [`sync.data.provider`](file:///Users/guilhermecastro/Projects/opencode-fork/packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx#L65) | Active provider info already in reactive state |
| Theme system | `useTheme()` | Consistent styling with existing widgets |

### Provider Quota APIs (from opencode-bar research)

| Provider | Endpoint | Auth | Returns |
|----------|----------|------|---------|
| **Anthropic** | `https://api.anthropic.com/api/oauth/usage` | OAuth access token | 5-hour window, 7-day usage, model breakdown, reset times |
| **OpenAI/Codex** | `https://chatgpt.com/backend-api/wham/usage` | OAuth access token + account ID | Rate limit windows with reset times |
| **OpenRouter** | `https://openrouter.ai/api/v1/credits` + `/key` | API key | Credits remaining, daily/weekly/monthly costs |
| **Gemini** | `https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` | Google OAuth | Per-model quota buckets (0.0-1.0 remaining) |

Source: [opencode-bar ProviderManager](https://github.com/kargnas/opencode-bar/blob/main/CopilotMonitor/CopilotMonitor/Services/ProviderManager.swift), [ClaudeProvider](https://github.com/kargnas/opencode-bar/blob/main/CopilotMonitor/CopilotMonitor/Providers/ClaudeProvider.swift), [OpenRouterProvider](https://github.com/kargnas/opencode-bar/blob/main/CopilotMonitor/CopilotMonitor/Providers/OpenRouterProvider.swift)

### Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        TUI Sidebar                          │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Context: 45,231 tokens · 67% used · $0.42 spent      │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Quota                                    ← NEW WIDGET │  │
│  │   Claude: 55% remaining · resets 2h 15m              │  │
│  │   Weekly: $12.40 / $50.00                            │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                   ProviderQuota Service                     │
│  - fetchQuota(providerID): Promise<QuotaInfo>              │
│  - Caches responses with TTL                                │
│  - Handles token refresh via existing Auth module           │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Provider APIs                            │
│  Anthropic │ OpenAI │ OpenRouter │ Gemini │ ...            │
└─────────────────────────────────────────────────────────────┘
```

### Data Model

```typescript
interface QuotaInfo {
  type: "quota-based" | "pay-as-you-go"
  // For quota-based (Claude, Gemini, etc.)
  remaining?: number      // 0-100 percentage
  resetsAt?: Date
  // For pay-as-you-go (OpenRouter)
  weeklyUsed?: number     // USD
  weeklyLimit?: number    // USD (if set)
  totalCredits?: number   // USD remaining
}
```

## Implementation Notes

### Phase 1: Core Service
1. Create `packages/opencode/src/provider/quota.ts` with provider-specific fetchers
2. Use existing `Auth.get(providerID)` to retrieve tokens
3. Implement caching layer with `Map<string, { data: QuotaInfo, fetchedAt: number }>`

### Phase 2: TUI Integration
1. Add `useProviderQuota()` hook that subscribes to active provider changes
2. Extend sidebar.tsx with new `<QuotaWidget>` component after the Context section
3. Use existing theme colors (`theme.text`, `theme.textMuted`, `theme.success`, `theme.warning`)

### Phase 3: Graceful Degradation
1. Show loading state during fetch ("Quota: ...")
2. Show "—" when API fails or provider unsupported
3. Log errors to debug without disrupting UX

## Out of Scope

- Historical usage graphs (future work)
- Multi-account support for same provider
- Notifications/alerts when approaching limits
- Configuring quota limits from TUI

## Time Estimate

predicted_hours: 8

## Dependencies

- None (uses existing auth infrastructure)

## Notes

2026-02-01: Created from research on opencode-bar implementation. The external app proves the API patterns work; this brings it native.
