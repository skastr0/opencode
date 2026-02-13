# Enrich LLM error logging with provider response context

## Context
Opus bad request errors need richer error context to identify which parameters are rejected. Extend logging to capture structured error details while reusing the sanitized request metadata from the request log.

## Acceptance Criteria
- [ ] On stream errors, logs include providerID/modelID/sessionID plus variant and thinking summaries.
- [ ] For APICallError cases, logs include statusCode and response body/headers when available.
- [ ] Error logs reuse sanitized request metadata and never include prompt text, file contents, or secrets.

## Technical Notes
- Extend the `streamText` onError handler in `packages/opencode/src/session/llm.ts` to include APICallError fields if present.
- Reuse the same sanitization helper used for request logging to keep payloads consistent.
- Redact response headers like Authorization or set-cookie values before logging.

## Notes
2026-01-20: Created from commit plan.
