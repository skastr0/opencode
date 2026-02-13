# WI-03: Test proving error classification of timeout-like errors at mapping boundary

## Context
The error mapping boundary (`MessageV2.fromError` at message-v2.ts:722-850) and retry classification (`SessionRetry.retryable` at retry.ts:62-121) form the decision point for whether a failed provider call gets retried or surfaces as a terminal error to the user.

**Gap identified**: `AbortSignal.timeout()` throws `DOMException` with `name: "TimeoutError"`, but `fromError` only checks for `name: "AbortError"` (L724). A `TimeoutError` will NOT match the `AbortError` branch, and instead falls through to the `APICallError.isInstance` check or the final generic handler.

Additionally, `ECONNRESET` is explicitly handled (L741-753) but related post-sleep errors like `ETIMEDOUT`, `ECONNREFUSED`, `EPIPE` are NOT explicitly handled — they fall through to generic error handling.

Parent: `investigate-provider-timeout-sleep-wake.md`

## Acceptance Criteria
- [ ] Test file at `packages/opencode/test/provider/error-mapping-timeout.test.ts`
- [ ] Test: `DOMException("timeout", "TimeoutError")` through `fromError` — verify it does NOT hit the AbortError branch, document what it actually produces
- [ ] Test: `DOMException("aborted", "AbortError")` through `fromError` — verify it hits AbortError branch (control case)
- [ ] Test: System error with code `ETIMEDOUT` through `fromError` — document how it's classified (likely misses the ECONNRESET-specific branch)
- [ ] Test: System error with code `EPIPE` through `fromError` — document classification
- [ ] Test: Each resulting error object through `SessionRetry.retryable()` — verify whether retry is triggered
- [ ] All tests pass with `bun test test/provider/error-mapping-timeout.test.ts`

## Technical Notes

**Files to change**: `packages/opencode/test/provider/error-mapping-timeout.test.ts` (new file)

**Approach**: Direct unit tests of `MessageV2.fromError` and `SessionRetry.retryable` with crafted error objects.

**Key gap to prove**:
```typescript
// fromError L724 — only catches AbortError
case e instanceof DOMException && e.name === "AbortError":
  // TimeoutError will NOT match this!

// fromError L741 — only catches ECONNRESET  
case (e as SystemError)?.code === "ECONNRESET":
  // ETIMEDOUT, EPIPE, ECONNREFUSED will NOT match this!
```

**Error types to test**:
| Error | Expected fromError result | Expected retryable? |
|-------|---------------------------|---------------------|
| `DOMException("timeout", "TimeoutError")` | Falls to generic | Unknown — need to verify |
| `DOMException("aborted", "AbortError")` | `AbortedError` | No (correct) |
| `SystemError { code: "ECONNRESET" }` | `APIError(retryable=true)` | Yes (correct) |
| `SystemError { code: "ETIMEDOUT" }` | Falls to generic | Unknown — need to verify |
| `SystemError { code: "EPIPE" }` | Falls to generic | Unknown — need to verify |

## Dependencies
- WI-01 (baseline understanding)
- WI-02 (confirms what errors AbortSignal.timeout actually produces)

## Estimated Effort
~30 minutes

## Notes
2026-02-09: Created from commit plan. This test maps the exact gaps in error handling that cause poor UX after sleep/wake.
