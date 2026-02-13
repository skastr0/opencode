# LLM.stream() Native Path Routing

id: claude-v2-llm-routing

## Context

Add routing logic to `LLM.stream()` that directs Claude Agent SDK models to the new native path while keeping all other providers on the existing Vercel AI SDK path. This enables both systems to coexist.

## Acceptance Criteria

- [x] AC-1: Detect when model uses `claude-agent-sdk` provider
- [x] AC-2: Route claude-agent-sdk models to native `streamClaudeNative()` 
- [x] AC-3: Keep all other providers on existing `streamText()` path
- [x] AC-4: Pass OpenCode session ID properly to native path
- [x] AC-5: Ensure tools from ToolRegistry are available to native path
- [x] AC-6: Return stream compatible with existing SessionProcessor consumption

## Technical Notes

**Routing in llm.ts**:
```typescript
export async function stream(input: StreamInput) {
  // Native path for claude-agent-sdk (no feature flag - just the default)
  if (input.model.providerID === 'claude-agent-sdk') {
    return streamClaudeNative({
      sessionID: input.sessionID,
      model: input.model,
      prompt: buildPrompt(input),  // Convert to simple string/structured
      tools: input.tools,
      abort: input.abort,
      // ... other context
    })
  }
  
  // Existing AI SDK path for all other providers
  return streamText({ ... })
}
```

**No feature flags** - the native path is simply the implementation for claude-agent-sdk provider.
**Assume Claude Code authenticated** - user has claude CLI installed and authenticated.
```

**Key considerations**:
- Native path needs same `StreamOutput` shape as `streamText` returns
- System prompt assembly still happens in llm.ts
- Tool resolution still uses existing `resolveTools()`
- Messages/history handling differs (V2 uses session state, not full history replay)

**Files to modify**:
- `packages/opencode/src/session/llm.ts` - add routing logic

## Time Estimate

predicted_hours: 1
actual_hours: TBD

## Dependencies

- claude-v2-native-stream (must exist first)

## Notes

2026-01-25: The native path return type must be compatible with `StreamTextResult<ToolSet, unknown>` or we need to create a common interface. Ideally the native stream returns something that SessionProcessor can consume identically.
2026-01-25: Added claude-agent-sdk routing in `packages/opencode/src/session/llm.ts`, including session ID resume tracking and prompt assembly for native streaming.
