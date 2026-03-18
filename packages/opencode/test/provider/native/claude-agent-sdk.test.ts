import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { LanguageModelV2Prompt } from "@ai-sdk/provider"
import type { Provider } from "../../../src/provider/provider"
import { ModelID, ProviderID } from "../../../src/provider/schema"

type SDKMessage = Record<string, unknown>

const state = {
  queries: [] as Array<{ prompt: string; options: unknown }>,
  sent: [] as Array<unknown>,
  closed: 0,
  messages: [] as SDKMessage[],
  queryError: undefined as Error | undefined,
  toolInput: undefined as unknown,
  sessionId: undefined as string | undefined,
  abort: undefined as AbortController | undefined,
  abortAfter: undefined as number | undefined,
}

const queryFactory = (prompt: string, options: unknown) => {
  state.queries.push({ prompt, options })

  if (state.queryError) {
    throw state.queryError
  }

  const iterator = async function* () {
    const count = { value: 0 }
    for (const msg of state.messages) {
      count.value += 1
      if (state.abort && state.abortAfter === count.value) {
        state.abort.abort()
      }
      yield msg
    }
  }

  const close = mock(() => {
    state.closed += 1
  })

  return Object.assign(iterator(), { close })
}

import type { ClaudeNativeStreamEvent } from "../../../src/provider/native/claude-agent-sdk"
const setupMocks = () => {
  mock.module("../../../src/provider/native/tool-bridge", () => ({
    createOpenCodeToolsServer: async (input: unknown) => {
      state.toolInput = input
      return { type: "sdk", name: "opencode", instance: {} }
    },
    DISABLED_SDK_TOOLS: ["Task"],
  }))
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query: (params: { prompt: string; options?: unknown }) => queryFactory(params.prompt, params.options),
  }))
}

const loadStream = async () => {
  const mod = (await import(
    new URL(`../../../src/provider/native/claude-agent-sdk.ts?native-test-v1=${Date.now()}`, import.meta.url).href
  )) as typeof import("../../../src/provider/native/claude-agent-sdk")
  return mod.streamClaudeNative
}

const model: Provider.Model = {
  id: ModelID.make("claude-sonnet-4-5"),
  providerID: ProviderID.make("claude-agent-sdk"),
  name: "Claude Sonnet 4.5",
  family: "claude-4",
  api: {
    id: "claude-sonnet-4-5",
    url: "",
    npm: "@anthropic-ai/claude-agent-sdk",
  },
  status: "active",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: true,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200000, output: 64000 },
  options: {},
  headers: {},
  release_date: "2025-09-29",
  variants: {},
}

const prompt = (text: string): LanguageModelV2Prompt => [
  {
    role: "user",
    content: [{ type: "text", text }],
  },
]

async function collect(stream: AsyncIterable<ClaudeNativeStreamEvent>): Promise<ClaudeNativeStreamEvent[]> {
  const events: ClaudeNativeStreamEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

describe("streamClaudeNative", () => {
  beforeEach(() => {
    setupMocks()
    state.queries = []
    state.sent = []
    state.closed = 0
    state.messages = []
    state.queryError = undefined
    state.toolInput = undefined
    state.sessionId = undefined
    state.abort = undefined
    state.abortAfter = undefined
  })

  test("creates a query and streams mapped events", async () => {
    const streamClaudeNative = await loadStream()
    state.messages = [
      { type: "system", subtype: "init", session_id: "sess_123" },
      { type: "partial", delta: "Hello" },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: " World" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]

    const controller = new AbortController()
    let capturedSessionId: string | undefined

    const result = await streamClaudeNative({
      sessionID: "ses_test",
      model,
      prompt: prompt("Hi"),
      abort: controller.signal,
      onSessionId: (id) => {
        capturedSessionId = id
      },
    })

    const events = await collect(result.fullStream)

    expect(state.queries.length).toBe(1)
    expect(state.queries[0]?.prompt).toContain("Hi")
    expect(capturedSessionId).toBe("sess_123")
    expect(state.closed).toBe(1)

    const textDeltas = events.filter((e) => e.type === "text-delta")
    expect(textDeltas.length).toBeGreaterThan(0)

    const finish = events.find((e) => e.type === "finish")
    expect(finish?.type).toBe("finish")
    if (finish?.type === "finish") {
      expect(finish.usage.inputTokens).toBe(10)
      expect(finish.usage.outputTokens).toBe(5)
    }
  })

  test("emits tool events from the sdk stream", async () => {
    const streamClaudeNative = await loadStream()
    state.messages = [
      {
        type: "assistant",
        session_id: "sess_123",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "Bash",
              input: { command: "echo hi" },
            },
          ],
        },
      },
      {
        type: "tool_use_summary",
        summary: "Done",
        preceding_tool_use_ids: ["tool_1"],
      },
    ]

    const controller = new AbortController()

    const result = await streamClaudeNative({
      sessionID: "ses_test",
      model,
      prompt: prompt("Hi"),
      abort: controller.signal,
    })

    const events = await collect(result.fullStream)
    const start = events.find((item) => item.type === "tool-input-start")
    const call = events.find((item) => item.type === "tool-call")
    const resultEvent = events.find((item) => item.type === "tool-result")

    expect(start?.type).toBe("tool-input-start")
    if (start?.type === "tool-input-start") {
      expect(start.toolName).toBe("bash")
    }

    expect(call?.type).toBe("tool-call")
    if (call?.type === "tool-call") {
      expect(call.toolCallId).toBe("tool_1")
      expect(call.toolName).toBe("bash")
      expect(call.input).toEqual({ command: "echo hi" })
    }

    expect(resultEvent?.type).toBe("tool-result")
    if (resultEvent?.type === "tool-result") {
      expect(resultEvent.toolCallId).toBe("tool_1")
    }
  })

  test("emits tool-result when tool_use_summary lacks summary", async () => {
    const streamClaudeNative = await loadStream()
    state.messages = [
      {
        type: "assistant",
        session_id: "sess_123",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool_2",
              name: "mcp__opencode__read",
              input: { path: "file.txt" },
            },
          ],
        },
      },
      {
        type: "tool_use_summary",
        preceding_tool_use_ids: ["tool_2"],
      },
    ]

    const controller = new AbortController()

    const result = await streamClaudeNative({
      sessionID: "ses_test",
      model,
      prompt: prompt("Hi"),
      abort: controller.signal,
    })

    const events = await collect(result.fullStream)
    const resultEvent = events.find((item) => item.type === "tool-result")

    expect(resultEvent?.type).toBe("tool-result")
    if (resultEvent?.type === "tool-result") {
      expect(resultEvent.toolName).toBe("read")
      expect(resultEvent.input).toEqual({ path: "file.txt" })
      expect(resultEvent.output.output).toBe("Tool completed.")
    }
  })

  test("emits tool-error when tool_use_summary reports error", async () => {
    const streamClaudeNative = await loadStream()
    state.messages = [
      {
        type: "assistant",
        session_id: "sess_123",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool_3",
              name: "mcp__opencode__bash",
              input: { command: "false" },
            },
          ],
        },
      },
      {
        type: "tool_use_summary",
        preceding_tool_use_ids: ["tool_3"],
        is_error: true,
        error: { message: "Tool blew up" },
      },
    ]

    const controller = new AbortController()

    const result = await streamClaudeNative({
      sessionID: "ses_test",
      model,
      prompt: prompt("Hi"),
      abort: controller.signal,
    })

    const events = await collect(result.fullStream)
    const errorEvent = events.find((item) => item.type === "tool-error")
    const resultEvent = events.find((item) => item.type === "tool-result")

    expect(errorEvent?.type).toBe("tool-error")
    if (errorEvent?.type === "tool-error") {
      expect(errorEvent.toolName).toBe("bash")
      expect(errorEvent.input).toEqual({ command: "false" })
      expect((errorEvent.error as Error).message).toBe("Tool blew up")
    }
    expect(resultEvent).toBeUndefined()
  })

  test("resumes when sdkSessionId is provided", async () => {
    const streamClaudeNative = await loadStream()
    state.messages = [{ type: "system", subtype: "init", session_id: "sess_456" }]

    const controller = new AbortController()

    const result = await streamClaudeNative({
      sessionID: "ses_test",
      model,
      prompt: prompt("Hi"),
      abort: controller.signal,
      sdkSessionId: "sdk_456",
    })

    await collect(result.fullStream)

    expect(state.queries.length).toBe(1)
    const options = state.queries[0]?.options as Record<string, unknown>
    expect(options?.resume).toBe("sdk_456")
  })

  test("aborts mid-stream with finish reason other", async () => {
    const streamClaudeNative = await loadStream()
    const controller = new AbortController()
    state.abort = controller
    state.abortAfter = 1

    state.messages = [
      { type: "system", subtype: "init", session_id: "sess_123" },
      { type: "partial", delta: "Hello" },
      { type: "partial", delta: " World" },
    ]

    const result = await streamClaudeNative({
      sessionID: "ses_test",
      model,
      prompt: prompt("Hi"),
      abort: controller.signal,
    })

    const events = await collect(result.fullStream)
    const finish = events.find((item) => item.type === "finish")

    expect(finish?.type).toBe("finish")
    if (finish?.type === "finish") {
      expect(finish.finishReason).toBe("other")
    }
  })

  test("emits error when query throws", async () => {
    const streamClaudeNative = await loadStream()
    state.queryError = new Error("Query failed")

    const controller = new AbortController()

    const result = await streamClaudeNative({
      sessionID: "ses_test",
      model,
      prompt: prompt("Hi"),
      abort: controller.signal,
    })

    const events = await collect(result.fullStream)
    const errorEvent = events.find((item) => item.type === "error")

    expect(errorEvent?.type).toBe("error")
  })

  test("extracts usage from result messages", async () => {
    const streamClaudeNative = await loadStream()
    state.messages = [
      { type: "system", subtype: "init", session_id: "sess_123" },
      { type: "partial", delta: "Hello" },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "World" }],
          // Note: no usage in assistant message
        },
      },
      {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 1500,
          output_tokens: 300,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        },
        modelUsage: {
          "claude-sonnet-4-5": {
            inputTokens: 1500,
            outputTokens: 300,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 50,
            contextWindow: 200000,
          },
        },
        total_cost_usd: 0.01,
      },
    ]

    const controller = new AbortController()

    const result = await streamClaudeNative({
      sessionID: "ses_test",
      model,
      prompt: prompt("Hi"),
      abort: controller.signal,
    })

    const events = await collect(result.fullStream)
    const finish = events.find((e) => e.type === "finish")

    expect(finish?.type).toBe("finish")
    if (finish?.type === "finish") {
      expect(finish.usage.inputTokens).toBe(1500)
      expect(finish.usage.outputTokens).toBe(300)
      expect(finish.usage.cachedInputTokens).toBe(100)
    }
  })

  test("prefers modelUsage data over direct usage in result messages", async () => {
    const streamClaudeNative = await loadStream()
    state.messages = [
      { type: "system", subtype: "init", session_id: "sess_123" },
      {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 100, // Lower values in direct usage
          output_tokens: 50,
        },
        modelUsage: {
          "claude-sonnet-4-5": {
            inputTokens: 2000, // Higher, more accurate cumulative values
            outputTokens: 500,
          },
        },
      },
    ]

    const controller = new AbortController()

    const result = await streamClaudeNative({
      sessionID: "ses_test",
      model,
      prompt: prompt("Hi"),
      abort: controller.signal,
    })

    const events = await collect(result.fullStream)
    const finish = events.find((e) => e.type === "finish")

    expect(finish?.type).toBe("finish")
    if (finish?.type === "finish") {
      // Should use modelUsage values (2000, 500) not direct usage (100, 50)
      expect(finish.usage.inputTokens).toBe(2000)
      expect(finish.usage.outputTokens).toBe(500)
    }
  })

  test("extracts thinking_tokens from assistant message usage", async () => {
    const streamClaudeNative = await loadStream()
    state.messages = [
      { type: "system", subtype: "init", session_id: "sess_123" },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello" }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            thinking_tokens: 200,
            cache_read_input_tokens: 10,
          },
        },
      },
    ]

    const controller = new AbortController()

    const result = await streamClaudeNative({
      sessionID: "ses_test",
      model,
      prompt: prompt("Hi"),
      abort: controller.signal,
    })

    const events = await collect(result.fullStream)
    const finish = events.find((e) => e.type === "finish")

    expect(finish?.type).toBe("finish")
    if (finish?.type === "finish") {
      expect(finish.usage.inputTokens).toBe(100)
      expect(finish.usage.outputTokens).toBe(50)
      expect(finish.usage.reasoningTokens).toBe(200)
      expect(finish.usage.cachedInputTokens).toBe(10)
      expect(finish.providerMetadata?.["claude-agent-sdk"]?.thinkingTokens).toBe(200)
    }
  })

  test("extracts thinkingTokens from modelUsage in result messages", async () => {
    const streamClaudeNative = await loadStream()
    state.messages = [
      { type: "system", subtype: "init", session_id: "sess_123" },
      {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          thinking_tokens: 150, // Direct usage thinking tokens
        },
        modelUsage: {
          "claude-sonnet-4-5": {
            inputTokens: 1000,
            outputTokens: 300,
            thinkingTokens: 500, // Model usage should be preferred
            cacheReadInputTokens: 50,
          },
        },
      },
    ]

    const controller = new AbortController()

    const result = await streamClaudeNative({
      sessionID: "ses_test",
      model,
      prompt: prompt("Hi"),
      abort: controller.signal,
    })

    const events = await collect(result.fullStream)
    const finish = events.find((e) => e.type === "finish")

    expect(finish?.type).toBe("finish")
    if (finish?.type === "finish") {
      // Should use modelUsage values
      expect(finish.usage.inputTokens).toBe(1000)
      expect(finish.usage.outputTokens).toBe(300)
      expect(finish.usage.reasoningTokens).toBe(500)
      expect(finish.usage.cachedInputTokens).toBe(50)
      expect(finish.providerMetadata?.["claude-agent-sdk"]?.thinkingTokens).toBe(500)
    }
  })
})
