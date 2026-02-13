# Claude Agent SDK Tool Bridge Implementation

## Context
Integrate OpenCode tools with Claude Agent SDK via an in-process MCP server so SDK native tools stay in place while OpenCode Task, plugin tools, and configured MCP tools are available.

## Acceptance Criteria
- [x] Claude's native tools (Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch) work
- [x] Claude's Task, Todo, AskUser, PlanMode tools are disabled
- [x] OpenCode's Task tool is available via mcp__opencode__task
- [x] Subagent sessions are tracked in OpenCode (visible in UI)
- [x] OpenCode plugin tools are available
- [x] OpenCode-configured MCP tools are available
- [x] Streaming works correctly
- [x] Skills from ~/.claude and .claude work

## Notes
2026-01-25: Implemented Claude Agent SDK tool bridge and MCP passthrough, updated stream tool event handling, and added translate-stream tests. Files changed: packages/opencode/src/provider/sdk/claude-agent-sdk/tool-bridge.ts, packages/opencode/src/provider/sdk/claude-agent-sdk/claude-agent-sdk-model.ts, packages/opencode/src/provider/sdk/claude-agent-sdk/translate-stream.ts, packages/opencode/test/provider/sdk/claude-agent-sdk/translate.test.ts
