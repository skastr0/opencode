# Investigate provider timeout failures after sleep/wake

id: investigate-provider-timeout-sleep-wake

## Context
Intermittent `UnknownError` failures and request timeouts appear after macOS sleep/wake. Prior investigation confirmed timeout metadata persisted in OpenCode storage and narrowed likely origin to provider timeout and abort handling in `packages/opencode/src/provider/provider.ts`, especially around `AbortSignal.timeout` wrapping and signal propagation.

Selected approach from explore phase:
- **Primary**: Config A/B isolation to reproduce sleep/wake timeout behavior (`timeout=false` vs explicit timeout)
- **Secondary**: Minimal diagnostics at provider wrapper and error mapping boundaries if reproduction confirms timeout path ambiguity

## Acceptance Criteria
- [ ] AC-1: Trace the end-to-end request lifecycle from prompt dispatch to provider fetch cancellation and stream teardown, with concrete file and line references.
- [ ] AC-2: Compare timeout behavior before and after commits `b24f4e3d2`, `ae62bc8b1`, and `6d3fc6365` to identify the most likely regression mechanism.
- [ ] AC-3: Deliver a root-cause assessment with confidence level, plus at least one minimal-risk fix path and a validation plan.

## Work Items (Execution Order)
1. `wi-01-timeout-path-test.md` — Unit test proving the 3 timeout config paths
2. `wi-02-abort-signal-sleep-simulation.md` — Test simulating stale AbortSignal after sleep
3. `wi-03-error-mapping-gap-test.md` — Test proving error classification of timeout-like errors
4. `wi-04-fix-proposal.md` — Document fix proposal based on test findings

## Time Estimate
predicted_hours: 3
actual_hours: 

## Notes
2026-02-09: Created by orchestrator to continue deep timeout investigation from prior session context.
2026-02-09: Commitment analyst broke into 4 sub-items after deep codebase analysis of provider.ts, processor.ts, retry.ts, message-v2.ts, and errors.ts.
