# Emit tool-result on tool_use_summary without summary

## Context
Tool calls remain in running state because the native stream only emits tool-result when tool_use_summary has summary text. We need to treat any tool_use_summary as completion.

## Acceptance Criteria
- [x] When tool_use_summary arrives without summary and without error, processSDKMessage emits tool-result with default output text and deletes the tool entry from state.toolCalls.
- [x] When tool_use_summary includes summary, tool-result output uses that summary (no regression from current behavior).
- [x] Tool result output includes normalized toolName and carries input from the registered tool call when available.

## Technical Notes
- Mirror translate-stream fallback: outputText = summary ?? (errorText ? "Tool failed." : "Tool completed."), but only use the non-error branch for this item.
- Use getToolIds to resolve ids from tool_use_id or preceding_tool_use_ids and delete each id from state.toolCalls after emitting completion.
- Estimated complexity: Low (1-2 hours).

## Notes
2026-01-26: Created from commit plan.
2026-01-26: Emitted tool-result on tool_use_summary with default output text and preserved toolName/input. Files changed: packages/opencode/src/provider/native/claude-agent-sdk.ts, packages/opencode/test/provider/native/claude-agent-sdk.test.ts.
