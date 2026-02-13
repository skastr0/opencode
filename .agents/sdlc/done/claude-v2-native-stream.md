# Claude Agent SDK V2 Native Streaming Core

id: claude-v2-native-stream

## Context

Create the core native streaming function using Claude Agent SDK V2's `unstable_v2_createSession`/`unstable_v2_resumeSession` pattern. This bypasses Vercel AI SDK entirely for Claude models while emitting the same event types that OpenCode's SessionProcessor expects.

The V2 SDK dramatically simplifies the integration:
- `send(prompt)` instead of async generator coordination
- `stream()` yields SDKMessages directly
- `resumeSession(id)` for trivial session continuity
- `session_id` included in every message

## Acceptance Criteria

- [x] AC-1: Create `streamClaudeNative()` function that uses V2 SDK's `createSession`/`resumeSession`
- [x] AC-2: Session creation when no prior session exists
- [x] AC-3: Session resumption when OpenCode session has prior SDK session ID
- [x] AC-4: Emit events compatible with OpenCode's stream processing (text, tool-call, reasoning, finish)
- [x] AC-5: Properly close session on completion or abort
- [x] AC-6: Handle errors gracefully with proper event emission

## Technical Notes

**V2 SDK Pattern**:
```typescript
import { unstable_v2_createSession, unstable_v2_resumeSession } from '@anthropic-ai/claude-agent-sdk'

const session = sessionId 
  ? unstable_v2_resumeSession(sessionId, { model })
  : unstable_v2_createSession({ model })

await session.send(prompt)
for await (const msg of session.stream()) {
  // msg.session_id always available
  // msg.type: 'system' | 'partial' | 'assistant' | 'tool_progress' | 'tool_use_summary' | 'error'
}
session.close()
```

**Files to create**:
- `packages/opencode/src/provider/native/claude-agent-sdk.ts` - main streaming function

**Reuse from existing code**:
- `translate-stream.ts` message handling logic (same SDKMessage types)
- `tool-bridge.ts` MCP server creation (unchanged)
- `session-store.ts` concept (but simpler - V2 gives session_id in every message)

**Output event types** (must match what SessionProcessor expects):
- `text-start`, `text-delta`, `text-end`
- `tool-call` with `providerExecuted: true`
- `tool-result` with `providerExecuted: true`
- `reasoning-start`, `reasoning-delta`, `reasoning-end`
- `finish` with usage stats
- `error`

## Time Estimate

predicted_hours: 1.5
actual_hours: TBD

## Dependencies

None - this is the foundation work item.

## Notes

2026-01-25: V2 SDK is marked `unstable_` but the API is much cleaner than V1. The key insight is that we can reuse most of translate-stream.ts logic since SDKMessage types are the same.
2026-01-25: Implemented native stream with V2 session create/resume, tool bridge, and event mapping. Added tests for session creation, resumption, abort, and error handling. Files changed: packages/opencode/src/provider/native/claude-agent-sdk.ts, packages/opencode/test/provider/native/claude-agent-sdk.test.ts.
