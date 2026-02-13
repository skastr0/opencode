# Native Path Session Management

id: claude-v2-session-management

## Context

Implement proper session ID tracking for the native V2 path. The V2 SDK includes `session_id` in every message, making this much simpler than V1. We need to:
1. Capture and store SDK session IDs mapped to OpenCode session IDs
2. Use stored IDs to resume sessions on subsequent messages
3. Ensure Task tool subagents get proper session tracking

## Acceptance Criteria

- [x] AC-1: Capture `session_id` from V2 stream messages
- [x] AC-2: Store SDK session ID mapped to OpenCode session ID
- [x] AC-3: Resume sessions using `unstable_v2_resumeSession()` when prior ID exists
- [x] AC-4: Invalidate stored session on model change
- [x] AC-5: Persist session mapping (not just in-memory) for cross-restart continuity
- [x] AC-6: Task tool subagents receive proper session context

## Technical Notes

**V2 session ID access**:
```typescript
for await (const msg of session.stream()) {
  // session_id is on EVERY message in V2!
  const sdkSessionId = msg.session_id
  sessionStore.set(openCodeSessionId, sdkSessionId, modelId)
}
```

**Session resume**:
```typescript
const existingSdkId = sessionStore.get(openCodeSessionId, modelId)
const session = existingSdkId
  ? unstable_v2_resumeSession(existingSdkId, { model })
  : unstable_v2_createSession({ model })
```

**Persistence consideration**:
Current `ClaudeAgentSDKSessionStore` is in-memory only. For cross-restart continuity, consider:
- Storing in OpenCode's session metadata
- Using Storage namespace

**Files to modify**:
- `packages/opencode/src/provider/native/claude-agent-sdk.ts` - session handling
- Potentially `packages/opencode/src/session/index.ts` - store SDK session ID in session metadata

## Time Estimate

predicted_hours: 0.5
actual_hours: TBD

## Dependencies

- claude-v2-native-stream

## Notes

2026-01-25: V2 makes this dramatically simpler. The session_id being on every message means we don't need complex init-message detection. Just grab it from any message and store it.
2026-01-25: Verified native session tracking in LLM and added tests for session resume and model invalidation. In-memory store retained per scope.
Files changed: packages/opencode/test/session/llm-native-session.test.ts
