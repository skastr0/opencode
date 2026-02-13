# Emit tool-error on tool_use_summary failures

## Context
Native stream never emits tool-error, so failing tools stay running until the stream ends and are marked aborted.

## Acceptance Criteria
- [x] When tool_use_summary indicates an error (is_error true or error field present), processSDKMessage emits tool-error with a human-readable message and removes the tool from state.toolCalls.
- [x] Error cases do not emit tool-result for the same tool id.
- [x] Tool error event includes toolName and input when available.

## Technical Notes
- Add tolerant error extraction similar to translate-stream (readToolError), handling string, object with message, or boolean is_error.
- Default message should be "Tool failed." when no error text is available.
- Estimated complexity: Low (1-2 hours).

## Notes
2026-01-26: Created from commit plan.
2026-01-26: Added tool_use_summary error parsing to emit tool-error with default message and cleanup. Files changed: packages/opencode/src/provider/native/claude-agent-sdk.ts, packages/opencode/test/provider/native/claude-agent-sdk.test.ts.
