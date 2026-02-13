# Native Path Tool Execution Integration

id: claude-v2-tool-execution

## Context

Integrate OpenCode's tool execution with the native Claude V2 path. When Claude requests a tool via `tool_use`, OpenCode executes it locally and sends results back via `session.send()` with tool_result format.

The key difference from the AI SDK path: we control the entire tool execution flow without Vercel's validation/repair logic interfering.

## Acceptance Criteria

- [x] AC-1: Detect `tool_use` blocks in assistant messages from V2 stream
- [x] AC-2: Execute tools via OpenCode's ToolRegistry (not SDK's MCP)
- [x] AC-3: Send tool results back to session via `session.send()` with proper format
- [x] AC-4: Emit `tool-call` and `tool-result` events for UI display
- [x] AC-5: Handle tool execution errors gracefully
- [x] AC-6: Support multi-tool responses (multiple tool_use blocks)

## Technical Notes

**Tool execution flow**:
```typescript
for await (const msg of session.stream()) {
  if (msg.type === 'assistant') {
    const toolUses = extractToolUses(msg.message.content)
    
    for (const toolUse of toolUses) {
      // Emit tool-call event for UI
      yield { type: 'tool-call', toolCallId: toolUse.id, toolName: toolUse.name, ... }
      
      // Execute via OpenCode's registry
      const result = await executeTool(toolUse.name, toolUse.input, context)
      
      // Emit tool-result event for UI  
      yield { type: 'tool-result', toolCallId: toolUse.id, result, ... }
      
      // Send result back to Claude
      await session.send(formatToolResult(toolUse.id, result))
    }
    
    // Continue streaming for Claude's response to tool results
    for await (const nextMsg of session.stream()) {
      // ... handle next turn
    }
  }
}
```

**Tool result format for V2**:
The V2 SDK accepts tool results via `send()`. Need to verify exact format - likely:
```typescript
session.send(JSON.stringify({
  type: 'tool_result',
  tool_use_id: toolUseId,
  content: resultString
}))
```

**Files to modify**:
- `packages/opencode/src/provider/native/claude-agent-sdk.ts` - add tool handling

**Reuse**:
- Tool execution from `tool-bridge.ts` patterns
- Tool context building logic

## Time Estimate

predicted_hours: 1.5
actual_hours: TBD

## Dependencies

- claude-v2-native-stream
- claude-v2-llm-routing

## Notes

2026-01-25: This is where we gain the most - no Vercel validation interfering with tool calls, no `_providerExecuted` remapping losing tool names, direct control over the tool execution lifecycle.
2026-01-25: Added tool error handling in translate-stream and tests for multi-tool + native tool event flow. Files changed: packages/opencode/src/provider/sdk/claude-agent-sdk/translate-stream.ts, packages/opencode/src/provider/native/claude-agent-sdk.ts, packages/opencode/test/provider/sdk/claude-agent-sdk/translate.test.ts, packages/opencode/test/provider/native/claude-agent-sdk.test.ts
