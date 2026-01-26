import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2Usage,
  SharedV2ProviderMetadata,
} from "@ai-sdk/provider"
import { ClaudeAgentSDKSessionStore } from "./session-store"
import { translateToSDKPrompt } from "./translate-prompt"
import { createSDKStreamTransformer } from "./translate-stream"
import { mapModelId } from "./models"
import { createOpenCodeToolsServer, DISABLED_SDK_TOOLS } from "./tool-bridge"
import { Provider } from "../../provider"

type SDKQueryOptions = {
  model: string
  resume?: string
  maxThinkingTokens?: number
  includePartialMessages?: boolean
  permissionMode?: string
  settingSources?: string[]
  workingDirectory?: string
  disallowedTools?: string[]
  mcpServers?: Record<string, unknown>
}

type SDKQueryInput = {
  prompt: ReturnType<typeof translateToSDKPrompt>
  options: SDKQueryOptions
}

type SDKQuery = (input: SDKQueryInput) => AsyncIterable<Record<string, unknown>>

const loadQuery = async (): Promise<SDKQuery> => {
  const mod = (await import("@anthropic-ai/claude-agent-sdk")) as {
    query?: SDKQuery
  }
  if (!mod.query) {
    throw new Error("Claude Agent SDK not available")
  }
  return mod.query
}

export class ClaudeAgentSDKLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2"
  readonly provider = "claude-agent-sdk"
  readonly supportedUrls = {
    "image/*": [/^https?:\/\/.*$/],
    "application/pdf": [/^https?:\/\/.*$/],
  }

  constructor(
    readonly modelId: string,
    private sessionStore: ClaudeAgentSDKSessionStore,
  ) {}

  async doStream(options: LanguageModelV2CallOptions) {
    const providerOptions = readProviderOptions(options.providerOptions)
    const sessionKey = readSessionId(providerOptions) ?? "default"
    const messageID = readMessageId(providerOptions)
    const existingSessionId = await this.sessionStore.get(sessionKey, this.modelId)
    if (existingSessionId) await this.sessionStore.touch(sessionKey)

    const sdkPrompt = translateToSDKPrompt(options.prompt)
    const model = await Provider.getModel(this.provider, this.modelId)
    const opencodeServer = await createOpenCodeToolsServer({
      sessionID: sessionKey,
      messageID,
      model,
      abort: options.abortSignal,
    })

    const sdkOptions: SDKQueryOptions = {
      model: mapModelId(this.modelId),
      includePartialMessages: true,
      permissionMode: "bypassPermissions", // Let SDK execute tools without prompting
      settingSources: ["user", "project"], // Load skills from ~/.claude and .claude
      workingDirectory: process.cwd(),
      disallowedTools: DISABLED_SDK_TOOLS,
      mcpServers: {
        opencode: opencodeServer,
      },
    }

    if (existingSessionId) sdkOptions.resume = existingSessionId

    const budget = readThinkingBudget(providerOptions)
    if (budget !== undefined) sdkOptions.maxThinkingTokens = budget

    const query = await loadQuery()
    const response = query({ prompt: sdkPrompt, options: sdkOptions })

    const stream = createSDKStreamTransformer(response, {
      onSessionId: (id) => void this.sessionStore.set(sessionKey, id, this.modelId),
      abortSignal: options.abortSignal,
    })

    return { stream }
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    const result = await this.doStream(options)
    const reader = result.stream.getReader()

    const content: LanguageModelV2Content[] = []
    const texts = new Map<string, string>()
    const reasoning = new Map<string, string>()

    const usage: LanguageModelV2Usage = {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    }

    const state = {
      finishReason: "unknown" as LanguageModelV2FinishReason,
      usage,
      providerMetadata: undefined as SharedV2ProviderMetadata | undefined,
    }

    while (true) {
      const next = await reader.read()
      if (next.done) break
      const part = next.value
      if (!part) continue

      if (part.type === "text-start") {
        texts.set(part.id, "")
        continue
      }

      if (part.type === "text-delta") {
        const current = texts.get(part.id) ?? ""
        texts.set(part.id, current + part.delta)
        continue
      }

      if (part.type === "text-end") {
        const text = texts.get(part.id)
        if (text !== undefined) content.push({ type: "text", text })
        texts.delete(part.id)
        continue
      }

      if (part.type === "reasoning-start") {
        reasoning.set(part.id, "")
        continue
      }

      if (part.type === "reasoning-delta") {
        const current = reasoning.get(part.id) ?? ""
        reasoning.set(part.id, current + part.delta)
        continue
      }

      if (part.type === "reasoning-end") {
        const text = reasoning.get(part.id)
        if (text !== undefined) content.push({ type: "reasoning", text })
        reasoning.delete(part.id)
        continue
      }

      if (part.type === "tool-call") {
        content.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          providerExecuted: part.providerExecuted,
        })
        continue
      }

      if (part.type === "tool-result") {
        content.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: part.result,
          isError: part.isError,
          providerExecuted: part.providerExecuted,
        })
        continue
      }

      if (part.type === "finish") {
        state.finishReason = part.finishReason
        state.usage = part.usage
        state.providerMetadata = part.providerMetadata
        continue
      }

      if (part.type === "error") {
        throw part.error
      }
    }

    for (const text of texts.values()) {
      content.push({ type: "text", text })
    }

    for (const text of reasoning.values()) {
      content.push({ type: "reasoning", text })
    }

    return {
      content,
      finishReason: state.finishReason,
      usage: state.usage,
      providerMetadata: state.providerMetadata,
      warnings: [],
    }
  }
}

type ProviderOptions = Record<string, unknown> | undefined

function readProviderOptions(input: Record<string, Record<string, unknown>> | undefined): ProviderOptions {
  if (!input) return undefined
  const opts = input["claude-agent-sdk"]
  if (opts && typeof opts === "object") return opts
  return undefined
}

function readSessionId(options: ProviderOptions): string | undefined {
  if (!options) return undefined
  const id = options.sessionId
  if (typeof id === "string" && id.length > 0) return id
  return undefined
}

function readThinkingBudget(options: ProviderOptions): number | undefined {
  if (!options) return undefined
  const thinking = asRecord(options.thinking)
  const budget = thinking?.budgetTokens
  if (typeof budget === "number") return budget
  return undefined
}

function readMessageId(options: ProviderOptions): string | undefined {
  if (!options) return undefined
  const id = options.messageId
  if (typeof id === "string" && id.length > 0) return id
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined
  return value as Record<string, unknown>
}
