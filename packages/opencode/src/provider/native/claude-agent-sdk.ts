import type {
  LanguageModelV2FinishReason,
  LanguageModelV2Prompt,
  LanguageModelV2Usage,
  SharedV2ProviderMetadata,
} from "@ai-sdk/provider"
import { createOpenCodeToolsServer, DISABLED_SDK_TOOLS } from "../sdk/claude-agent-sdk/tool-bridge"
import { mapModelId } from "../sdk/claude-agent-sdk/models"
import type { Provider } from "../provider"

type SDKMessage = Record<string, unknown>

type ToolOutput = {
  title: string
  output: string
  metadata: Record<string, unknown>
  attachments?: unknown[]
}

export type ClaudeNativeStreamEvent =
  | { type: "start" }
  | { type: "start-step" }
  | { type: "text-start"; id: string; providerMetadata?: SharedV2ProviderMetadata }
  | { type: "text-delta"; id: string; text: string; providerMetadata?: SharedV2ProviderMetadata }
  | { type: "text-end"; id: string; providerMetadata?: SharedV2ProviderMetadata }
  | { type: "reasoning-start"; id: string; providerMetadata?: SharedV2ProviderMetadata }
  | { type: "reasoning-delta"; id: string; text: string; providerMetadata?: SharedV2ProviderMetadata }
  | { type: "reasoning-end"; id: string; providerMetadata?: SharedV2ProviderMetadata }
  | { type: "tool-input-start"; id: string; toolName: string }
  | {
      type: "tool-call"
      toolCallId: string
      toolName: string
      input: Record<string, unknown>
      providerExecuted: boolean
      providerMetadata?: SharedV2ProviderMetadata
    }
  | {
      type: "tool-result"
      toolCallId: string
      toolName: string
      output: ToolOutput
      input?: Record<string, unknown>
      providerExecuted: boolean
      providerMetadata?: SharedV2ProviderMetadata
    }
  | {
      type: "tool-error"
      toolCallId: string
      toolName: string
      input?: Record<string, unknown>
      error: unknown
      providerExecuted: boolean
      providerMetadata?: SharedV2ProviderMetadata
    }
  | {
      type: "finish-step"
      usage: LanguageModelV2Usage
      finishReason: LanguageModelV2FinishReason
      providerMetadata?: SharedV2ProviderMetadata
    }
  | {
      type: "finish"
      usage: LanguageModelV2Usage
      finishReason: LanguageModelV2FinishReason
      providerMetadata?: SharedV2ProviderMetadata
    }
  | { type: "error"; error: unknown }

export type ClaudeNativeInput = {
  sessionID: string
  messageID?: string
  model: Provider.Model
  prompt: LanguageModelV2Prompt
  abort: AbortSignal
  sdkSessionId?: string
  onSessionId?: (id: string) => void
  workingDirectory?: string
  maxThinkingTokens?: number
  permissionMode?: string
  bypassAgentCheck?: boolean
}

export type ClaudeNativeOutput = {
  fullStream: AsyncIterable<ClaudeNativeStreamEvent>
}

// V1 query() types - accepts string prompt AND supports mcpServers
type QueryOptions = {
  model?: string
  maxThinkingTokens?: number
  permissionMode?: string
  workingDirectory?: string
  disallowedTools?: string[]
  allowedTools?: string[]
  mcpServers?: Record<string, unknown>
  resume?: string
  abortController?: AbortController
  includePartialMessages?: boolean
  // Environment variables for the SDK process
  env?: Record<string, string | undefined>
  // Path to Claude Code executable (for bundled builds)
  pathToClaudeCodeExecutable?: string
}

type Query = AsyncIterable<SDKMessage> & {
  close: () => void
}

const SDK_TOOL_NAME_MAP: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  Bash: "bash",
  Grep: "grep",
  Glob: "glob",
  Ls: "list",
  NotebookEdit: "notebook_edit",
  TaskStop: "task_stop",
}

// Normalize MCP tool names from SDK format to OpenCode format
// SDK format: mcp__opencode__toolname
// OpenCode format: toolname
function normalizeToolName(name: string): string {
  if (SDK_TOOL_NAME_MAP[name]) {
    return SDK_TOOL_NAME_MAP[name]
  }
  const prefix = "mcp__opencode__"
  if (name.startsWith(prefix)) {
    return name.slice(prefix.length)
  }
  return name
}

// Normalize parameter names from snake_case to camelCase
// The Claude Agent SDK uses snake_case (file_path, old_string, new_string)
// but OpenCode's tools expect camelCase (filePath, oldString, newString)
// NOTE: Only apply this to SDK native tools, not MCP tools which already have correct naming
function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, char) => char.toUpperCase())
}

function normalizeInputParams(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    result[snakeToCamel(key)] = value
  }
  return result
}

// Check if a tool is an SDK native tool (vs MCP tool)
function isSDKNativeTool(rawName: string): boolean {
  return rawName in SDK_TOOL_NAME_MAP
}

// SDK user message type for async iterable prompts
type SDKUserMessage = {
  type: "user"
  message: {
    role: "user"
    content: Array<
      { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
    >
  }
  parent_tool_use_id: null
  session_id: string
}

type QueryPrompt = string | AsyncIterable<SDKUserMessage>

export async function streamClaudeNative(input: ClaudeNativeInput): Promise<ClaudeNativeOutput> {
  const prompt = buildPrompt(input.prompt, input.sessionID)
  const options = await buildQueryOptions(input)
  const query = await loadQuery()

  const fullStream = (async function* (): AsyncGenerator<ClaudeNativeStreamEvent> {
    const state = createStreamState()
    yield { type: "start" }
    yield { type: "start-step" }

    if (input.abort.aborted) {
      yield { type: "finish-step", usage: state.usage, finishReason: "other", providerMetadata: state.providerMetadata }
      yield { type: "finish", usage: state.usage, finishReason: "other", providerMetadata: state.providerMetadata }
      return
    }

    let queryInstance: Query | undefined
    let aborted = false

    try {
      // V1 query() accepts string or AsyncIterable<SDKUserMessage>
      queryInstance = query({ prompt, options })

      for await (const msg of queryInstance) {
        if (input.abort.aborted) {
          aborted = true
          break
        }

        // Capture session ID
        const sessionId = readSessionId(msg)
        if (sessionId && !state.sessionId) {
          state.sessionId = sessionId
          input.onSessionId?.(sessionId)
        }

        // Process message and yield events
        const events = processSDKMessage(msg, state)
        for (const event of events) {
          yield event
        }

        // Check for errors
        if (asString(msg.type) === "error") {
          yield { type: "error", error: readError(msg) }
          return
        }
      }
    } catch (error) {
      yield { type: "error", error }
      return
    } finally {
      queryInstance?.close()
    }

    const finishReason = aborted ? "other" : state.finishReason
    yield { type: "finish-step", usage: state.usage, finishReason, providerMetadata: state.providerMetadata }
    yield { type: "finish", usage: state.usage, finishReason, providerMetadata: state.providerMetadata }
  })()

  return { fullStream }
}

// Build prompt for SDK - returns string for text-only, AsyncIterable for messages with images
function buildPrompt(prompt: LanguageModelV2Prompt, sessionId: string): QueryPrompt {
  const hasImages = prompt.some(
    (msg) =>
      msg.role === "user" && msg.content.some((part) => part.type === "file" && part.mediaType?.startsWith("image/")),
  )

  // If no images, use simple string prompt (more efficient)
  if (!hasImages) {
    return extractUserPrompt(prompt)
  }

  // Convert to SDK message format with images
  return (async function* () {
    // First yield system prompt as part of first user message if exists
    const systemContent: string[] = []
    for (const msg of prompt) {
      if (msg.role === "system" && typeof msg.content === "string") {
        systemContent.push(msg.content)
      }
    }

    // Build content array with text and images
    const content: Array<
      { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
    > = []

    // Add system prompt as text if present
    if (systemContent.length > 0) {
      content.push({ type: "text", text: systemContent.join("\n\n") })
    }

    // Add user content (text and images)
    for (const msg of prompt) {
      if (msg.role === "user") {
        for (const part of msg.content) {
          if (part.type === "text") {
            content.push({ type: "text", text: part.text })
          } else if (part.type === "file" && part.mediaType?.startsWith("image/")) {
            // Convert file part to image block
            let data: string = ""
            if (typeof part.data === "string") {
              // Handle data URLs (e.g., "data:image/png;base64,...")
              if (part.data.startsWith("data:")) {
                const commaIndex = part.data.indexOf(",")
                if (commaIndex !== -1) {
                  data = part.data.slice(commaIndex + 1)
                }
              } else {
                // Assume it's already base64
                data = part.data
              }
            } else if (part.data instanceof Uint8Array) {
              data = Buffer.from(part.data).toString("base64")
            }
            // URL type not supported - would need to fetch the content

            if (data) {
              content.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: part.mediaType,
                  data,
                },
              })
            }
          }
        }
      }
    }

    yield {
      type: "user" as const,
      message: {
        role: "user" as const,
        content,
      },
      parent_tool_use_id: null,
      session_id: sessionId,
    }
  })()
}

function extractUserPrompt(prompt: LanguageModelV2Prompt): string {
  const parts: string[] = []

  for (const msg of prompt) {
    if (msg.role === "system" && typeof msg.content === "string") {
      parts.push(msg.content)
    }
  }

  for (const msg of prompt) {
    if (msg.role === "user") {
      for (const part of msg.content) {
        if (part.type === "text") {
          parts.push(part.text)
        }
      }
    }
  }

  return parts.join("\n\n")
}

import { execSync } from "child_process"

// Find claude executable path
function findClaudeExecutable(): string | undefined {
  try {
    const result = execSync("which claude", { encoding: "utf-8" }).trim()
    return result || undefined
  } catch {
    return undefined
  }
}

// Cache the result
let cachedClaudePath: string | undefined | null = null

function getClaudeExecutable(): string | undefined {
  if (cachedClaudePath === null) {
    cachedClaudePath = findClaudeExecutable()
  }
  return cachedClaudePath
}

async function buildQueryOptions(input: ClaudeNativeInput): Promise<QueryOptions> {
  const server = await createOpenCodeToolsServer({
    sessionID: input.sessionID,
    messageID: input.messageID,
    model: input.model,
    abort: input.abort,
    bypassAgentCheck: input.bypassAgentCheck,
  })

  const options: QueryOptions = {
    model: mapModelId(input.model.id),
    permissionMode: input.permissionMode ?? "bypassPermissions",
    workingDirectory: input.workingDirectory ?? process.cwd(),
    disallowedTools: DISABLED_SDK_TOOLS,
    allowedTools: ["mcp__opencode__*"], // Allow all OpenCode MCP tools
    includePartialMessages: true, // Enable streaming of partial text responses
    // Disable Tool Search so MCP tools are immediately available
    env: {
      ...process.env,
      ENABLE_TOOL_SEARCH: "false",
      ENABLE_EXPERIMENTAL_MCP_CLI: "false",
    },
    pathToClaudeCodeExecutable: getClaudeExecutable(),
    mcpServers: {
      opencode: server,
    },
  }

  if (input.sdkSessionId) {
    options.resume = input.sdkSessionId
  }

  if (input.maxThinkingTokens !== undefined) {
    options.maxThinkingTokens = input.maxThinkingTokens
  }

  return options
}

async function loadQuery(): Promise<(params: { prompt: QueryPrompt; options?: QueryOptions }) => Query> {
  const hook = (
    globalThis as {
      __opencodeSdkQuery?: (params: { prompt: QueryPrompt; options?: QueryOptions }) => Query
    }
  ).__opencodeSdkQuery
  if (hook) return hook

  const mod = (await import("@anthropic-ai/claude-agent-sdk")) as {
    query?: (params: { prompt: QueryPrompt; options?: QueryOptions }) => Query
  }

  if (!mod.query) {
    throw new Error("Claude Agent SDK not available")
  }

  return mod.query
}

function createStreamState() {
  return {
    usage: {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    } as LanguageModelV2Usage,
    finishReason: "stop" as LanguageModelV2FinishReason,
    providerMetadata: undefined as SharedV2ProviderMetadata | undefined,
    sessionId: undefined as string | undefined,
    textId: undefined as string | undefined,
    reasoningId: undefined as string | undefined,
    toolCalls: new Map<string, { name: string; input: Record<string, unknown> }>(),
    // Track if we've received stream events - if so, skip text/thinking in assistant messages
    hasStreamedContent: false,
  }
}

function processSDKMessage(msg: SDKMessage, state: ReturnType<typeof createStreamState>): ClaudeNativeStreamEvent[] {
  const events: ClaudeNativeStreamEvent[] = []
  const type = asString(msg.type)

  // Handle stream events (partial messages during streaming)
  if (type === "stream_event") {
    const event = asRecord(msg.event)
    if (!event) return events

    const eventType = asString(event.type)

    // Handle text deltas
    if (eventType === "content_block_delta") {
      const delta = asRecord(event.delta)
      if (delta) {
        const deltaType = asString(delta.type)
        if (deltaType === "text_delta") {
          const text = asString(delta.text)
          if (text) {
            state.hasStreamedContent = true
            if (!state.textId) {
              state.textId = generateId()
              events.push({ type: "text-start", id: state.textId })
            }
            events.push({ type: "text-delta", id: state.textId, text })
          }
        } else if (deltaType === "thinking_delta") {
          const text = asString(delta.thinking)
          if (text) {
            state.hasStreamedContent = true
            if (!state.reasoningId) {
              state.reasoningId = generateId()
              events.push({ type: "reasoning-start", id: state.reasoningId })
            }
            events.push({ type: "reasoning-delta", id: state.reasoningId, text })
          }
        }
      }
    }

    // Handle content block stops
    if (eventType === "content_block_stop") {
      if (state.textId) {
        events.push({ type: "text-end", id: state.textId })
        state.textId = undefined
      }
      if (state.reasoningId) {
        events.push({ type: "reasoning-end", id: state.reasoningId })
        state.reasoningId = undefined
      }
    }

    return events
  }

  // Handle legacy partial format (fallback)
  if (type === "partial") {
    const delta = asString(msg.delta) ?? asString(msg.text)
    if (delta) {
      if (!state.textId) {
        state.textId = generateId()
        events.push({ type: "text-start", id: state.textId })
      }
      events.push({ type: "text-delta", id: state.textId, text: delta })
    }
    return events
  }

  if (type === "assistant") {
    if (state.textId) {
      events.push({ type: "text-end", id: state.textId })
      state.textId = undefined
    }
    if (state.reasoningId) {
      events.push({ type: "reasoning-end", id: state.reasoningId })
      state.reasoningId = undefined
    }

    const message = asRecord(msg.message)
    const content = Array.isArray(message?.content) ? message.content : []

    for (const block of content) {
      const item = asRecord(block)
      if (!item) continue
      const blockType = asString(item.type)

      // Only emit text/thinking from assistant messages if we haven't streamed them
      // (When includePartialMessages is true, we get both stream_event and assistant messages)
      if (blockType === "text" && !state.hasStreamedContent) {
        const text = asString(item.text)
        if (text) {
          const id = generateId()
          events.push({ type: "text-start", id })
          events.push({ type: "text-delta", id, text })
          events.push({ type: "text-end", id })
        }
      }

      if (blockType === "thinking" && !state.hasStreamedContent) {
        const text = asString(item.thinking)
        if (text) {
          const id = generateId()
          events.push({ type: "reasoning-start", id })
          events.push({ type: "reasoning-delta", id, text })
          events.push({ type: "reasoning-end", id })
        }
      }

      if (blockType === "tool_use") {
        const toolId = asString(item.id) ?? generateId()
        const rawToolName = asString(item.name) ?? "tool"
        const toolName = normalizeToolName(rawToolName)
        // Only normalize input params for SDK native tools
        // MCP tools (like Task) already use the correct parameter names from their schema
        const rawInput = toRecord(item.input)
        const input = isSDKNativeTool(rawToolName) ? normalizeInputParams(rawInput) : rawInput

        state.toolCalls.set(toolId, { name: toolName, input })

        events.push({ type: "tool-input-start", id: toolId, toolName })
        events.push({
          type: "tool-call",
          toolCallId: toolId,
          toolName,
          input,
          providerExecuted: true,
        })
      }

      // Handle tool_result content blocks (SDK sends these for MCP tool results)
      if (blockType === "tool_result") {
        const toolUseId = asString(item.tool_use_id) ?? ""
        const info = state.toolCalls.get(toolUseId)
        const toolName = info?.name ?? "tool"
        const resultContent = extractToolResultContent(item.content)
        const isError = asBoolean(item.is_error) ?? false

        if (isError) {
          events.push({
            type: "tool-error",
            toolCallId: toolUseId,
            toolName,
            input: info?.input,
            error: new Error(resultContent),
            providerExecuted: true,
          })
        } else {
          events.push({
            type: "tool-result",
            toolCallId: toolUseId,
            toolName,
            output: {
              title: toolName,
              output: resultContent,
              metadata: {},
            },
            input: info?.input,
            providerExecuted: true,
          })
        }
        state.toolCalls.delete(toolUseId)
      }
    }

    const usage = readUsage(msg)
    if (usage) {
      state.usage = usage.usage
      state.providerMetadata = usage.metadata
    }

    return events
  }

  // Handle result messages - these contain final cumulative usage data
  if (type === "result") {
    // The SDK sends cumulative usage in result messages
    // Format: { usage: { input_tokens, output_tokens, ... }, modelUsage: { [model]: { inputTokens, ... } } }
    const usage = readResultUsage(msg)
    if (usage) {
      state.usage = usage.usage
      state.providerMetadata = usage.metadata
    }
    return events
  }

  // Handle user messages with tool results
  // SDK v1 sends tool results in two possible formats:
  // 1. Top-level `tool_use_result` field with `parent_tool_use_id`
  // 2. Content blocks with `tool_result` type inside `message.content`
  if (type === "user") {
    // Format 1: Top-level tool_use_result field (SDK v1 native format)
    const topLevelResult = msg.tool_use_result
    const parentToolUseId = asString(msg.parent_tool_use_id)

    if (topLevelResult !== undefined && parentToolUseId) {
      const info = state.toolCalls.get(parentToolUseId)
      const toolName = info?.name ?? "tool"
      const resultContent = extractToolResultContent(topLevelResult)
      // Check for error - could be a top-level is_error field or error in the result
      const isError = asBoolean(msg.is_error) ?? false

      if (isError) {
        events.push({
          type: "tool-error",
          toolCallId: parentToolUseId,
          toolName,
          input: info?.input,
          error: new Error(resultContent),
          providerExecuted: true,
        })
      } else {
        events.push({
          type: "tool-result",
          toolCallId: parentToolUseId,
          toolName,
          output: {
            title: toolName,
            output: resultContent,
            metadata: {},
          },
          input: info?.input,
          providerExecuted: true,
        })
      }
      state.toolCalls.delete(parentToolUseId)
    }

    // Format 2: Content blocks with tool_result type (standard Anthropic API pattern)
    const message = asRecord(msg.message)
    const content = Array.isArray(message?.content) ? message.content : []

    for (const block of content) {
      const item = asRecord(block)
      if (!item) continue
      const blockType = asString(item.type)

      if (blockType === "tool_result") {
        const toolUseId = asString(item.tool_use_id) ?? ""
        const info = state.toolCalls.get(toolUseId)
        const toolName = info?.name ?? "tool"
        const resultContent = extractToolResultContent(item.content)
        const isError = asBoolean(item.is_error) ?? false

        if (isError) {
          events.push({
            type: "tool-error",
            toolCallId: toolUseId,
            toolName,
            input: info?.input,
            error: new Error(resultContent),
            providerExecuted: true,
          })
        } else {
          events.push({
            type: "tool-result",
            toolCallId: toolUseId,
            toolName,
            output: {
              title: toolName,
              output: resultContent,
              metadata: {},
            },
            input: info?.input,
            providerExecuted: true,
          })
        }
        state.toolCalls.delete(toolUseId)
      }
    }

    return events
  }

  if (type === "tool_progress" || type === "tool_use_summary") {
    const summary = asString(msg.summary)
    const errorText = type === "tool_use_summary" ? readToolError(msg) : undefined
    const outputText = summary ?? (errorText ? "Tool failed." : "Tool completed.")
    const toolIds = getToolIds(msg, state)

    for (const toolId of toolIds) {
      const info = state.toolCalls.get(toolId)
      const rawToolName = asString(msg.tool_name) ?? info?.name ?? "tool"
      const toolName = normalizeToolName(rawToolName)

      if (type !== "tool_use_summary") continue

      if (errorText) {
        events.push({
          type: "tool-error",
          toolCallId: toolId,
          toolName,
          input: info?.input,
          error: new Error(errorText),
          providerExecuted: true,
        })
        state.toolCalls.delete(toolId)
        continue
      }

      const meta = summary ? { summary } : {}
      events.push({
        type: "tool-result",
        toolCallId: toolId,
        toolName,
        output: {
          title: toolName,
          output: outputText,
          metadata: meta,
        },
        input: info?.input,
        providerExecuted: true,
      })
      state.toolCalls.delete(toolId)
    }

    return events
  }

  return events
}

function readSessionId(msg: SDKMessage): string | undefined {
  if (asString(msg.type) === "system" && asString(msg.subtype) === "init") {
    return asString(msg.session_id) ?? asString(msg.sessionId)
  }
  return asString(msg.session_id) ?? asString(msg.sessionId)
}

function readUsage(msg: SDKMessage): { usage: LanguageModelV2Usage; metadata?: SharedV2ProviderMetadata } | undefined {
  const message = asRecord(msg.message)
  const raw = asRecord(message?.usage) ?? asRecord(msg.usage)
  if (!raw) return undefined

  const input = asNumber(raw.input_tokens)
  const output = asNumber(raw.output_tokens)
  const cacheRead = asNumber(raw.cache_read_input_tokens)
  const cacheWrite = asNumber(raw.cache_creation_input_tokens)
  const thinking = asNumber(raw.thinking_tokens)

  const usage: LanguageModelV2Usage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input !== undefined && output !== undefined ? input + output : undefined,
    reasoningTokens: thinking,
    cachedInputTokens: cacheRead,
  }

  const meta: Record<string, number> = {}
  if (cacheRead !== undefined) meta.cacheReadInputTokens = cacheRead
  if (cacheWrite !== undefined) meta.cacheCreationInputTokens = cacheWrite
  if (thinking !== undefined) meta.thinkingTokens = thinking

  return {
    usage,
    metadata: Object.keys(meta).length > 0 ? { "claude-agent-sdk": meta } : undefined,
  }
}

// Read usage from 'result' messages which have a different format than 'assistant' messages
// Result format: { usage: { input_tokens, output_tokens, ... }, modelUsage: { [model]: {...} } }
function readResultUsage(
  msg: SDKMessage,
): { usage: LanguageModelV2Usage; metadata?: SharedV2ProviderMetadata } | undefined {
  // Try direct usage field first (result message format)
  const raw = asRecord(msg.usage)
  if (!raw) return undefined

  const input = asNumber(raw.input_tokens)
  const output = asNumber(raw.output_tokens)
  const cacheRead = asNumber(raw.cache_read_input_tokens)
  const cacheWrite = asNumber(raw.cache_creation_input_tokens)
  const thinking = asNumber(raw.thinking_tokens)

  const usage: LanguageModelV2Usage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input !== undefined && output !== undefined ? input + output : undefined,
    reasoningTokens: thinking,
    cachedInputTokens: cacheRead,
  }

  const meta: Record<string, number> = {}
  if (cacheRead !== undefined) meta.cacheReadInputTokens = cacheRead
  if (cacheWrite !== undefined) meta.cacheCreationInputTokens = cacheWrite
  if (thinking !== undefined) meta.thinkingTokens = thinking

  // Also check modelUsage for per-model stats (includes contextWindow info)
  const modelUsage = asRecord(msg.modelUsage)
  if (modelUsage) {
    // Get first model's usage data
    const models = Object.keys(modelUsage)
    if (models.length > 0) {
      const first = asRecord(modelUsage[models[0]!])
      if (first) {
        // Prefer modelUsage values if they exist (more accurate cumulative data)
        const modelInput = asNumber(first.inputTokens)
        const modelOutput = asNumber(first.outputTokens)
        const modelCacheRead = asNumber(first.cacheReadInputTokens)
        const modelCacheWrite = asNumber(first.cacheCreationInputTokens)
        const modelThinking = asNumber(first.thinkingTokens)

        if (modelInput !== undefined) usage.inputTokens = modelInput
        if (modelOutput !== undefined) usage.outputTokens = modelOutput
        if (modelCacheRead !== undefined) usage.cachedInputTokens = modelCacheRead
        if (modelCacheRead !== undefined) meta.cacheReadInputTokens = modelCacheRead
        if (modelCacheWrite !== undefined) meta.cacheCreationInputTokens = modelCacheWrite
        if (modelThinking !== undefined) {
          usage.reasoningTokens = modelThinking
          meta.thinkingTokens = modelThinking
        }

        // Recalculate total
        if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
          usage.totalTokens = usage.inputTokens + usage.outputTokens
        }
      }
    }
  }

  return {
    usage,
    metadata: Object.keys(meta).length > 0 ? { "claude-agent-sdk": meta } : undefined,
  }
}

function readToolError(msg: SDKMessage): string | undefined {
  const flag = asBoolean(msg.is_error) ?? asBoolean(msg.isError)
  const error = readToolErrorMessage(msg.error)
  if (flag) return error ?? asString(msg.summary) ?? "Tool failed."
  if (error) return error
  return undefined
}

function readToolErrorMessage(value: unknown): string | undefined {
  const direct = asString(value)
  if (direct) return direct
  const record = asRecord(value)
  if (!record) return undefined
  const message = asString(record.message) ?? asString(record.error)
  if (message) return message
  return undefined
}

function readError(msg: SDKMessage): Error {
  const err = asRecord(msg.error)
  const message = asString(err?.message)
  return message ? new Error(message) : new Error("Claude Agent SDK error")
}

function getToolIds(msg: SDKMessage, state: ReturnType<typeof createStreamState>): string[] {
  const single = asString(msg.tool_use_id)
  if (single) return [single]

  const preceding = msg.preceding_tool_use_ids
  if (Array.isArray(preceding)) {
    const ids = preceding.filter((id): id is string => typeof id === "string")
    if (ids.length > 0) return ids
  }

  const keys = Array.from(state.toolCalls.keys())
  if (keys.length > 0) return [keys[keys.length - 1]!]

  return []
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 11)
}

function asRecord(value: unknown): SDKMessage | undefined {
  if (!value || typeof value !== "object") return undefined
  return value as SDKMessage
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value
  return undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value
  return undefined
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  return undefined
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Not valid JSON
    }
  }
  return {}
}

// Extract text content from tool_result content field
// Content can be: string, array of content blocks, or other structures
function extractToolResultContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      const record = asRecord(item)
      if (!record) continue
      if (record.type === "text" && typeof record.text === "string") {
        parts.push(record.text)
      } else if (typeof record.text === "string") {
        parts.push(record.text)
      }
    }
    return parts.join("\n") || JSON.stringify(content)
  }
  if (content && typeof content === "object") {
    return JSON.stringify(content)
  }
  return String(content ?? "")
}
