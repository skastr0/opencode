import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import type { AnyZodRawShape, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { generateId } from "@ai-sdk/provider-utils"
import { z, toJSONSchema, type ZodTypeAny } from "zod"
import { ToolRegistry } from "../../tool/registry"
import { MCP } from "../../mcp"
import { Tool } from "../../tool/tool"
import { MessageV2 } from "../../session/message-v2"
import { Session } from "../../session"
import { Agent } from "../../agent/agent"
import { PermissionNext } from "../../permission/next"
import { Plugin } from "../../plugin"
import type { Provider } from "../provider"
import * as ToolMetadataRegistry from "./tool-metadata-registry"
import { Identifier } from "../../id/id"
import { Bus } from "../../bus"
import { Log } from "../../util/log"

const log = Log.create({ service: "tool-bridge" })

const SDK_NATIVE_TOOLS = new Set(["read", "write", "edit", "bash", "glob", "grep", "ls"])

// ============================================================================
// LAYER 2: Buffered metadata updates with retry
// ============================================================================
type PendingUpdate = {
  sessionID: string
  messageID: string
  callID: string
  toolName: string
  args: Record<string, unknown>
  val: { title?: string; metadata?: unknown }
  timestamp: number
  retries: number
}

// Buffer for metadata updates that arrive before part is ready
const pendingUpdates = new Map<string, PendingUpdate[]>()
const activeRetries = new Map<string, NodeJS.Timeout>()
const MAX_RETRIES = 10
const BASE_RETRY_MS = 50

function bufferUpdate(update: PendingUpdate) {
  const key = `${update.messageID}:${update.callID}`
  const existing = pendingUpdates.get(key) ?? []
  existing.push(update)
  pendingUpdates.set(key, existing)
  scheduleRetry(key)
}

function scheduleRetry(key: string) {
  if (activeRetries.has(key)) return
  const timer = setTimeout(() => flushBuffer(key), BASE_RETRY_MS)
  activeRetries.set(key, timer)
}

async function flushBuffer(key: string) {
  activeRetries.delete(key)
  const updates = pendingUpdates.get(key)
  if (!updates?.length) {
    pendingUpdates.delete(key)
    return
  }

  const remaining: PendingUpdate[] = []
  for (const update of updates) {
    const success = await tryApplyUpdate(update)
    if (!success) {
      update.retries++
      if (update.retries < MAX_RETRIES) {
        remaining.push(update)
      } else {
        log.warn("max retries reached for metadata update", { callID: update.callID })
      }
    }
  }

  if (remaining.length > 0) {
    pendingUpdates.set(key, remaining)
    const delay = Math.min(BASE_RETRY_MS * Math.pow(2, remaining[0].retries), 1000)
    const timer = setTimeout(() => flushBuffer(key), delay)
    activeRetries.set(key, timer)
  } else {
    pendingUpdates.delete(key)
  }
}

async function tryApplyUpdate(update: PendingUpdate): Promise<boolean> {
  const parts = await MessageV2.parts(update.messageID)
  const match = parts.find((p): p is MessageV2.ToolPart => p.type === "tool" && p.callID === update.callID)

  if (!match) return false
  if (match.state.status !== "running" && match.state.status !== "pending") return false

  const metadata = asRecord(update.val.metadata)
  const existingTime = match.state.status === "running" ? match.state.time?.start : undefined
  await Session.updatePart({
    ...match,
    state: {
      status: "running",
      input: update.args,
      title: update.val.title,
      metadata,
      time: { start: existingTime ?? Date.now() },
    },
  })
  return true
}

// ============================================================================
// LAYER 5: Subscribe to part creation to flush pending updates
// ============================================================================
let partSubscriptionActive = false

function ensurePartSubscription() {
  if (partSubscriptionActive) return
  partSubscriptionActive = true

  Bus.subscribe(MessageV2.Event.PartUpdated, (evt) => {
    const part = evt.properties.part
    if (part.type !== "tool") return

    const key = `${part.messageID}:${part.callID}`
    if (pendingUpdates.has(key)) {
      flushBuffer(key)
    }
  })
}

// JSON Schema to Zod raw shape converter
// Creates simple Zod schemas that the SDK's bundled zodToJsonSchema can handle
type JsonSchemaProperty = {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  items?: JsonSchemaProperty
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
  default?: unknown
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: string
  anyOf?: JsonSchemaProperty[]
  oneOf?: JsonSchemaProperty[]
  allOf?: JsonSchemaProperty[]
  const?: unknown
}

type JsonSchema = JsonSchemaProperty & {
  $schema?: string
  additionalProperties?: boolean | JsonSchemaProperty
}

function jsonSchemaPropertyToZod(prop: JsonSchemaProperty): ZodTypeAny {
  // Handle const
  if (prop.const !== undefined) {
    return z.literal(prop.const as string | number | boolean).describe(prop.description ?? "")
  }

  // Handle enum
  if (prop.enum && prop.enum.length > 0) {
    const values = prop.enum as [string, ...string[]]
    return z.enum(values).describe(prop.description ?? "")
  }

  // Handle anyOf/oneOf
  if (prop.anyOf && prop.anyOf.length > 0) {
    const options = prop.anyOf.map(jsonSchemaPropertyToZod)
    if (options.length === 1) return options[0]
    return z.union(options as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]).describe(prop.description ?? "")
  }
  if (prop.oneOf && prop.oneOf.length > 0) {
    const options = prop.oneOf.map(jsonSchemaPropertyToZod)
    if (options.length === 1) return options[0]
    return z.union(options as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]).describe(prop.description ?? "")
  }

  // Handle type array (e.g., ["string", "null"])
  const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : ["any"]

  // Handle nullable
  const isNullable = types.includes("null")
  const nonNullTypes = types.filter((t) => t !== "null")
  const primaryType = nonNullTypes[0] ?? "any"

  let schema: ZodTypeAny

  switch (primaryType) {
    case "string":
      schema = z.string()
      if (prop.minLength !== undefined) schema = (schema as z.ZodString).min(prop.minLength)
      if (prop.maxLength !== undefined) schema = (schema as z.ZodString).max(prop.maxLength)
      break
    case "number":
    case "integer":
      schema = z.number()
      if (prop.minimum !== undefined) schema = (schema as z.ZodNumber).min(prop.minimum)
      if (prop.maximum !== undefined) schema = (schema as z.ZodNumber).max(prop.maximum)
      break
    case "boolean":
      schema = z.boolean()
      break
    case "array":
      schema = z.array(prop.items ? jsonSchemaPropertyToZod(prop.items) : z.any())
      break
    case "object":
      if (prop.properties) {
        const shape: Record<string, ZodTypeAny> = {}
        const required = new Set(prop.required ?? [])
        for (const [key, value] of Object.entries(prop.properties)) {
          shape[key] = required.has(key) ? jsonSchemaPropertyToZod(value) : jsonSchemaPropertyToZod(value).optional()
        }
        schema = z.object(shape)
      } else {
        schema = z.record(z.string(), z.any())
      }
      break
    default:
      schema = z.any()
  }

  if (prop.description) schema = schema.describe(prop.description)
  if (isNullable) schema = schema.nullable()
  if (prop.default !== undefined) schema = schema.default(prop.default)

  return schema
}

function jsonSchemaToZodShape(schema: JsonSchema): AnyZodRawShape {
  if (!schema.properties) return {}
  const shape: Record<string, ZodTypeAny> = {}
  const required = new Set(schema.required ?? [])

  for (const [key, prop] of Object.entries(schema.properties)) {
    const zodProp = jsonSchemaPropertyToZod(prop)
    shape[key] = required.has(key) ? zodProp : zodProp.optional()
  }

  return shape as AnyZodRawShape
}

// Convert Zod 4 schema to JSON Schema, then to a Zod raw shape the SDK can handle
function zodToSdkShape(schema: ZodTypeAny): AnyZodRawShape {
  try {
    // Use Zod 4's built-in toJSONSchema (type assertion needed due to overloaded signatures)
    const jsonSchema = (toJSONSchema as (s: ZodTypeAny) => JsonSchema)(schema)
    return jsonSchemaToZodShape(jsonSchema)
  } catch {
    // Fallback: return empty passthrough shape
    return {} as AnyZodRawShape
  }
}

interface ToolBridgeContext {
  sessionID: string
  messageID?: string
  model: Provider.Model
  abort?: AbortSignal
  bypassAgentCheck?: boolean
}

type ToolContextState = {
  messageID: string
  agentName: string
  agent?: Agent.Info
  session?: Session.Info
}

type ToolOutput = {
  title: string
  output: string
  metadata: Record<string, unknown>
  attachments?: MessageV2.FilePart[]
}

export async function createOpenCodeToolsServer(context: ToolBridgeContext) {
  const toolContext = await resolveToolContext(context)
  const tools: Array<SdkMcpToolDefinition<any>> = []
  const registryTools = await ToolRegistry.tools(
    { modelID: context.model.api.id, providerID: context.model.providerID },
    toolContext.agent,
  )

  // Ensure we're listening for part creation events to flush buffered updates
  ensurePartSubscription()

  for (const item of registryTools) {
    if (SDK_NATIVE_TOOLS.has(item.id.toLowerCase())) continue
    tools.push({
      name: item.id,
      description: item.description,
      inputSchema: zodToSdkShape(item.parameters),
      handler: async (args, extra) => {
        const ctx = await buildToolContext(context, toolContext, args, extra, item.id)
        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: item.id,
            sessionID: ctx.sessionID,
            callID: ctx.callID,
          },
          {
            args,
          },
        )

        // LAYER 1: Pre-create the ToolPart before execution starts
        // This ensures the part exists when ctx.metadata() is called
        if (ctx.callID) {
          await ensureToolPartExists({
            sessionID: context.sessionID,
            messageID: toolContext.messageID,
            callID: ctx.callID,
            toolName: item.id,
            input: args,
          })
        }

        const result = await runTool(item.execute, args, ctx)

        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: item.id,
            sessionID: ctx.sessionID,
            callID: ctx.callID,
          },
          result,
        )

        // Store metadata for correlation when translate-stream processes tool_use_summary
        // This preserves rich metadata (like sessionId) that would otherwise be lost
        if (result.metadata && Object.keys(result.metadata).length > 0) {
          ToolMetadataRegistry.store(item.id, args, {
            title: result.title,
            metadata: result.metadata,
          })
        }

        return toolResult(result)
      },
    } as SdkMcpToolDefinition<any>)
  }

  const mcpTools = await MCP.tools()

  for (const [id, mcpTool] of Object.entries(mcpTools)) {
    const execute = mcpTool.execute
    if (!execute) continue

    const mcpToolName = `mcp_${id}`
    tools.push({
      name: mcpToolName,
      description: mcpTool.description ?? `MCP tool: ${id}`,
      inputSchema: jsonSchemaToZodShape(mcpTool.inputSchema as JsonSchema),
      handler: async (args, extra) => {
        const ctx = await buildToolContext(context, toolContext, args, extra, mcpToolName)
        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: id,
            sessionID: ctx.sessionID,
            callID: ctx.callID,
          },
          {
            args,
          },
        )

        // LAYER 1: Pre-create the ToolPart before execution starts
        if (ctx.callID) {
          await ensureToolPartExists({
            sessionID: context.sessionID,
            messageID: toolContext.messageID,
            callID: ctx.callID,
            toolName: mcpToolName,
            input: args,
          })
        }

        await ctx.ask({
          permission: id,
          metadata: {},
          patterns: ["*"],
          always: ["*"],
        })

        const toolCallId = ctx.callID ?? generateId()
        const result = await execute(args, {
          toolCallId,
          messages: [],
          abortSignal: ctx.abort,
        })

        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: id,
            sessionID: ctx.sessionID,
            callID: ctx.callID,
          },
          result,
        )

        return normalizeMcpResult(result)
      },
    } as SdkMcpToolDefinition<any>)
  }

  return createSdkMcpServer({
    name: "opencode",
    version: "1.0.0",
    tools,
  })
}

async function resolveToolContext(context: ToolBridgeContext): Promise<ToolContextState> {
  // Only try to resolve if we have a valid OpenCode session ID (starts with "ses_")
  const isValidSessionId = context.sessionID.startsWith("ses_")

  if (isValidSessionId) {
    const message = await resolveAssistantMessage(context.sessionID, context.messageID)
    if (message) {
      const agentName = message.info.agent
      const agent = await Agent.get(agentName)
      const session = await Session.get(context.sessionID).catch(() => undefined)
      return {
        messageID: message.info.id,
        agentName,
        agent: agent ?? undefined,
        session,
      }
    }
  }

  // Fallback: return minimal context (tools will still work, just without full session tracking)
  const messageID = context.messageID ?? generateId()
  return {
    messageID,
    agentName: "default",
    agent: undefined,
    session: undefined,
  }
}

async function resolveAssistantMessage(sessionID: string, messageID?: string) {
  if (messageID) {
    const msg = await MessageV2.get({ sessionID, messageID }).catch(() => undefined)
    if (msg && msg.info.role === "assistant") return msg
  }

  for await (const msg of MessageV2.stream(sessionID)) {
    if (msg.info.role === "assistant") return msg
  }

  return undefined
}

async function buildToolContext(
  context: ToolBridgeContext,
  state: ToolContextState,
  args: Record<string, unknown>,
  extra: unknown,
  toolName?: string,
): Promise<Tool.Context> {
  const callID = readToolUseId(extra)
  const abort = readAbortSignal(extra) ?? context.abort ?? new AbortController().signal
  const ruleset = PermissionNext.merge(state.agent?.permission ?? [], state.session?.permission ?? [])
  const tool = callID ? { messageID: state.messageID, callID } : undefined

  return {
    sessionID: context.sessionID,
    messageID: state.messageID,
    agent: state.agentName,
    abort,
    callID,
    extra: {
      model: context.model,
      bypassAgentCheck: context.bypassAgentCheck ?? false,
    },
    metadata: async (val) => {
      if (!callID) return
      await updateToolMetadata({
        sessionID: context.sessionID,
        messageID: state.messageID,
        callID,
        toolName: toolName ?? "tool",
        args,
        val,
      })
    },
    ask: async (req) => {
      await PermissionNext.ask({
        ...req,
        sessionID: context.sessionID,
        tool,
        ruleset,
      })
    },
  }
}

// ============================================================================
// LAYER 1: Pre-create ToolPart before execution
// ============================================================================
async function ensureToolPartExists(input: {
  sessionID: string
  messageID: string
  callID: string
  toolName: string
  input: Record<string, unknown>
}): Promise<MessageV2.ToolPart | undefined> {
  // Check if part already exists
  const parts = await MessageV2.parts(input.messageID)
  const existing = parts.find((p): p is MessageV2.ToolPart => p.type === "tool" && p.callID === input.callID)

  if (existing) {
    // If exists but pending, transition to running
    if (existing.state.status === "pending") {
      const updated: MessageV2.ToolPart = {
        ...existing,
        state: {
          status: "running",
          input: input.input,
          time: { start: Date.now() },
        },
      }
      await Session.updatePart(updated)
      return updated
    }
    return existing
  }

  // Create new part in running state
  const part: MessageV2.ToolPart = {
    id: Identifier.ascending("part"),
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "tool",
    tool: input.toolName,
    callID: input.callID,
    state: {
      status: "running",
      input: input.input,
      time: { start: Date.now() },
    },
  }

  await Session.updatePart(part)
  return part
}

// ============================================================================
// LAYERS 2, 3, 4: Robust metadata update with buffering, on-demand creation, and direct emission
// ============================================================================
type UpdateInput = {
  sessionID: string
  messageID: string
  callID: string
  toolName: string
  args: Record<string, unknown>
  val: { title?: string; metadata?: unknown }
}

async function updateToolMetadata(input: UpdateInput) {
  const { sessionID, messageID, callID, toolName, args, val } = input

  // Try to update existing part
  const parts = await MessageV2.parts(messageID)
  let match = parts.find((part): part is MessageV2.ToolPart => part.type === "tool" && part.callID === callID)

  // LAYER 3: On-demand part creation if it doesn't exist
  if (!match) {
    log.info("creating part on-demand for metadata update", { callID, toolName })
    match = await ensureToolPartExists({
      sessionID,
      messageID,
      callID,
      toolName,
      input: args,
    })
  }

  // If still no match (shouldn't happen), buffer the update for retry
  if (!match) {
    log.warn("part still not found after creation attempt, buffering", { callID })
    bufferUpdate({
      sessionID,
      messageID,
      callID,
      toolName,
      args,
      val,
      timestamp: Date.now(),
      retries: 0,
    })
    return
  }

  // Can't update completed or error parts
  if (match.state.status === "completed" || match.state.status === "error") {
    return
  }

  // If pending, transition to running first
  const metadata = asRecord(val.metadata)
  const existingTime = match.state.status === "running" ? match.state.time?.start : undefined

  const updatedPart: MessageV2.ToolPart = {
    ...match,
    state: {
      status: "running",
      input: args,
      title: val.title,
      metadata,
      time: { start: existingTime ?? Date.now() },
    },
  }

  // Update storage and emit event (Session.updatePart handles both)
  await Session.updatePart(updatedPart)
}

async function runTool(execute: unknown, args: Record<string, unknown>, ctx: Tool.Context) {
  const runner = execute as (input: Record<string, unknown>, context: Tool.Context) => Promise<ToolOutput>
  return runner(args, ctx)
}

function toolResult(result: ToolOutput): CallToolResult {
  const text = typeof result.output === "string" ? result.output : safeJson(result.output)
  return {
    content: [{ type: "text", text }],
  }
}

function normalizeMcpResult(result: unknown): CallToolResult {
  const record = asRecord(result)
  if (!record) {
    return {
      content: [{ type: "text", text: safeJson(result) }],
    }
  }

  const content = Array.isArray(record.content) ? record.content : undefined
  if (content) {
    return {
      content,
      isError: record.isError === true,
    }
  }

  return {
    content: [{ type: "text", text: safeJson(result) }],
  }
}

function readToolUseId(extra: unknown): string | undefined {
  const record = asRecord(extra)
  if (!record) return undefined
  const direct = asString(record.tool_use_id)
  if (direct) return direct
  const camel = asString(record.toolUseId)
  if (camel) return camel
  const upper = asString(record.toolUseID)
  if (upper) return upper

  const request = asRecord(record.request)
  if (!request) return undefined
  const params = asRecord(request.params)
  if (!params) return undefined
  const meta = asRecord(params.meta)
  if (!meta) return undefined
  const metaId = asString(meta.tool_use_id)
  if (metaId) return metaId
  return asString(meta.toolUseId)
}

function readAbortSignal(extra: unknown): AbortSignal | undefined {
  const record = asRecord(extra)
  if (!record) return undefined
  const signal = record.signal
  if (signal instanceof AbortSignal) return signal
  return undefined
}

function safeJson(value: unknown) {
  if (typeof value === "string") return value
  const seen = new WeakSet<object>()
  const json = JSON.stringify(value, (_key, val) => {
    if (typeof val === "bigint") return val.toString()
    if (val && typeof val === "object") {
      if (seen.has(val)) return "[Circular]"
      seen.add(val)
    }
    return val
  })
  if (typeof json === "string") return json
  return "{}"
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value
  return undefined
}

export const DISABLED_SDK_TOOLS = [
  "Task",
  "TodoWrite",
  "TodoRead",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "TaskOutput",
  "KillTask",
  "WebFetch",
  "WebSearch",
]
