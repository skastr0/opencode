# Instrument request logging for Opus bad requests

## Context
Option 1 is to instrument request and error logging first so we can diagnose Opus bad request responses without changing provider behavior. The LLM request path in `packages/opencode/src/session/llm.ts` builds options, variants, and thinking configuration; we need a sanitized view of that payload for alignment and debugging.

## Acceptance Criteria
- [x] A DEBUG log entry emitted before `streamText` includes providerID, modelID, sessionID, agent name, variant key, and `maxOutputTokens`.
- [x] Log payload includes thinking summary (effort + budget) and message/tool counts without prompt text, file contents, or auth headers.
- [x] Variant selection is logged without changing merge order; missing variants log as null.
- [x] Logging is gated by DEBUG level so INFO output remains unchanged.

## Technical Notes
- Touch `packages/opencode/src/session/llm.ts` to build a sanitized request log payload near the streamText call.
- Preserve merge order (base options -> model.options -> agent.options -> variant) so upstream variant behavior remains authoritative.
- Redact Authorization, apiKey, and raw message content; log counts, sizes, and option summaries only.

## Notes
2026-01-20: Created from commit plan.
2026-01-20: Added sanitized request debug logging payloads for streamText calls. Files changed: packages/opencode/src/session/llm.ts, packages/opencode/test/session/llm.test.ts.
