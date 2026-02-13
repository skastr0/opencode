# Remove obsolete AI SDK wrapper for Claude Agent SDK

## Context
The Claude Agent SDK was initially integrated via an AI SDK wrapper pattern (`src/provider/sdk/claude-agent-sdk/`). This approach is now obsolete because we have a native implementation at `src/provider/native/claude-agent-sdk.ts` that directly uses the Claude Agent SDK without the AI SDK abstraction layer.

The wrapper code is no longer used and should be removed to reduce maintenance burden and avoid confusion.

## Acceptance Criteria
- [ ] Remove `src/provider/sdk/claude-agent-sdk/` directory and all files
- [ ] Remove `test/provider/sdk/claude-agent-sdk/` test files
- [ ] Remove any imports/references to the obsolete wrapper in provider.ts and other files
- [ ] Ensure native implementation is correctly wired as the sole claude-agent-sdk provider
- [ ] All existing tests pass
- [ ] Type check passes

## Technical Notes
- Native implementation: `src/provider/native/claude-agent-sdk.ts`
- Obsolete wrapper: `src/provider/sdk/claude-agent-sdk/` (8 files)
- Obsolete test: `test/provider/sdk/claude-agent-sdk/translate.test.ts`
- Keep native test: `test/provider/native/claude-agent-sdk.test.ts`

## Notes
2026-01-26: Created via FAST PATH - cleanup task is well-understood, minimal risk
