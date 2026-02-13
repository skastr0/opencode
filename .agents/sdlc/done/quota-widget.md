# Sidebar Quota Widget Component

id: quota-widget
parent: provider-quota-widget

## Context

This work item adds the quota display widget to the TUI sidebar. It consumes data from the ProviderQuota service and displays usage information in the existing sidebar layout.

The sidebar already displays session-level metrics (tokens, context %, cost). This widget adds account-level quota visibility so users know their remaining API capacity.

## Acceptance Criteria

- [x] Create `QuotaWidget` component that displays:
  - Usage percentage (e.g., "Claude: 55% remaining")
  - Reset time (e.g., "resets 2h 15m")
  - Weekly cost when available (e.g., "Weekly: $12.40 / $50.00")
- [x] Integrate widget into sidebar.tsx after the Context section
- [x] Widget uses existing theme system (`useTheme()`) for consistent styling:
  - `theme.text` for labels
  - `theme.textMuted` for values
  - `theme.success` for healthy quota (>50%)
  - `theme.warning` for low quota (20-50%)
  - `theme.error` for critical quota (<20%)
- [x] Widget reactively updates when:
  - Active provider changes (`sync.data.provider`)
  - User sends a message (potential quota change)
- [x] Display "Quota: ..." during loading state
- [x] Display "Quota: --" when API unavailable or provider unsupported

## Technical Notes

### File Location
Edit `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`

### Sidebar Structure Reference
The sidebar has sections in this order (from reading sidebar.tsx):
1. Session title
2. Context (tokens, % used, cost)
3. **Quota** (NEW - added here)
4. Thinking (if agent has thinking config)
5. MCP servers
6. LSP servers
7. Todo items
8. Modified files

### Component Pattern
Follow existing sidebar section pattern:
```tsx
<Show when={quotaData()}>
  <box>
    <text fg={theme.text}>
      <b>Quota</b>
    </text>
    <text fg={theme.textMuted}>
      {providerName}: {remaining}% remaining
    </text>
    <Show when={resetsAt}>
      <text fg={theme.textMuted}>resets {timeUntilReset}</text>
    </Show>
  </box>
</Show>
```

### Reactive State
Use SolidJS patterns already in sidebar:
```typescript
const quota = createMemo(() => {
  const provider = sync.data.provider.find(x => x.id === activeProviderID)
  // Fetch quota for active provider
})
```

### Time Formatting
Use relative time for reset (e.g., "2h 15m"). Consider using `Locale` utilities from `@/util/locale` if available.

## Estimated Effort

2 hours

## Dependencies

- quota-service (must exist to fetch data)

## Notes

2026-02-01: Created as part of provider-quota-widget feature. Keep the UI minimal and consistent with existing sidebar sections.

2026-02-01: Implementation complete. Added QuotaWidget component to sidebar.tsx with:
- Reactive quota state using createSignal/createEffect with SolidJS `on()` for tracking
- activeProvider memo derived from last assistant message's providerID
- Health-based color coding: success (>50%), warning (20-50%), error (<20%)
- Relative time formatting for reset countdown
- Support for both quota-based (Anthropic) and pay-as-you-go (OpenRouter) providers
- Loading state shows "..." and unavailable state shows "--"
- Files changed: packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx

## Review Notes

2026-02-01: Code quality review PASSED. Simplicity review WARN (IIFE in JSX could be extracted). However, found issue in quota-cache integration - see quota-cache.md for fix required.
