# WI-01: Unit test proving the 3 timeout config paths in provider fetch wrapper

## Context
`provider.ts:1044-1082` wraps every provider SDK fetch call with a custom fetch function. This function has **three distinct timeout paths** based on `options["timeout"]`:

1. **`timeout` is undefined/null** (default, no user config): The `if` block at L1049 is skipped entirely. No `AbortSignal.timeout` is added. The only timeout is Bun's `timeout: false` at L1080, meaning **no timeout at all**.
2. **`timeout` is a number** (e.g. `60000`): `AbortSignal.timeout(N)` is combined with any existing signal.
3. **`timeout` is `false`** (explicit disable): The `if` block enters but the inner `if` at L1052 skips adding `AbortSignal.timeout`. Existing signals are still combined.

**The critical finding**: Path 1 (default) and Path 3 (`timeout: false`) have identical runtime behavior — no abort timeout — but Path 1 is the default for all users who don't configure timeout. This means after sleep/wake, a stale TCP connection will hang indefinitely with no abort mechanism.

Parent: `investigate-provider-timeout-sleep-wake.md`

## Acceptance Criteria
- [x] Test file at `packages/opencode/test/provider/timeout-paths.test.ts`
- [x] Test case 1: When no timeout configured, fetch is called with NO AbortSignal.timeout (only `timeout: false`)
- [x] Test case 2: When timeout is a number (e.g. 60000), fetch is called with AbortSignal.timeout(60000) combined with any existing signal
- [x] Test case 3: When timeout is `false`, fetch is called WITHOUT AbortSignal.timeout but existing signals are preserved
- [x] All 3 tests pass with `bun test test/provider/timeout-paths.test.ts`

## Technical Notes

**Files to change**: `packages/opencode/test/provider/timeout-paths.test.ts` (new file)

**Approach**: Extract and test the fetch-wrapping logic from `provider.ts:1044-1082`. The test should intercept the actual `fetch` call arguments to inspect:
- Whether `opts.signal` includes an `AbortSignal.timeout`
- Whether `timeout: false` is set on the Bun fetch options

**Pattern to follow**: See existing tests in `test/provider/provider.test.ts` (lines 280-310, 1011-1043, 1724-1759) which use `tmpdir` + `Instance.provide` + config JSON for provider options testing.

**Key code reference**:
```
provider.ts L1049: if (options["timeout"] !== undefined && options["timeout"] !== null)
provider.ts L1052:   if (options["timeout"] !== false) signals.push(AbortSignal.timeout(options["timeout"]))
provider.ts L1080:   timeout: false  // Bun-specific, disables Bun's built-in fetch timeout
```

## Dependencies
None — this is the first work item.

## Estimated Effort
~45 minutes

## Notes
2026-02-09: Created from commit plan. This test documents current behavior (not fixing it).
2026-02-09: Implemented timeout path baseline tests in `packages/opencode/test/provider/timeout-paths.test.ts` using a local `file://` harness provider to capture the wrapped fetch function and assert signal behavior for undefined timeout, numeric timeout, and `timeout: false`.
2026-02-09: Validation run: `bun test test/provider/timeout-paths.test.ts` (pass, 3 tests) and `bun run typecheck` (pass).
2026-02-09: Files changed: `packages/opencode/test/provider/timeout-paths.test.ts`.
