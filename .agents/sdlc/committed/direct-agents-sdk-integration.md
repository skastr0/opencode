# Direct Anthropic Agents SDK Integration (Bypass Vercel AI SDK)

id: direct-agents-sdk-integration

## Context

OpenCode currently uses a layered architecture:
```
OpenCode → Vercel AI SDK → Claude Agent SDK (via ai-sdk provider wrapper)
```

This creates several problems:
1. **Tool call display broken**: Vercel SDK interferes when managing tool calls from Agents SDK
2. **Unnecessary abstraction**: Wrapping/mapping OpenCode tools through Vercel's provider model
3. **Session issues**: Session resumption and ID tracking problems, especially for Task tool
4. **Complexity**: Multiple translation layers (OpenCode → Vercel → Agents SDK → back)

---

## Exploration Findings (2026-01-25)

### 1. Vercel AI SDK Integration Map

**Dependency Scope**: Vercel AI SDK is deeply integrated:
- `ai` imports in: `session/llm.ts`, `agent/agent.ts`, `session/message-v2.ts`, `session/prompt.ts`, `mcp/index.ts`, `session/index.ts`, `provider/provider.ts`, `provider/transform.ts`, `acp/agent.ts`
- 16+ provider packages bundled via `@ai-sdk/*`
- Core abstractions used: `LanguageModelV2`, `streamText`, `wrapLanguageModel`, `tool`, `jsonSchema`, `ModelMessage`, `ToolSet`

**Message Flow**:
```
SessionPrompt/Session → LLM.stream → streamText(ai) → wrapLanguageModel+middleware 
    → LanguageModelV2.doStream → ClaudeAgentSDKLanguageModel.doStream 
    → Claude Agent SDK query() → translate-stream → LanguageModelV2StreamPart
```

**Coupling Assessment**: HIGH
- `streamText`, `wrapLanguageModel`, `ModelMessage`, and tool schemas used across session, prompt, MCP, and agent flows
- Provider integration deeply tied to `LanguageModelV2` and providerOptions keying
- Claude Agent SDK wrapper is an adapter within Vercel's model, not a bypass

---

### 2. Claude Agent SDK Native API

**Entry Point**: `query()` from `@anthropic-ai/claude-agent-sdk`
- Accepts `prompt` as string or async generator
- Yields message objects directly (no Vercel intermediary)

**Event Types** (streaming):
| Event | Purpose |
|-------|---------|
| `system` (subtype: `init`) | Session initialization, includes `session_id` |
| `partial` | Streaming deltas (text chunks) |
| `assistant` | Block content: text, tool_use, thinking |
| `tool_progress` | Tool execution updates (tool_use_id, elapsed_time) |
| `tool_use_summary` | Tool completion summary |
| `result` | Final result (success/error) |
| `error` | Error messages |

**Tool Protocol (Native)**:
- Tool requests: `assistant.message.content` blocks with `{ type: "tool_use", id, name, input }`
- Tool results: Input messages with `{ type: "tool_result", tool_use_id, content }`

**Session Protocol**:
- `system` init provides `session_id`
- Resume with `options.resume = session_id`
- Additional: `forkSession`, `continue`, `continue_conversation`

**MCP Protocol**:
- Configure via `options.mcpServers`
- Tool naming: `mcp__<server>__<tool>`
- In-process MCP via `createSdkMcpServer`

---

### 3. Tool Mapping Pain Points

**Translation Layers**:
1. OpenCode ToolRegistry → `SessionPrompt.resolveTools` → `ai.tool/jsonSchema` → `streamText`
2. OpenCode ToolRegistry → `createOpenCodeToolsServer` (tool-bridge) → MCP server → Claude SDK

**Where Display Breaks**:
1. **Vercel intercepts tool calls**: Provider-executed tools still processed by Vercel; if validation fails, `experimental_repairToolCall` remaps to `_providerExecuted`, losing original tool name
2. **SDK native tools excluded**: Claude SDK native tools (read/write/edit/bash) excluded from MCP, OpenCode only receives summary events
3. **ID divergence**: `tool_use_id` → `toolCallId` mapping can break across translation layers
4. **Display sequencing**: `SessionProcessor` expects `tool-input-start` → `tool-call` → `tool-result` sequence; mismatched IDs leave parts pending

**Current Bridge Architecture** (tool-bridge.ts):
- Builds MCP tools from ToolRegistry + OpenCode MCP tools
- Filters out SDK-native tools (read/write/edit/bash/glob/grep/ls)
- Wraps execution with `PermissionNext.ask` and Plugin hooks
- Tool results from `tool_use_summary` lack full output

---

### 4. Session Management Root Cause

**Critical Finding**: Session ID propagation is broken

**How Sessions Work**:
| Layer | Session Mechanism |
|-------|-------------------|
| OpenCode | Local storage with messages/parts; resumption from stored history |
| Vercel AI SDK | Stateless; expects full history each call; session ID only for `promptCacheKey` |
| Claude Agent SDK | Own `session_id` + `resume`; stored in-memory only |

**The Bug**:
- `providerOptions['claude-agent-sdk'].sessionId` **defaults to `"default"`** when not set
- All SDK calls share `"default"` session key → session collisions
- Tool bridge expects real OpenCode session ID (`ses_*`); with "default", tool calls aren't linked to actual sessions
- Task tool child sessions emitted in output but not persisted or auto-reused

**Files Involved**:
- `claude-agent-sdk-model.ts` - uses default session key
- `session-store.ts` - in-memory only storage
- `tool-bridge.ts` - context lookup fails with "default"
- `tool/task.ts` - no central linkage for child sessions

---

## Options (Ranked by Time-to-Learning)

### Option 1: Feature-Flagged Claude Direct Path ⭐ RECOMMENDED
**Approach**: Add a Claude-only stream path calling SDK `query()` directly, keeping Vercel AI SDK for other providers.

**Implementation**:
- Create `packages/opencode/src/provider/native/claude-agent-sdk.ts`
- New `LLM.streamNative()` path that bypasses `streamText`
- Feature flag: `OPENCODE_CLAUDE_NATIVE=1` or provider config
- Tool calls handled directly without Vercel validation
- Session ID propagation fixed at this layer

**Time-to-learning**: 4-8 hours
**Risk**: Low (isolated, reversible)
**Validates**: What Vercel machinery must be re-implemented

### Option 2: Internal Model Interface Abstraction
**Approach**: Create an OpenCode-specific model interface, adapt both AI SDK and Claude SDK behind it.

**Time-to-learning**: 1-2 days
**Risk**: Medium (touches shared abstractions)
**Validates**: Whether a unified abstraction simplifies things

### Option 3: Full Replacement of streamText Pipeline
**Approach**: Replace Vercel AI SDK streaming/middleware for ALL providers.

**Time-to-learning**: 3-7 days
**Risk**: High (large surface area, affects all providers)
**Validates**: Complete independence from Vercel SDK

---

## Quick Wins (Can Do Immediately)

### Fix Session ID Propagation (1-2 hours)
Even within current architecture, fixing session ID propagation would resolve many issues:
- Pass OpenCode `sessionID` into `providerOptions['claude-agent-sdk'].sessionId`
- Tool-bridge would resolve real sessions
- Session isolation restored

### Instrument Tool Call Lifecycle (1-2 hours)
Trace `translate-stream` → `LLM.stream` → `SessionProcessor` to capture exact failure points for tool display.

---

## Acceptance Criteria

- [x] Clear map of current integration architecture
- [x] Identified specific friction points causing tool display and session issues
- [x] Assessment of Claude Agent SDK's native capabilities
- [x] Ranked options for moving forward with time-to-learning estimates

---

## Recommendation

**Proceed with Option 1 (Feature-Flagged Claude Direct Path)** because:

1. **Fastest feedback**: 4-8 hours to validate what Vercel machinery matters
2. **Isolated changes**: Doesn't affect other providers or existing flows
3. **Reversible**: Feature flag makes it easy to toggle back
4. **Addresses all issues**: Direct control over tool calls, sessions, and streaming

The exploration has revealed that the core issues are:
- Vercel's tool validation interfering with provider-executed tools
- Session ID defaulting to "default" causing collisions
- Multiple translation layers adding complexity without value for Claude

A direct path bypasses all of this while preserving the existing architecture for other providers.

---

## Notes

2026-01-25: Exploration complete. 4 parallel explorers dispatched:
- Explorer 1: Vercel AI SDK integration mapping
- Explorer 2: Claude Agent SDK native API
- Explorer 3: Tool mapping/bridge layer
- Explorer 4: Session management stack

Packets saved in `.agents/messages/2026-01-25T23-39-*` through `2026-01-25T23-45-*`
