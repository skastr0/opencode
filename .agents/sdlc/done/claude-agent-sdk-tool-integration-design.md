# Claude Agent SDK Tool Integration Design

## Requirements Summary

### Keep (Claude SDK Native Tools)
- Read, Write, Edit, LS, Glob, Grep, Replace, Bash
- Skills (identical to OpenCode skills)

### Disable (Claude SDK Native Tools)
- `Task` - OpenCode tracks subagents
- `TodoWrite`, `TodoRead` - OpenCode has its own
- `AskUserQuestion` - OpenCode handles user interaction
- `EnterPlanMode`, `ExitPlanMode` - Not needed
- `TaskOutput`, `KillTask` - Part of Task system
- `WebFetch`, `WebSearch` - Use OpenCode's equivalents

### Add (OpenCode Tools via Custom MCP)
- OpenCode plugin tools
- OpenCode-configured MCP tools (passthrough)
- OpenCode's Task tool (with full subagent support)

## Technical Approach

### 1. SDK Configuration

```typescript
const sdkOptions = {
  model: "claude-sonnet-4-5",
  
  // Disable unwanted Claude tools
  disallowedTools: [
    "Task",           // Use OpenCode's Task instead
    "TodoWrite",      // OpenCode has its own
    "TodoRead",       // OpenCode has its own  
    "AskUserQuestion", // OpenCode handles interaction
    "EnterPlanMode",  // Not needed
    "ExitPlanMode",   // Not needed
    "TaskOutput",     // Part of Task system
    "KillTask",       // Part of Task system
    "WebFetch",       // Use OpenCode's webfetch
    "WebSearch",      // Use OpenCode's websearch
  ],
  
  // Custom MCP servers with OpenCode tools
  mcpServers: {
    "opencode": opencodeToolsServer,  // In-process MCP server
  },
  
  // Allow OpenCode MCP tools
  allowedTools: [
    // All OpenCode tools will be prefixed: mcp__opencode__<tool_name>
    "mcp__opencode__task",
    "mcp__opencode__*",  // Or explicit list
  ],
  
  // Settings
  includePartialMessages: true,
  settingSources: ["user", "project"],
  workingDirectory: process.cwd(),
  permissionMode: "bypassPermissions", // Or custom canUseTool
}
```

### 2. OpenCode Tools MCP Server

Use `createSdkMcpServer` to wrap OpenCode's tools:

```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"

async function createOpenCodeToolsServer(sessionContext: SessionContext) {
  const tools: SdkMcpToolDefinition[] = []
  
  // 1. Add OpenCode's Task tool (special handling)
  tools.push(createTaskTool(sessionContext))
  
  // 2. Add OpenCode plugin/custom tools
  const registryTools = await ToolRegistry.tools()
  for (const [id, toolInfo] of Object.entries(registryTools)) {
    // Skip tools that SDK already has natively
    if (["read", "write", "edit", "bash", "glob", "grep"].includes(id)) continue
    
    tools.push({
      name: id,
      description: toolInfo.description,
      inputSchema: z.toJSONSchema(toolInfo.parameters),
      execute: async (args) => {
        const result = await toolInfo.execute(args, sessionContext)
        return { content: [{ type: "text", text: result.output }] }
      }
    })
  }
  
  // 3. Add OpenCode-configured MCP tools
  const mcpTools = await MCP.tools()
  for (const [id, mcpTool] of Object.entries(mcpTools)) {
    tools.push({
      name: `mcp_${id}`, // Prefix to avoid collision
      description: mcpTool.description,
      inputSchema: mcpTool.parameters,
      execute: async (args) => {
        const result = await mcpTool.execute(args)
        return { content: [{ type: "text", text: JSON.stringify(result) }] }
      }
    })
  }
  
  return createSdkMcpServer({
    name: "opencode",
    version: "1.0.0",
    tools,
  })
}
```

### 3. OpenCode Task Tool Wrapper

The Task tool needs special handling to track subagent sessions in OpenCode:

```typescript
function createTaskTool(sessionContext: SessionContext) {
  return {
    name: "task",
    description: `Launch a new agent to handle complex, multistep tasks autonomously.
    
Available agent types: ${getAvailableAgents().join(", ")}

Usage: Specify subagent_type, description, and prompt.`,
    
    inputSchema: z.object({
      description: z.string().describe("Short (3-5 words) description"),
      prompt: z.string().describe("The task for the agent to perform"),
      subagent_type: z.string().describe("Type of specialized agent"),
      session_id: z.string().optional().describe("Existing session to continue"),
    }),
    
    execute: async (args) => {
      // Execute via OpenCode's Task tool (not SDK's)
      const TaskTool = await ToolRegistry.get("task")
      const result = await TaskTool.execute(args, {
        sessionID: sessionContext.sessionID,
        messageID: sessionContext.messageID,
        // ... other context
      })
      
      return {
        content: [{
          type: "text",
          text: result.output
        }]
      }
    }
  }
}
```

### 4. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         OPENCODE SESSION                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐                    ┌─────────────────────────────────┐│
│  │   OpenCode   │                    │     Claude Agent SDK            ││
│  │   Session    │───────────────────▶│                                 ││
│  │              │                    │  ┌───────────────────────────┐  ││
│  │  - Tracking  │                    │  │   Native Tools (kept)     │  ││
│  │  - History   │                    │  │   Read, Write, Edit, Bash │  ││
│  │  - Parts     │                    │  │   Glob, Grep, WebFetch    │  ││
│  └──────────────┘                    │  └───────────────────────────┘  ││
│         │                            │                                  ││
│         │                            │  ┌───────────────────────────┐  ││
│         │                            │  │   Disabled Tools          │  ││
│         │                            │  │   Task, Todo*, Plan*      │  ││
│         │                            │  │   AskUser, Kill*          │  ││
│         │                            │  └───────────────────────────┘  ││
│         │                            │                                  ││
│         │                            │  ┌───────────────────────────┐  ││
│         │                            │  │   OpenCode MCP Server     │  ││
│         │◀───────────────────────────│  │   (in-process)            │  ││
│         │   Tool execution requests  │  │                           │  ││
│         │                            │  │  - task (→ OpenCode)      │  ││
│         │                            │  │  - plugin tools           │  ││
│         │                            │  │  - mcp_* (passthrough)    │  ││
│         │                            │  └───────────────────────────┘  ││
│         │                            │                                  ││
│         ▼                            └─────────────────────────────────┘│
│  ┌──────────────┐                                                       │
│  │   OpenCode   │                                                       │
│  │   Tools      │                                                       │
│  │              │                                                       │
│  │  - Task      │◀─── Subagent sessions tracked in OpenCode            │
│  │  - Plugins   │                                                       │
│  │  - MCPs      │◀─── OpenCode's configured MCP servers                │
│  └──────────────┘                                                       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5. Implementation Steps

1. **Update SDK options** - Add `disallowedTools` list
2. **Create tool bridge** - `packages/opencode/src/provider/sdk/claude-agent-sdk/tool-bridge.ts`
   - Function to create in-process MCP server
   - Wrapper for OpenCode's Task tool
   - Passthrough for plugin tools
   - Passthrough for MCP tools
3. **Update model** - Integrate tool bridge in `claude-agent-sdk-model.ts`
4. **Test** - Verify:
   - Claude's native tools work (Read, Write, etc.)
   - OpenCode's Task tool works and tracks sessions
   - Plugin tools are accessible
   - MCP tools are accessible

### 6. Key Considerations

- **Session Context**: The MCP server needs access to OpenCode's session context for tool execution
- **Tool Name Collisions**: OpenCode MCP tools prefixed with `mcp_` to avoid collisions
- **Permissions**: Using `bypassPermissions` for now; could use `canUseTool` for finer control
- **Streaming**: `includePartialMessages: true` for text streaming

## Acceptance Criteria

- [ ] Claude's native tools (Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch) work
- [ ] Claude's Task, Todo, AskUser, PlanMode tools are disabled
- [ ] OpenCode's Task tool is available via `mcp__opencode__task`
- [ ] Subagent sessions are tracked in OpenCode (visible in UI)
- [ ] OpenCode plugin tools are available
- [ ] OpenCode-configured MCP tools are available
- [ ] Streaming works correctly
- [ ] Skills from ~/.claude and .claude work

## Decisions (Confirmed)

1. **WebFetch/WebSearch** - DISABLE Claude's, use OpenCode's equivalents
2. **MCP Passthrough** - Always passthrough ALL OpenCode-configured MCPs
3. **Permission Mode** - `bypassPermissions` for now; future: sync OpenCode permissions to SDK
4. **Metadata** - Capture ALL metadata; duplication between SDK and OpenCode is OK
5. **Name Collision** - Use Claude's native for allowed tools; skip OpenCode duplicates
