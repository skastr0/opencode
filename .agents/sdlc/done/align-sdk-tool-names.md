# Align Native Agent SDK Tool Names with OpenCode TUI Display

## Context
When using the Claude Agent SDK, native tools like `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob` are sent with PascalCase names from the SDK. However, OpenCode's TUI has rich display components registered under lowercase names (`read`, `write`, etc.).

This causes SDK-executed tools to fall back to `GenericTool` display instead of the rich, customized displays (diff views, syntax highlighting, command output formatting, etc.).

The user wants to align these so SDK tools get the same rich TUI treatment as OpenCode's native tools.

## Acceptance Criteria
- [x] SDK native tool calls display with OpenCode's rich TUI components
- [x] Tool names are normalized consistently throughout the system
- [x] No breaking changes to existing tool execution
- [x] mcp_opencode_task already works - preserve that pattern

## Technical Notes
Key files:
- `packages/opencode/src/provider/sdk/claude-agent-sdk/translate-stream.ts` - translates SDK events to LanguageModelV2StreamPart
- `packages/opencode/src/provider/sdk/claude-agent-sdk/tool-bridge.ts` - bridges OpenCode tools to SDK
- `packages/ui/src/components/message-part.tsx` - TUI tool display registration

Current state:
- `SDK_NATIVE_TOOLS` in tool-bridge.ts: `["read", "write", "edit", "bash", "glob", "grep", "ls"]`
- SDK sends: `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob` (PascalCase)
- TUI registers: `read`, `write`, `edit`, `bash`, `grep`, `glob` (lowercase)

## Notes
2026-01-25: Created work item. Need to explore options for name normalization.
2026-01-26: Added SDK tool name normalization and aligned tests; introduced test hooks to prevent cross-test SDK mocking conflicts.
Files changed: packages/opencode/src/provider/sdk/claude-agent-sdk/translate-stream.ts, packages/opencode/test/provider/sdk/claude-agent-sdk/translate.test.ts, packages/opencode/src/provider/native/claude-agent-sdk.ts, packages/opencode/src/session/llm.ts, packages/opencode/test/provider/native/claude-agent-sdk.test.ts, packages/opencode/test/session/llm-native-session.test.ts, packages/opencode/test/preload.ts
2026-01-26: Normalized SDK tool names in native stream and aligned native tests with lowercase tool names.
Files changed: packages/opencode/src/provider/native/claude-agent-sdk.ts, packages/opencode/test/provider/native/claude-agent-sdk.test.ts

## Review Notes
2026-01-26: Review found blocking issues. See review-findings packet.
- Native stream (`claude-agent-sdk.ts`) missing tool name normalization logic (PascalCase -> lowercase).
- Native tests (`claude-agent-sdk.test.ts`) assert incorrect unnormalized names ("Bash" instead of "bash").
