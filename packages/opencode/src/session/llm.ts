import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import type { LanguageModelV2Prompt } from "@ai-sdk/provider"
import {
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  tool,
  jsonSchema,
} from "ai"
import { mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { PermissionNext } from "@/permission/next"
import { Auth } from "@/auth"
import { ThinkingEffort } from "./thinking-effort"
import type { ClaudeNativeStreamEvent } from "@/provider/native/claude-agent-sdk"
import { streamClaudeNative } from "@/provider/native/claude-agent-sdk"
import { ClaudeAgentSDKSessionStore } from "@/provider/native/session-store"

export namespace LLM {
  const log = Log.create({ service: "llm" })
  const claudeSessionStore = new ClaudeAgentSDKSessionStore()

  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    permission?: PermissionNext.Ruleset
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    toolChoice?: "auto" | "required" | "none"
  }

  type StreamTextPart =
    StreamTextResult<ToolSet, unknown>["fullStream"] extends AsyncIterable<infer Part> ? Part : never
  export type StreamOutput = {
    fullStream: AsyncIterable<StreamTextPart | ClaudeNativeStreamEvent>
    text: Promise<string>
  }

  export async function stream(input: StreamInput) {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const isNativeProvider = input.model.providerID === "claude-agent-sdk"
    const [language, cfg, provider, auth] = await Promise.all([
      // Native providers (claude-agent-sdk) don't use AI SDK language models
      isNativeProvider ? Promise.resolve(null) : Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])
    const isCodex = provider.id === "openai" && auth?.type === "oauth"

    const system = []
    system.push(
      [
        // use agent prompt otherwise provider prompt
        // For Codex sessions, skip SystemPrompt.provider() since it's sent via options.instructions
        ...(input.agent.prompt ? [input.agent.prompt] : isCodex ? [] : SystemPrompt.provider(input.model)),
        // any custom prompt passed into this call
        ...input.system,
        // any custom prompt from last user message
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    const header = system[0]
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const variantKey =
      !input.small && input.model.variants && input.user.variant && input.model.variants[input.user.variant]
        ? input.user.variant
        : null

    // Build thinking options from agent config (if present)
    const thinkingLevel = ThinkingEffort.resolve(input.agent.thinking)

    // Build provider-specific thinking options
    const thinkingOptions = thinkingLevel ? buildThinkingOptions(input.model, thinkingLevel) : {}

    // Build options in two stages to avoid TypeScript type depth limits
    const baseOptions = {
      ...ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: provider.options,
      }),
      ...(input.small ? ProviderTransform.smallOptions(input.model) : {}),
      ...thinkingOptions,
    }
    const options: Record<string, any> = mergeOptions({
      base: baseOptions,
      model: input.model.options,
      agent: input.agent.options,
      variant,
    })
    if (isCodex) {
      options.instructions = SystemPrompt.instructions()
    }

    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options: sanitizeOptions(input.model, options),
      },
    )

    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        headers: {},
      },
    )

    const maxOutputTokens =
      isCodex || provider.id.includes("github-copilot")
        ? undefined
        : ProviderTransform.maxOutputTokens(input.model, options)

    const messages = [
      ...(isCodex
        ? ([
            {
              role: "user",
              content: system.join("\n\n"),
            } as ModelMessage,
          ] as ModelMessage[])
        : system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          )),
      ...input.messages,
    ]

    const tools = await resolveTools(input)

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    // Add passthrough stub for provider-executed tools (Claude Agent SDK)
    // These tools are executed by the provider, not locally - we just need them
    // to pass validation. The execute function should never be called due to providerExecuted flag.
    tools["_providerExecuted"] = tool({
      description: "Passthrough stub for provider-executed tools",
      inputSchema: jsonSchema({ type: "object", additionalProperties: true }),
      execute: async () => ({ output: "Provider executed", title: "Provider Tool", metadata: {} }),
    })

    const toolKeys = Object.keys(tools)
    const activeTools = toolKeys.filter((x) => x !== "invalid" && x !== "_noop" && x !== "_providerExecuted")
    const requestLog = buildRequestLog({
      providerID: input.model.providerID,
      modelID: input.model.id,
      sessionID: input.sessionID,
      agent: input.agent.name,
      variantKey,
      maxOutputTokens,
      thinking: thinkingLevel,
      messageCount: input.messages.length,
      systemCount: system.length,
      toolCount: toolKeys.length,
      activeToolCount: activeTools.length,
    })
    l.debug("stream request", requestLog)

    if (input.model.providerID === "claude-agent-sdk") {
      const sessionKey = input.sessionID
      const sdkSessionId = await claudeSessionStore.get(sessionKey, input.model.id)
      if (sdkSessionId) await claudeSessionStore.touch(sessionKey)

      // When resuming an SDK session, only send the new user message + any per-request system overrides.
      // The SDK session already has the full system prompt and history.
      let promptMessages: ModelMessage[]
      if (sdkSessionId) {
        // Find the last user message (scan backwards to be safe)
        const lastUserMessage = [...messages].reverse().find((m) => m.role === "user")
        // Include any per-request system overrides (from input.user.system or input.system)
        const perRequestSystem = [...input.system, input.user.system].filter(Boolean).join("\n")
        promptMessages = [
          ...(perRequestSystem ? [{ role: "system", content: perRequestSystem } as ModelMessage] : []),
          ...(lastUserMessage ? [lastUserMessage] : []),
        ]
        l.debug("resuming SDK session with minimal prompt", {
          sdkSessionId,
          hasPerRequestSystem: Boolean(perRequestSystem),
          hasUserMessage: Boolean(lastUserMessage),
        })
      } else {
        // First request in session: send full system prompt + history
        promptMessages = messages
      }

      const prompt = ProviderTransform.message(promptMessages, input.model, options) as LanguageModelV2Prompt

      const nativeStream =
        (globalThis as { __opencodeStreamClaudeNative?: typeof streamClaudeNative }).__opencodeStreamClaudeNative ??
        streamClaudeNative

      const native = await nativeStream({
        sessionID: input.sessionID,
        messageID: input.user.id,
        model: input.model,
        prompt,
        abort: input.abort,
        sdkSessionId,
        onSessionId: (id) => void claudeSessionStore.set(sessionKey, id, input.model.id),
        maxThinkingTokens: thinkingLevel?.budgetTokens,
      })
      let textPromise: Promise<string> | undefined

      return {
        fullStream: native.fullStream,
        get text() {
          if (textPromise) return textPromise
          textPromise = (async () => {
            let result = ""
            for await (const part of native.fullStream) {
              if (part.type === "text-delta") {
                result += part.text
              }
            }
            return result
          })()
          return textPromise
        },
      }
    }

    return streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      async experimental_repairToolCall(failed) {
        // Provider-executed tools (from Claude Agent SDK) don't need local validation
        // Map them to a passthrough stub that accepts any input
        // The providerExecuted flag will prevent actual execution
        if (failed.toolCall.providerExecuted) {
          l.info("mapping provider-executed tool to passthrough", {
            tool: failed.toolCall.toolName,
          })
          return {
            ...failed.toolCall,
            toolName: "_providerExecuted",
          }
        }

        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools,
      tools,
      toolChoice: input.toolChoice,
      maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        ...(input.model.providerID.startsWith("opencode")
          ? {
              "x-opencode-project": Instance.project.id,
              "x-opencode-session": input.sessionID,
              "x-opencode-request": input.user.id,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
            }
          : input.model.providerID !== "anthropic"
            ? {
                "User-Agent": `opencode/${Installation.VERSION}`,
              }
            : undefined),
        ...input.model.headers,
        ...headers,
      },
      maxRetries: input.retries ?? 0,
      messages,
      model: wrapLanguageModel({
        model: language!,
        middleware: [
          {
            async transformParams(args) {
              if (args.type === "stream") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
              }
              return args.params
            },
          },
        ],
      }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
    const disabled = PermissionNext.disabled(
      Object.keys(input.tools),
      PermissionNext.merge(input.agent.permission, input.permission ?? []),
    )
    for (const tool of Object.keys(input.tools)) {
      if (input.user.tools?.[tool] === false || disabled.has(tool)) {
        delete input.tools[tool]
      }
    }
    return input.tools
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }

  export type RequestLog = {
    providerID: string
    modelID: string
    sessionID: string
    agent: string
    variant: {
      key: string | null
    }
    maxOutputTokens?: number
    thinking: {
      effort: ThinkingEffort.Level["effort"] | null
      budgetTokens: number | null
    }
    messages: {
      total: number
      system: number
      history: number
    }
    tools: {
      total: number
      active: number
    }
  }

  export function buildRequestLog(input: {
    providerID: string
    modelID: string
    sessionID: string
    agent: string
    variantKey: string | null
    maxOutputTokens?: number
    thinking?: ThinkingEffort.Level
    messageCount: number
    systemCount: number
    toolCount: number
    activeToolCount: number
  }): RequestLog {
    return {
      providerID: input.providerID,
      modelID: input.modelID,
      sessionID: input.sessionID,
      agent: input.agent,
      variant: {
        key: input.variantKey,
      },
      maxOutputTokens: input.maxOutputTokens,
      thinking: {
        effort: input.thinking?.effort ?? null,
        budgetTokens: input.thinking?.budgetTokens ?? null,
      },
      messages: {
        total: input.messageCount + input.systemCount,
        system: input.systemCount,
        history: input.messageCount,
      },
      tools: {
        total: input.toolCount,
        active: input.activeToolCount,
      },
    }
  }

  export function mergeOptions(input: {
    base: Record<string, unknown>
    model?: Record<string, unknown>
    agent?: Record<string, unknown>
    variant?: Record<string, unknown>
  }): Record<string, unknown> {
    const model = input.model ?? {}
    const agent = input.agent ?? {}
    const variant = input.variant ?? {}
    return pipe(input.base, mergeDeep(model), mergeDeep(agent), mergeDeep(variant))
  }

  function buildThinkingOptions(model: Provider.Model, level: ThinkingEffort.Level): Record<string, any> {
    const npm = model.api.npm

    // Provider-specific budget limits (from official API docs)
    // Anthropic: 32,000 max (docs.anthropic.com/en/build-with-claude/extended-thinking)
    // Google Flash: 24,576 max, Pro: 32,768 max (ai.google.dev/gemini-api/docs/thinking)
    const ANTHROPIC_MAX = 32_000
    const GOOGLE_FLASH_MAX = 24_576

    // Anthropic: thinking.type + budgetTokens
    // Note: effort requires beta header which proxied providers (like opencode) may not support
    if (npm === "@ai-sdk/anthropic") {
      const budget = Math.min(level.budgetTokens, ANTHROPIC_MAX)
      return {
        thinking: { type: "enabled" as const, budgetTokens: budget },
      }
    }

    // Bedrock with Anthropic models: reasoningConfig
    if (npm === "@ai-sdk/amazon-bedrock" && model.api.id.includes("anthropic")) {
      const budget = Math.min(level.budgetTokens, ANTHROPIC_MAX)
      return {
        reasoningConfig: { type: "enabled" as const, budgetTokens: budget },
      }
    }

    // OpenAI: reasoningEffort (budgetTokens not supported)
    if (npm === "@ai-sdk/openai" || npm === "@ai-sdk/azure") {
      return {
        reasoningEffort: level.effort,
      }
    }

    // GitHub Copilot: reasoningEffort with summary
    if (npm === "@ai-sdk/github-copilot") {
      return {
        reasoningEffort: level.effort,
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      }
    }

    // Google: thinkingConfig with budget or level
    // Note: Google API treats "high" specially with thinkingLevel, while lower
    // efforts use explicit token budgets via thinkingBudget
    if (npm === "@ai-sdk/google" || npm === "@ai-sdk/google-vertex") {
      // High effort uses thinkingLevel, others use budget
      if (level.effort === "high") {
        return {
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: "high",
          },
        }
      }
      const budget = Math.min(level.budgetTokens, GOOGLE_FLASH_MAX)
      return {
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: budget,
        },
      }
    }

    // OpenRouter: reasoning.effort
    if (npm === "@openrouter/ai-sdk-provider") {
      return {
        reasoning: { effort: level.effort },
      }
    }

    // Unknown provider - return empty (no thinking support)
    return {}
  }

  /**
   * Sanitize provider options to handle provider-specific quirks.
   * For example, Gemini doesn't support both thinkingLevel and thinkingBudget together.
   */
  function sanitizeOptions(model: Provider.Model, options: Record<string, any>): Record<string, any> {
    const npm = model.api.npm

    // Google/Gemini: Cannot have both thinkingLevel and thinkingBudget
    // Prefer thinkingLevel (effort setting) over thinkingBudget
    if (npm === "@ai-sdk/google" || npm === "@ai-sdk/google-vertex") {
      if (options.thinkingConfig?.thinkingLevel !== undefined && options.thinkingConfig?.thinkingBudget !== undefined) {
        delete options.thinkingConfig.thinkingBudget
      }
    }

    return options
  }
}
