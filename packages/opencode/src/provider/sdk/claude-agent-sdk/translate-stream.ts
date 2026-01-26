import type {
  JSONValue,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
  SharedV2ProviderMetadata,
} from "@ai-sdk/provider"
import { generateId } from "@ai-sdk/provider-utils"
import * as ToolMetadataRegistry from "./tool-metadata-registry"

type SDKMessage = Record<string, unknown>

type CacheInfo = {
  read?: number
  write?: number
}

type StreamTransformOptions = {
  onSessionId?: (id: string) => void
  onUsage?: (usage: LanguageModelV2Usage, metadata?: SharedV2ProviderMetadata) => void
  abortSignal?: AbortSignal
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

function normalizeToolName(name: string): string {
  return SDK_TOOL_NAME_MAP[name] ?? name
}

export function createSDKStreamTransformer(
  sdkStream: AsyncIterable<SDKMessage>,
  options: StreamTransformOptions,
): ReadableStream<LanguageModelV2StreamPart> {
  const usage: LanguageModelV2Usage = {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
  }

  const state = {
    textId: undefined as string | undefined,
    textOpen: false,
    usage,
    cache: {
      read: undefined as number | undefined,
      write: undefined as number | undefined,
    },
  }

  const toolState = {
    calls: new Map<string, { name?: string; input?: string }>(),
    emitted: new Set<string>(),
    completed: new Set<string>(),
  }

  const registerToolCall = (toolId: string, name?: string, input?: string) => {
    const existing = toolState.calls.get(toolId) ?? {}
    toolState.calls.set(toolId, {
      name: name ?? existing.name,
      input: input ?? existing.input,
    })
  }

  const emitToolInputStart = (
    controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
    toolId: string,
    toolName: string,
  ) => {
    if (toolState.emitted.has(toolId)) return
    // Emit tool-input-start so the processor creates a ToolPart entry
    controller.enqueue({
      type: "tool-input-start",
      id: toolId,
      toolName,
    } as LanguageModelV2StreamPart)
  }

  const emitToolCall = (
    controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
    toolId: string,
    toolName: string,
    input: string,
    providerExecuted: boolean,
    metadata?: SharedV2ProviderMetadata,
  ) => {
    if (toolState.emitted.has(toolId)) return
    // First emit tool-input-start so processor creates the ToolPart entry
    emitToolInputStart(controller, toolId, toolName)
    toolState.emitted.add(toolId)
    controller.enqueue({
      type: "tool-call",
      toolCallId: toolId,
      toolName,
      input,
      providerExecuted,
      providerMetadata: metadata,
    })
  }

  const startText = (controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>) => {
    if (state.textOpen && state.textId) return state.textId
    const id = generateId()
    state.textId = id
    state.textOpen = true
    controller.enqueue({ type: "text-start", id })
    return id
  }

  const closeText = (controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>) => {
    if (!state.textOpen || !state.textId) return
    controller.enqueue({ type: "text-end", id: state.textId })
    state.textOpen = false
    state.textId = undefined
  }

  const updateUsage = (raw: unknown) => {
    const info = mapUsage(raw)
    if (!info) return
    state.usage = info.usage
    if (info.cache.read !== undefined) state.cache.read = info.cache.read
    if (info.cache.write !== undefined) state.cache.write = info.cache.write
    options.onUsage?.(info.usage, info.metadata)
  }

  return new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      void (async () => {
        for await (const message of sdkStream) {
          if (options.abortSignal?.aborted) {
            closeText(controller)
            controller.enqueue({
              type: "finish",
              usage: state.usage,
              finishReason: "other",
              providerMetadata: toProviderMetadata(state.cache),
            })
            controller.close()
            return
          }

          const msg = asRecord(message)
          if (!msg) continue

          const type = asString(msg.type)
          if (!type) continue

          if (type === "system") {
            handleSystem(msg, controller, options)
            continue
          }

          if (type === "partial") {
            handlePartial(msg, controller, startText)
            continue
          }

          if (type === "assistant") {
            const skipText = state.textOpen
            handleAssistant(msg, controller, closeText, skipText, registerToolCall, emitToolCall)
            updateUsage(readUsage(msg))
            continue
          }

          if (type === "error") {
            const err = readError(msg)
            controller.enqueue({ type: "error", error: err })
            controller.close()
            return
          }

          // Handle user messages with tool_result blocks (SDK-executed tools report results this way)
          if (type === "user") {
            handleUserToolResults(msg, controller, toolState, registerToolCall, emitToolCall)
            continue
          }

          // Handle SDK tool execution events (when SDK runs tools itself)
          if (type === "tool_progress") {
            const toolName = normalizeToolName(asString(msg.tool_name) ?? "tool")
            const toolId = asString(msg.tool_use_id) ?? generateId()
            const elapsed = asNumber(msg.elapsed_time_seconds)
            registerToolCall(toolId, toolName)
            const info = toolState.calls.get(toolId)
            const input = info?.input ?? "{}"
            emitToolCall(
              controller,
              toolId,
              toolName,
              input,
              true,
              toolMetadata({ toolUseId: toolId, toolName, elapsedSeconds: elapsed }),
            )
            continue
          }

          if (type === "tool_use_summary") {
            const summary = asString(msg.summary)
            const errorText = readToolError(msg)
            const ids = readToolUseIds(msg, toolState)
            const outputText = summary ?? (errorText ? "Tool failed." : "Tool completed.")
            for (const toolId of ids) {
              if (toolState.completed.has(toolId)) continue
              const info = toolState.calls.get(toolId)
              const toolName = normalizeToolName(info?.name ?? "tool")
              const input = info?.input ?? "{}"
              emitToolCall(
                controller,
                toolId,
                toolName,
                input,
                true,
                toolMetadata({ toolUseId: toolId, toolName, summary, error: errorText }),
              )

              if (errorText) {
                controller.enqueue({
                  type: "tool-error",
                  toolCallId: toolId,
                  toolName,
                  input,
                  error: new Error(errorText),
                  providerExecuted: true,
                  providerMetadata: toolMetadata({ toolUseId: toolId, toolName, summary, error: errorText }),
                } as unknown as LanguageModelV2StreamPart)
                toolState.completed.add(toolId)
                toolState.calls.delete(toolId)
                continue
              }

              // Retrieve stored metadata from MCP tool execution (e.g., sessionId for Task tool)
              const parsedInput = (() => {
                try {
                  return JSON.parse(input)
                } catch {
                  return {}
                }
              })()
              const stored = ToolMetadataRegistry.retrieve(toolName, parsedInput)

              const output = {
                title: stored?.title ?? toolName,
                output: outputText,
                metadata: {
                  summary,
                  toolUseId: toolId,
                  ...(stored?.metadata ?? {}),
                },
              }
              controller.enqueue({
                type: "tool-result",
                toolCallId: toolId,
                toolName,
                result: output,
                output,
                providerExecuted: true,
                providerMetadata: toolMetadata({ toolUseId: toolId, toolName, summary }),
              } as unknown as LanguageModelV2StreamPart)
              toolState.completed.add(toolId)
              toolState.calls.delete(toolId)
            }
            continue
          }
        }

        closeText(controller)
        controller.enqueue({
          type: "finish",
          usage: state.usage,
          finishReason: "stop",
          providerMetadata: toProviderMetadata(state.cache),
        })
        controller.close()
      })().catch((error) => {
        controller.enqueue({ type: "error", error })
        controller.close()
      })
    },
  })
}

function handleSystem(
  msg: SDKMessage,
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
  options: StreamTransformOptions,
) {
  const subtype = asString(msg.subtype)
  if (subtype !== "init") return
  const id = asString(msg.session_id) ?? asString(msg.sessionId)
  if (!id) return
  options.onSessionId?.(id)
  controller.enqueue({
    type: "response-metadata",
    id,
    timestamp: new Date(),
  })
}

function handlePartial(
  msg: SDKMessage,
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
  startText: (controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>) => string,
) {
  const delta = asString(msg.delta) ?? asString(msg.text)
  if (!delta) return
  const id = startText(controller)
  controller.enqueue({ type: "text-delta", id, delta })
}

function handleUserToolResults(
  msg: SDKMessage,
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
  toolState: {
    calls: Map<string, { name?: string; input?: string }>
    emitted: Set<string>
    completed: Set<string>
  },
  registerToolCall: (toolId: string, name?: string, input?: string) => void,
  emitToolCall: (
    controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
    toolId: string,
    toolName: string,
    input: string,
    providerExecuted: boolean,
    metadata?: SharedV2ProviderMetadata,
  ) => void,
) {
  const message = asRecord(msg.message)
  const content = Array.isArray(message?.content) ? message?.content : []

  for (const block of content) {
    const item = asRecord(block)
    if (!item) continue
    const type = asString(item.type)
    if (type !== "tool_result") continue

    const toolId = asString(item.tool_use_id)
    if (!toolId) continue
    if (toolState.completed.has(toolId)) continue

    const isError = asBoolean(item.is_error) ?? false
    const resultContent = item.content

    // Extract text output from result content
    const outputText = extractToolResultText(resultContent)
    const info = toolState.calls.get(toolId)
    const toolName = normalizeToolName(info?.name ?? "tool")
    const input = info?.input ?? "{}"

    // Make sure we've emitted the tool-call first
    emitToolCall(controller, toolId, toolName, input, true, toolMetadata({ toolUseId: toolId, toolName }))

    if (isError) {
      controller.enqueue({
        type: "tool-error",
        toolCallId: toolId,
        toolName,
        input,
        error: new Error(outputText || "Tool execution failed"),
        providerExecuted: true,
        providerMetadata: toolMetadata({ toolUseId: toolId, toolName, error: outputText }),
      } as unknown as LanguageModelV2StreamPart)
    } else {
      // Retrieve stored metadata from MCP tool execution
      const parsedInput = (() => {
        try {
          return JSON.parse(input)
        } catch {
          return {}
        }
      })()
      const stored = ToolMetadataRegistry.retrieve(toolName, parsedInput)

      const output = {
        title: stored?.title ?? toolName,
        output: outputText || "Tool completed.",
        metadata: {
          toolUseId: toolId,
          ...(stored?.metadata ?? {}),
        },
      }
      controller.enqueue({
        type: "tool-result",
        toolCallId: toolId,
        toolName,
        result: output,
        output,
        providerExecuted: true,
        providerMetadata: toolMetadata({ toolUseId: toolId, toolName }),
      } as unknown as LanguageModelV2StreamPart)
    }

    toolState.completed.add(toolId)
    toolState.calls.delete(toolId)
  }
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const texts: string[] = []
  for (const item of content) {
    const record = asRecord(item)
    if (!record) continue
    if (record.type === "text" && typeof record.text === "string") {
      texts.push(record.text)
    }
  }
  return texts.join("\n")
}

function handleAssistant(
  msg: SDKMessage,
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
  closeText: (controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>) => void,
  skipText: boolean,
  registerToolCall: (toolId: string, name?: string, input?: string) => void,
  emitToolCall: (
    controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
    toolId: string,
    toolName: string,
    input: string,
    providerExecuted: boolean,
    metadata?: SharedV2ProviderMetadata,
  ) => void,
) {
  const message = asRecord(msg.message)
  const content = Array.isArray(message?.content) ? message?.content : []

  for (const block of content) {
    const item = asRecord(block)
    if (!item) continue
    const type = asString(item.type)
    if (!type) continue

    if (type === "text") {
      if (skipText) continue
      const text = asString(item.text)
      if (!text) continue
      const id = generateId()
      controller.enqueue({ type: "text-start", id })
      controller.enqueue({ type: "text-delta", id, delta: text })
      controller.enqueue({ type: "text-end", id })
      continue
    }

    if (type === "tool_use") {
      const toolId = asString(item.id) ?? generateId()
      const toolName = normalizeToolName(asString(item.name) ?? "tool")
      const input = toJson(item.input)
      registerToolCall(toolId, toolName, input)
      // SDK executes all tools (permissionMode: "bypassPermissions"), so providerExecuted: true
      emitToolCall(controller, toolId, toolName, input, true, toolMetadata({ toolUseId: toolId, toolName }))
      continue
    }

    if (type === "thinking") {
      const text = asString(item.thinking)
      if (!text) continue
      const id = generateId()
      controller.enqueue({ type: "reasoning-start", id })
      controller.enqueue({ type: "reasoning-delta", id, delta: text })
      controller.enqueue({ type: "reasoning-end", id })
    }
  }

  if (skipText) closeText(controller)
}

function readUsage(msg: SDKMessage): SDKMessage | undefined {
  const message = asRecord(msg.message)
  const usage = asRecord(message?.usage)
  if (usage) return usage
  const alt = asRecord(msg.usage)
  if (alt) return alt
  return undefined
}

function mapUsage(raw: unknown):
  | {
      usage: LanguageModelV2Usage
      cache: CacheInfo
      metadata?: SharedV2ProviderMetadata
    }
  | undefined {
  const usage = asRecord(raw)
  if (!usage) return undefined
  const input = asNumber(usage.input_tokens)
  const output = asNumber(usage.output_tokens)
  const total = asNumber(usage.total_tokens)
  const reasoning = asNumber(usage.reasoning_tokens)
  const cacheRead = asNumber(usage.cache_read_input_tokens)
  const cacheWrite = asNumber(usage.cache_creation_input_tokens)

  const result: LanguageModelV2Usage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    reasoningTokens: reasoning,
    cachedInputTokens: cacheRead,
  }

  const cache = {
    read: cacheRead,
    write: cacheWrite,
  }

  return { usage: result, cache, metadata: toProviderMetadata(cache) }
}

function toProviderMetadata(cache: CacheInfo): SharedV2ProviderMetadata | undefined {
  const meta: Record<string, number> = {}
  if (cache.read !== undefined) meta.cacheReadInputTokens = cache.read
  if (cache.write !== undefined) meta.cacheCreationInputTokens = cache.write
  if (Object.keys(meta).length === 0) return undefined
  return { "claude-agent-sdk": meta }
}

function toolMetadata(data: Record<string, unknown>): SharedV2ProviderMetadata {
  return { "claude-agent-sdk": data as Record<string, JSONValue> }
}

function readToolUseIds(
  msg: SDKMessage,
  toolState: { calls: Map<string, { name?: string; input?: string }> },
): string[] {
  const record = asRecord(msg)
  if (!record) return []
  const ids = asStringArray(record.preceding_tool_use_ids)
  if (ids.length > 0) return ids
  const direct = asString(record.tool_use_id)
  if (direct) return [direct]
  const keys = Array.from(toolState.calls.keys())
  if (keys.length === 0) return []
  const last = keys[keys.length - 1]
  if (!last) return []
  return [last]
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
  if (message) return new Error(message)
  return new Error("Claude Agent SDK error")
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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function toJson(value: unknown): string {
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
