# Subagent TUI Updates Investigation

## Context
Currently, when `mcp_opencode_task` tool calls are made, the TUI shows the agent name but does NOT update with:
- Current tool call being executed by the subagent
- Stats of tool calls (count, types, etc.)
- Real-time progress of subagent work

This investigation aims to understand the current architecture and identify opportunities for improvement.

## Areas to Investigate
1. Native agents SDK - how tool calls are handled
2. mcp_opencode_task tool implementation
3. TUI rendering logic for subagent/task displays
4. Event/message flow from subagent to parent session

## Acceptance Criteria
- [ ] Understand current native agents SDK tool call handling
- [ ] Map mcp_opencode_task implementation and data flow
- [ ] Document TUI update mechanisms for task displays
- [ ] Identify gaps preventing real-time subagent updates
- [ ] Propose options for enabling live subagent tool call visibility

## Notes
2026-01-26: Starting exploration of subagent TUI update architecture
2026-01-26: Exploration complete - dispatched 3 explorer agents in parallel

### Root Cause Identified
**MCP metadata propagation is broken** - Two issues compound:
1. `tool_use_id/callID` is missing in MCP handlers (`tool-bridge.ts`), so `ctx.metadata` calls no-op
2. `ToolMetadataRegistry` stores metadata but has no retrieval path wired into `tool_use_summary` processing (`claude-agent-sdk.ts`)

### Key Files
| File | Role |
|------|------|
| `packages/opencode/src/provider/native/tool-bridge.ts` | MCP server for tools - callID missing |
| `packages/opencode/src/provider/native/claude-agent-sdk.ts` | No ToolMetadataRegistry.retrieve() |
| `packages/opencode/src/tool/task.ts` | Subscribes to child session events, updates metadata |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | Task component renders metadata.summary |

### Options (ranked by time-to-learning)
1. **Fix MCP metadata propagation** (1-2h, low risk) ⭐ Recommended
2. **TUI-side child session mirroring** (2-4h, medium risk)
3. **Server-side aggregation** (0.5-1 day, medium-high risk)

---

## Implementation (2026-01-26)

### Changes Made
**File: `packages/opencode/src/provider/native/claude-agent-sdk.ts`**

1. Added import for `ToolMetadataRegistry`
2. In `tool_use_summary` handler, retrieve stored metadata and merge into tool-result event

```typescript
// Before:
const meta = summary ? { summary } : {}

// After:
const stored = ToolMetadataRegistry.retrieve(toolName, info?.input)
const meta = {
  ...(summary ? { summary } : {}),
  ...(stored?.metadata ?? {}),
}
```

### What This Enables
- ✅ `sessionId` propagates to TUI → child session navigation works
- ✅ `summary` array with tool progress is preserved → shows tool counts/status
- ✅ `model` info is preserved
- ✅ Full parity with native Task tool behavior

### Type Check
✅ Passed (no new errors)
