# Capture Claude Agent SDK Subprocess stderr/stdout

## Context

When the Claude Agent SDK subprocess crashes with "exited with code 1", we cannot see the actual error message because:

1. The `@anthropic-ai/claude-agent-sdk` spawns a subprocess internally
2. OpenCode has no control over that subprocess's stderr/stdout
3. Only the exit code is surfaced

This results in completely opaque errors like:
```
Claude Code process exited with code 1
```

With no indication of WHY it failed (auth? network? config? internal bug?).

## Acceptance Criteria

- [ ] Investigate if `@anthropic-ai/claude-agent-sdk` supports stderr/stdout capture options
- [ ] If SDK supports it, enable stderr capture and log it
- [ ] If SDK doesn't support it, file upstream issue on claude-agent-sdk repo
- [ ] As fallback, add pre-flight checks before SDK invocation:
  - [ ] Check `claude` CLI is installed and working
  - [ ] Check authentication is valid
  - [ ] Check network connectivity to Anthropic
- [ ] Surface any captured stderr in the error message shown to users

## Technical Notes

Key file: `packages/opencode/src/provider/native/claude-agent-sdk.ts`

The error classification happens at lines 1109-1181 but only has the exit code to work with.

Current SDK usage pattern (approximate):
```typescript
const sdk = new ClaudeAgentSDK(...)
const stream = await sdk.stream(...)
// stream errors only contain exit code, not stderr
```

Need to check claude-agent-sdk docs/source for stderr capture options.

## Notes

2026-01-26: This may require upstream SDK changes. File issue if necessary.
