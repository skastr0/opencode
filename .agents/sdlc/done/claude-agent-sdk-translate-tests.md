# Add unit tests for Claude Agent SDK translations

## Context
The Claude Agent SDK provider translation utilities need unit test coverage for prompt translation, streaming translation, and session store behavior.

## Acceptance Criteria
- [x] `translateToSDKPrompt` tests cover: simple text returns string, tool results produce async generator, multiple tool results before user message, multimodal image formatting, empty prompt handling.
- [x] `createSDKStreamTransformer` tests cover: system.init emits response metadata + captures session_id, assistant text emits text-start/text-delta/text-end, tool_use emits tool-call with providerExecuted false, thinking emits reasoning-start/delta/end, partial emits text-delta, error emits error, usage cache metrics passthrough, abort signal terminates stream.
- [x] `ClaudeAgentSDKSessionStore` tests cover: set/get session ID, different model invalidates session, touch updates lastUsedAt.
- [x] Tests run via `bun test test/provider/sdk/claude-agent-sdk/translate.test.ts`.

## Notes
2026-01-25: Created from build request.
2026-01-25: Added Claude Agent SDK translation tests and ran bun test. Files changed: packages/opencode/test/provider/sdk/claude-agent-sdk/translate.test.ts
