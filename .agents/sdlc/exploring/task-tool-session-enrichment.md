# Task Tool Session Data Not Enriched in Anthropic Agents SDK

## Context
The OpenCode Task tool isn't being fully enriched with clickable/navigatable session data when used within the native Anthropic agents SDK integration. Need to understand the data flow and identify where enrichment is failing.

## Acceptance Criteria
- [ ] Understand how Task tool results flow through the Anthropic agents SDK integration
- [ ] Identify where session data enrichment should occur
- [ ] Find the gap between expected vs actual behavior
- [ ] Propose options for fixing the enrichment

## Notes
2026-01-25: Starting exploration - dispatching explorer agent
2026-01-25: **Exploration complete** - Root cause identified:

### Findings

**Event Flow:**
1. `llm.ts` (lines 248-282): When `providerID='claude-agent-sdk'`, uses `streamClaudeNative()`
2. `claude-agent-sdk.ts`: `processSDKMessage()` handles SDK events
3. `processor.ts`: Expects `tool-result` event to transition tools from "running" to "completed"

**Root Cause:**
The `processSDKMessage()` function only emits `tool-result` when receiving a `tool_use_summary` event with a `summary` field (line 541). If the Anthropic SDK doesn't send this event (or sends it differently), tools stay stuck in "running" state.

**Debug Logging Added:**
Added console.log statements to trace:
- All non-streaming SDK event types
- Tool completion events (tool_progress/tool_use_summary)
- Tool use detection in assistant messages

### Options Identified

1. **Debug first** (Recommended) - Run with logging to see actual SDK events
2. **Check SDK docs** - Understand expected event types for MCP tool completion
3. **Alternative completion detection** - Maybe tool completion is in assistant message blocks
