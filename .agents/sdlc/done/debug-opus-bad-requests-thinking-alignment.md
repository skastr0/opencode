# Align agent.thinking mapping with provider variants and default budgets

## Context
The alignment plan requires that agent.thinking mapping across providers uses safe default budgets while respecting upstream variant behavior. We need to verify defaults from `ThinkingEffort`, preserve existing variant overrides, and log effective thinking configuration without altering request semantics.

## Acceptance Criteria
- [x] agent.thinking defaults use `ThinkingEffort` budgets when budgetTokens is unset.
- [x] Variant options remain authoritative and `ProviderTransform.variants` behavior is unchanged.
- [x] Unit checks or assertions validate default budgets and merge order for thinking options.

## Technical Notes
- Review `packages/opencode/src/session/llm.ts` and `buildThinkingOptions` for provider-specific mapping.
- Keep merge order intact so variants override base thinking options.
- If default budgets change, update `packages/opencode/src/session/thinking-effort.ts` and related tests.

## Notes
2026-01-20: Created from commit plan.
2026-01-21: Implemented ThinkingEffort resolve defaults and mergeOptions helper; added tests for defaults and variant merge order. Files changed: packages/opencode/src/session/thinking-effort.ts, packages/opencode/src/session/llm.ts, packages/opencode/test/session/thinking-effort.test.ts, packages/opencode/test/session/llm.test.ts
