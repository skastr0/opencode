# WI-02: Test simulating stale AbortSignal after sleep/wake

## Context
After macOS sleep/wake, in-flight TCP connections may silently die. The `AbortSignal` from the session loop (`input.abort`) only fires on explicit user cancel — it does NOT detect network-level connection death.

The retry loop in `processor.ts:369-394` catches errors, runs them through `MessageV2.fromError()`, then checks `SessionRetry.retryable()`. But if the connection hangs indefinitely (no error thrown, no data received), the code never enters the catch block.

**Hypothesis to test**: A fetch that hangs forever (simulating dead-after-sleep TCP) with `timeout: false` and no `AbortSignal.timeout` will cause the entire session to freeze — no error, no retry, no user feedback.

Parent: `investigate-provider-timeout-sleep-wake.md`

## Acceptance Criteria
- [ ] Test file at `packages/opencode/test/provider/sleep-wake-timeout.test.ts`
- [ ] Test case: A fetch with `timeout: false` and no AbortSignal.timeout that returns a never-resolving promise causes an observable hang (test uses its own timeout to detect)
- [ ] Test case: A fetch with `AbortSignal.timeout(5000)` that hangs eventually throws `TimeoutError` which is classifiable by `MessageV2.fromError`
- [ ] Test case: The `TimeoutError` from `AbortSignal.timeout` is correctly classified as retryable by `SessionRetry.retryable()` (verify via the `isRetryableByMessage` path in `errors.ts:191-210`)
- [ ] All tests pass with `bun test test/provider/sleep-wake-timeout.test.ts`

## Technical Notes

**Files to change**: `packages/opencode/test/provider/sleep-wake-timeout.test.ts` (new file)

**Approach**: 
1. Create a mock fetch that returns `new Promise(() => {})` (never resolves) to simulate dead TCP
2. Wrap with the same logic from `provider.ts:1044-1082`
3. Race against a short timeout to prove the hang
4. Then add `AbortSignal.timeout(100)` and verify it throws
5. Pass the thrown error through `MessageV2.fromError` and `SessionRetry.retryable`

**Key insight**: The `DOMException` with name `"TimeoutError"` from `AbortSignal.timeout` hits `fromError`'s `AbortError` branch (L724) — but `TimeoutError !== AbortError`. Need to verify this is handled correctly.

**Error classification chain**:
```
AbortSignal.timeout throws → DOMException(name: "TimeoutError")
  → fromError: NOT caught by AbortError branch (different name)
  → falls through to generic error handling
  → message likely contains "timeout" → isRetryableByMessage returns true
  → but the error TYPE matters for SessionRetry.retryable()
```

## Dependencies
- WI-01 (confirms the 3 timeout paths exist as expected)

## Estimated Effort
~45 minutes

## Notes
2026-02-09: Created from commit plan. This is the core reproduction test that proves the sleep/wake hang.
