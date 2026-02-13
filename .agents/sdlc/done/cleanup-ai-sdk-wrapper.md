# Clean up obsolete AI SDK wrapper for Claude Agent SDK

## Context
The native Claude Agent SDK integration (`src/provider/native/claude-agent-sdk.ts`) has superseded the AI SDK wrapper approach (`src/provider/sdk/claude-agent-sdk/`). The wrapper is now obsolete and should be removed.

However, the native integration still depends on some code from the wrapper folder that must be moved first.

## Dependencies Map (from type analysis)

### Native integration (`native/claude-agent-sdk.ts`) imports from SDK wrapper:
- `createOpenCodeToolsServer`, `DISABLED_SDK_TOOLS` from `../sdk/claude-agent-sdk/tool-bridge`
- `mapModelId` from `../sdk/claude-agent-sdk/models`

### `session/llm.ts` imports:
- `ClaudeAgentSDKSessionStore` from `@/provider/sdk/claude-agent-sdk/session-store`

### `provider.ts` imports:
- `createClaudeAgentSDK` → used in SDK_CREATORS (obsolete wrapper - REMOVE)
- `CLAUDE_AGENT_SDK_MODELS` → model definitions (KEEP)

## Acceptance Criteria
- [x] Move `tool-bridge.ts` to `native/` folder
- [x] Move `session-store.ts` to `native/` folder
- [x] Move `CLAUDE_AGENT_SDK_MODELS` and `mapModelId` to `native/` folder
- [x] Update all imports to point to new locations
- [x] Remove `createClaudeAgentSDK` import from provider.ts
- [x] Remove dead `getModel` function from CUSTOM_LOADERS["claude-agent-sdk"] (kept autoload: true)
- [x] Delete entire `sdk/claude-agent-sdk/` folder
- [x] Delete test file `test/provider/sdk/claude-agent-sdk/translate.test.ts`
- [x] Update test mock path from sdk to native
- [x] Ensure types pass with `bun run typecheck`
- [x] Ensure tests pass (11/11 pass)

## Technical Notes
- The native integration uses the Claude Agent SDK directly, not through AI SDK abstraction
- The tool-bridge contains MCP server setup for OpenCode tools
- Session store manages Claude conversation sessions
- Model definitions define available Claude models

## Notes
2026-01-26: Created work item. Fast path - well-understood cleanup task.
