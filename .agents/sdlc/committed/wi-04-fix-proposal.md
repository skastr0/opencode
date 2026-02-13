# WI-04: Document fix proposal based on test findings

## Context
After WI-01 through WI-03 confirm the timeout path behavior, error mapping gaps, and sleep/wake hang mechanism, this work item produces a concrete, minimal-risk fix proposal.

Parent: `investigate-provider-timeout-sleep-wake.md`

## Acceptance Criteria
- [ ] Document saved at `.agents/messages/TIMESTAMP-commit-fix-proposal.json` 
- [ ] Proposal addresses: (a) default timeout for the no-config path, (b) `TimeoutError` handling in `fromError`, (c) post-sleep error codes (`ETIMEDOUT`, `EPIPE`) in `fromError`
- [ ] Each fix includes: exact file + line, before/after description, risk assessment
- [ ] Proposal includes validation plan (which tests to run, what to verify)
- [ ] Proposal does NOT include code changes (boundary: investigation only)

## Technical Notes

**Likely fix areas based on analysis**:

1. **Default timeout** (`provider.ts:1049`): When `options["timeout"]` is undefined, apply a sensible default (300000ms = 5 minutes, matching the config schema description). This ensures all users get abort-after-timeout protection without explicit config.

2. **TimeoutError handling** (`message-v2.ts:724`): Add a case for `DOMException` with `name === "TimeoutError"` — classify as retryable `APIError` with message indicating timeout.

3. **Post-sleep error codes** (`message-v2.ts:741`): Expand the `ECONNRESET` check to also handle `ETIMEDOUT`, `EPIPE`, `ECONNREFUSED` — all are retryable connection errors.

4. **SSE retry interaction** (`serverSentEvents.gen.ts`): The SDK SSE client has its own retry with exponential backoff. Verify this doesn't conflict with the session-level retry in `processor.ts`.

**Risk assessment format per fix**:
- Blast radius (what else changes)
- Backwards compatibility (does existing `timeout: false` config still work)
- Performance (does adding a default timeout affect long-running requests)

## Dependencies
- WI-01, WI-02, WI-03 (all must be complete with passing tests)

## Estimated Effort
~30 minutes

## Notes
2026-02-09: Created from commit plan. This is the deliverable that feeds back to the orchestrator for build-phase decision.
