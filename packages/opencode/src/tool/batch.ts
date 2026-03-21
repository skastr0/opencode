import z from "zod"
import { Tool } from "./tool"
import { ProviderID, ModelID } from "../provider/schema"
import DESCRIPTION from "./batch.txt"
import { Log } from "../util/log"

const log = Log.create({ service: "tool.batch" })

const DISALLOWED = new Set(["batch"])
const FILTERED_FROM_SUGGESTIONS = new Set(["invalid", "patch", ...DISALLOWED])

// Normalize tool names from various formats to internal names
// Handles: mcp__opencode__task -> task, Grep -> grep, Task -> task
function normalizeToolName(name: string): string {
  // Strip MCP prefix if present
  const prefix = "mcp__opencode__"
  if (name.startsWith(prefix)) {
    name = name.slice(prefix.length)
  }
  // Lowercase for case-insensitive matching
  return name.toLowerCase()
}

export const BatchTool = Tool.define("batch", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      tool_calls: z
        .array(
          z.object({
            tool: z.string().describe("The name of the tool to execute"),
            parameters: z.record(z.string(), z.any()).describe("Parameters for the tool"),
          }),
        )
        .min(1, "Provide at least one tool call")
        .describe("Array of tool calls to execute in parallel"),
    }),
    formatValidationError(error) {
      const formattedErrors = error.issues
        .map((issue) => {
          const path = issue.path.length > 0 ? issue.path.join(".") : "root"
          return `  - ${path}: ${issue.message}`
        })
        .join("\n")

      return `Invalid parameters for tool 'batch':\n${formattedErrors}\n\nExpected payload format:\n  [{"tool": "tool_name", "parameters": {...}}, {...}]`
    },
    async execute(params, ctx) {
      const { Session } = await import("../session")
      const { PartID } = await import("../session/schema")

      const toolCalls = params.tool_calls.slice(0, 25)
      const discardedCalls = params.tool_calls.slice(25)

      const { ToolRegistry } = await import("./registry")
      const availableTools = await ToolRegistry.tools({ modelID: ModelID.make(""), providerID: ProviderID.make("") })
      const toolMap = new Map(availableTools.map((t) => [t.id, t]))

      const executeCall = async (call: (typeof toolCalls)[0]) => {
        const callStartTime = Date.now()
        const partID = PartID.ascending()
        // Normalize tool name (mcp__opencode__task -> task, Grep -> grep)
        const toolName = normalizeToolName(call.tool)

        log.info("batch executeCall", { originalTool: call.tool, normalizedTool: toolName, partID })

        try {
          if (DISALLOWED.has(toolName)) {
            throw new Error(
              `Tool '${toolName}' is not allowed in batch. Disallowed tools: ${Array.from(DISALLOWED).join(", ")}`,
            )
          }

          const tool = toolMap.get(toolName)
          log.info("batch tool lookup", {
            toolName,
            found: !!tool,
            availableTools: Array.from(toolMap.keys()).slice(0, 10),
          })
          if (!tool) {
            const availableToolsList = Array.from(toolMap.keys()).filter((name) => !FILTERED_FROM_SUGGESTIONS.has(name))
            throw new Error(
              `Tool '${call.tool}' (normalized: '${toolName}') not in registry. External tools (MCP, environment) cannot be batched - call them directly. Available tools: ${availableToolsList.join(", ")}`,
            )
          }
          log.info("batch validating params", {
            toolName,
            callParams: call.parameters,
            callParamsKeys: Object.keys(call.parameters || {}),
          })
          const validatedParams = tool.parameters.parse(call.parameters)
          log.info("batch params validated", { toolName, validatedParamsKeys: Object.keys(validatedParams || {}) })

          await Session.updatePart({
            id: partID,
            messageID: ctx.messageID,
            sessionID: ctx.sessionID,
            type: "tool",
            tool: toolName, // Use normalized name
            callID: partID,
            state: {
              status: "running",
              input: call.parameters,
              time: {
                start: callStartTime,
              },
            },
          })

          log.info("batch executing tool", { toolName, partID })
          const result = await tool.execute(validatedParams, { ...ctx, callID: partID })
          const attachments = result.attachments?.map((attachment) => ({
            ...attachment,
            id: PartID.ascending(),
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
          }))
          log.info("batch tool completed", { toolName, partID })

          await Session.updatePart({
            id: partID,
            messageID: ctx.messageID,
            sessionID: ctx.sessionID,
            type: "tool",
            tool: toolName, // Use normalized name
            callID: partID,
            state: {
              status: "completed",
              input: call.parameters,
              output: result.output,
              title: result.title,
              metadata: result.metadata,
              attachments,
              time: {
                start: callStartTime,
                end: Date.now(),
              },
            },
          })

          return { success: true as const, tool: toolName, result }
        } catch (error) {
          log.error("batch tool error", {
            toolName,
            partID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          })
          await Session.updatePart({
            id: partID,
            messageID: ctx.messageID,
            sessionID: ctx.sessionID,
            type: "tool",
            tool: toolName, // Use normalized name
            callID: partID,
            state: {
              status: "error",
              input: call.parameters,
              error: error instanceof Error ? error.message : String(error),
              time: {
                start: callStartTime,
                end: Date.now(),
              },
            },
          })

          return { success: false as const, tool: toolName, error }
        }
      }

      log.info("batch starting parallel execution", { toolCount: toolCalls.length })
      const results = await Promise.all(toolCalls.map((call) => executeCall(call)))
      log.info("batch parallel execution complete", {
        resultsCount: results.length,
        successCount: results.filter((r) => r.success).length,
      })

      // Add discarded calls as errors
      const now = Date.now()
      for (const call of discardedCalls) {
        const partID = PartID.ascending()
        const discardedToolName = normalizeToolName(call.tool)
        await Session.updatePart({
          id: partID,
          messageID: ctx.messageID,
          sessionID: ctx.sessionID,
          type: "tool",
          tool: discardedToolName,
          callID: partID,
          state: {
            status: "error",
            input: call.parameters,
            error: "Maximum of 25 tools allowed in batch",
            time: { start: now, end: now },
          },
        })
        results.push({
          success: false as const,
          tool: discardedToolName,
          error: new Error("Maximum of 25 tools allowed in batch"),
        })
      }

      const successfulCalls = results.filter((r) => r.success).length
      const failedCalls = results.length - successfulCalls

      const outputMessage =
        failedCalls > 0
          ? `Executed ${successfulCalls}/${results.length} tools successfully. ${failedCalls} failed.`
          : `All ${successfulCalls} tools executed successfully.\n\nKeep using the batch tool for optimal performance in your next response!`

      return {
        title: `Batch execution (${successfulCalls}/${results.length} successful)`,
        output: outputMessage,
        attachments: results.filter((result) => result.success).flatMap((r) => r.result.attachments ?? []),
        metadata: {
          totalCalls: results.length,
          successful: successfulCalls,
          failed: failedCalls,
          tools: params.tool_calls.map((c) => normalizeToolName(c.tool)),
          details: results.map((r) => ({ tool: r.tool, success: r.success })),
        },
      }
    },
  }
})
