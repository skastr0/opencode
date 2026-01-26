import { describe, expect, test } from "bun:test"
import type { LanguageModelV2Prompt, LanguageModelV2StreamPart, SharedV2ProviderMetadata } from "@ai-sdk/provider"
import { translateToSDKPrompt } from "@/provider/sdk/claude-agent-sdk/translate-prompt"
import { createSDKStreamTransformer } from "@/provider/sdk/claude-agent-sdk/translate-stream"
import { ClaudeAgentSDKSessionStore } from "@/provider/sdk/claude-agent-sdk/session-store"

type SDKMessage = Record<string, unknown>

async function readStream(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const reader = stream.getReader()
  const items: LanguageModelV2StreamPart[] = []
  while (true) {
    const next = await reader.read()
    if (next.done) break
    if (!next.value) continue
    items.push(next.value)
  }
  return items
}

async function readPrompt(prompt: ReturnType<typeof translateToSDKPrompt>) {
  if (typeof prompt === "string") return { kind: "string", value: prompt }
  const items = [] as unknown[]
  for await (const item of prompt) {
    items.push(item)
  }
  return { kind: "items", value: items }
}

async function* mockStream(messages: SDKMessage[]) {
  for (const message of messages) {
    yield message
  }
}

describe("Claude Agent SDK", () => {
  describe("translateToSDKPrompt", () => {
    test("simple text returns string", () => {
      const prompt = [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      ] as LanguageModelV2Prompt

      const result = translateToSDKPrompt(prompt)

      expect(result).toBe("Hello")
    })

    test("message with tool results returns async generator", () => {
      const prompt = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-result",
              toolCallId: "tool_1",
              output: { type: "text", value: "ok" },
            },
          ],
        },
      ] as LanguageModelV2Prompt

      const result = translateToSDKPrompt(prompt)
      const isAsync = typeof result === "object" && result !== null && Symbol.asyncIterator in result

      expect(isAsync).toBe(true)
    })

    test("multiple tool results before user message", async () => {
      const prompt = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-result",
              toolCallId: "tool_1",
              output: { type: "text", value: "first" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-result",
              toolCallId: "tool_2",
              output: { type: "text", value: "second" },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "text", text: "Continue" }],
        },
      ] as LanguageModelV2Prompt

      const result = translateToSDKPrompt(prompt)
      const output = await readPrompt(result)

      expect(output.kind).toBe("items")
      expect(output.value).toEqual([
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "first",
        },
        {
          type: "tool_result",
          tool_use_id: "tool_2",
          content: "second",
        },
        {
          type: "user",
          message: {
            role: "user",
            content: "Continue",
          },
        },
      ])
    })

    test("multimodal image content is formatted", async () => {
      const prompt = [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe" },
            {
              type: "file",
              mediaType: "image/png",
              data: "https://example.com/cat.png",
            },
          ],
        },
      ] as LanguageModelV2Prompt

      const result = translateToSDKPrompt(prompt)
      const output = await readPrompt(result)

      expect(output.kind).toBe("items")
      expect(output.value).toEqual([
        {
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "text", text: "Describe" },
              {
                type: "image",
                source: { type: "url", url: "https://example.com/cat.png" },
              },
            ],
          },
        },
      ])
    })

    test("empty prompt returns empty string", () => {
      const result = translateToSDKPrompt([] as LanguageModelV2Prompt)
      expect(result).toBe("")
    })
  })

  describe("createSDKStreamTransformer", () => {
    test("captures session_id from system.init", async () => {
      const captured = { id: undefined as string | undefined }

      const stream = createSDKStreamTransformer(
        mockStream([
          {
            type: "system",
            subtype: "init",
            session_id: "sess_123",
          },
        ]),
        {
          onSessionId: (id) => {
            captured.id = id
          },
        },
      )

      const items = await readStream(stream)

      expect(captured.id).toBe("sess_123")
      expect(items[0]?.type).toBe("response-metadata")
    })

    test("assistant text emits text-start/delta/end", async () => {
      const stream = createSDKStreamTransformer(
        mockStream([
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Hello" }],
            },
          },
        ]),
        {},
      )

      const items = await readStream(stream)
      const start = items.find((item) => item.type === "text-start")
      const delta = items.find((item) => item.type === "text-delta")
      const end = items.find((item) => item.type === "text-end")

      expect(start?.type).toBe("text-start")
      expect(delta?.type).toBe("text-delta")
      expect(end?.type).toBe("text-end")
      if (delta?.type === "text-delta") expect(delta.delta).toBe("Hello")
      if (start?.type === "text-start" && end?.type === "text-end") {
        expect(end.id).toBe(start.id)
      }
      if (start?.type === "text-start" && delta?.type === "text-delta") {
        expect(delta.id).toBe(start.id)
      }
    })

    test("assistant tool_use emits tool-call with providerExecuted false", async () => {
      const stream = createSDKStreamTransformer(
        mockStream([
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tool_abc",
                  name: "Read",
                  input: { path: "/test.ts" },
                },
              ],
            },
          },
        ]),
        {},
      )

      const items = await readStream(stream)
      const tool = items.find((item) => item.type === "tool-call")

      expect(tool?.type).toBe("tool-call")
      if (tool?.type === "tool-call") {
        expect(tool.toolCallId).toBe("tool_abc")
        expect(tool.toolName).toBe("read")
        // SDK executes tools with permissionMode: "bypassPermissions", so providerExecuted: true
        expect(tool.providerExecuted).toBe(true)
        expect(JSON.parse(tool.input)).toEqual({ path: "/test.ts" })
      }
    })

    test("assistant tool_use supports multiple tool calls", async () => {
      const stream = createSDKStreamTransformer(
        mockStream([
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tool_a",
                  name: "Read",
                  input: { path: "/a.ts" },
                },
                {
                  type: "tool_use",
                  id: "tool_b",
                  name: "Bash",
                  input: { command: "ls" },
                },
              ],
            },
          },
          {
            type: "tool_use_summary",
            summary: "Done",
            preceding_tool_use_ids: ["tool_a", "tool_b"],
          },
        ]),
        {},
      )

      const items = await readStream(stream)
      const starts = items.filter((item) => item.type === "tool-input-start")
      const calls = items.filter((item) => item.type === "tool-call")
      const results = items.filter((item) => item.type === "tool-result")

      expect(starts.length).toBe(2)
      expect(calls.length).toBe(2)
      expect(results.length).toBe(2)
    })

    test("tool_progress emits providerExecuted tool-call", async () => {
      const stream = createSDKStreamTransformer(
        mockStream([
          {
            type: "tool_progress",
            tool_use_id: "tool_123",
            tool_name: "Bash",
            parent_tool_use_id: null,
            elapsed_time_seconds: 1,
          },
        ]),
        {},
      )

      const items = await readStream(stream)
      const tool = items.find((item) => item.type === "tool-call")

      expect(tool?.type).toBe("tool-call")
      if (tool?.type === "tool-call") {
        expect(tool.toolCallId).toBe("tool_123")
        expect(tool.toolName).toBe("bash")
        expect(tool.providerExecuted).toBe(true)
      }
    })

    test("tool_use_summary emits tool-result", async () => {
      const stream = createSDKStreamTransformer(
        mockStream([
          {
            type: "tool_progress",
            tool_use_id: "tool_123",
            tool_name: "Bash",
            parent_tool_use_id: null,
            elapsed_time_seconds: 1,
          },
          {
            type: "tool_use_summary",
            summary: "Done",
            preceding_tool_use_ids: ["tool_123"],
          },
        ]),
        {},
      )

      const items = await readStream(stream)
      const result = items.find((item) => item.type === "tool-result")

      expect(result?.type).toBe("tool-result")
      if (result?.type === "tool-result") {
        expect(result.toolCallId).toBe("tool_123")
        expect(result.toolName).toBe("bash")
        if (result.result && typeof result.result === "object") {
          const output = result.result as { output?: string; title?: string }
          expect(output.output).toBe("Done")
          expect(output.title).toBe("bash")
        }
      }
    })

    test("tool_use_summary emits tool-error for failures", async () => {
      const stream = createSDKStreamTransformer(
        mockStream([
          {
            type: "tool_progress",
            tool_use_id: "tool_123",
            tool_name: "Bash",
            parent_tool_use_id: null,
            elapsed_time_seconds: 1,
          },
          {
            type: "tool_use_summary",
            summary: "Boom",
            is_error: true,
            preceding_tool_use_ids: ["tool_123"],
          },
        ]),
        {},
      )

      const items = await readStream(stream)
      const error = items.find((item) => (item as { type?: string }).type === "tool-error")

      expect((error as { type?: string }).type).toBe("tool-error")
      if (error && (error as { error?: unknown }).error instanceof Error) {
        expect((error as { error: Error }).error.message).toBe("Boom")
      }
    })

    test("assistant thinking emits reasoning start/delta/end", async () => {
      const stream = createSDKStreamTransformer(
        mockStream([
          {
            type: "assistant",
            message: {
              content: [{ type: "thinking", thinking: "Working" }],
            },
          },
        ]),
        {},
      )

      const items = await readStream(stream)
      const start = items.find((item) => item.type === "reasoning-start")
      const delta = items.find((item) => item.type === "reasoning-delta")
      const end = items.find((item) => item.type === "reasoning-end")

      expect(start?.type).toBe("reasoning-start")
      expect(delta?.type).toBe("reasoning-delta")
      expect(end?.type).toBe("reasoning-end")
      if (delta?.type === "reasoning-delta") expect(delta.delta).toBe("Working")
      if (start?.type === "reasoning-start" && end?.type === "reasoning-end") {
        expect(end.id).toBe(start.id)
      }
      if (start?.type === "reasoning-start" && delta?.type === "reasoning-delta") {
        expect(delta.id).toBe(start.id)
      }
    })

    test("partial message emits text-delta", async () => {
      const stream = createSDKStreamTransformer(
        mockStream([
          {
            type: "partial",
            delta: "Hello",
          },
        ]),
        {},
      )

      const items = await readStream(stream)
      const delta = items.find((item) => item.type === "text-delta")

      expect(delta?.type).toBe("text-delta")
      if (delta?.type === "text-delta") expect(delta.delta).toBe("Hello")
    })

    test("error message emits error event", async () => {
      const stream = createSDKStreamTransformer(
        mockStream([
          {
            type: "error",
            error: { message: "Nope" },
          },
        ]),
        {},
      )

      const items = await readStream(stream)
      const error = items.find((item) => item.type === "error")

      expect(error?.type).toBe("error")
      if (error?.type === "error" && error.error instanceof Error) {
        expect(error.error.message).toBe("Nope")
      }
    })

    test("usage cache metrics are passed through", async () => {
      const captured = {
        metadata: undefined as SharedV2ProviderMetadata | undefined,
      }

      const stream = createSDKStreamTransformer(
        mockStream([
          {
            type: "assistant",
            message: {
              content: [],
              usage: {
                input_tokens: 10,
                output_tokens: 20,
                total_tokens: 30,
                reasoning_tokens: 5,
                cache_read_input_tokens: 4,
                cache_creation_input_tokens: 7,
              },
            },
          },
        ]),
        {
          onUsage: (_usage, metadata) => {
            captured.metadata = metadata
          },
        },
      )

      const items = await readStream(stream)
      const finish = items.find((item) => item.type === "finish")

      expect(finish?.type).toBe("finish")
      if (finish?.type === "finish") {
        expect(finish.usage.cachedInputTokens).toBe(4)
        expect(finish.providerMetadata).toEqual({
          "claude-agent-sdk": {
            cacheReadInputTokens: 4,
            cacheCreationInputTokens: 7,
          },
        })
      }
      expect(captured.metadata).toEqual({
        "claude-agent-sdk": {
          cacheReadInputTokens: 4,
          cacheCreationInputTokens: 7,
        },
      })
    })

    test("abort signal terminates stream", async () => {
      const controller = new AbortController()
      controller.abort()

      const stream = createSDKStreamTransformer(
        mockStream([
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Ignored" }],
            },
          },
        ]),
        { abortSignal: controller.signal },
      )

      const items = await readStream(stream)
      const finish = items.find((item) => item.type === "finish")

      expect(finish?.type).toBe("finish")
      if (finish?.type === "finish") expect(finish.finishReason).toBe("other")
    })
  })

  describe("ClaudeAgentSDKSessionStore", () => {
    test("stores and retrieves session", async () => {
      const store = new ClaudeAgentSDKSessionStore()
      await store.set("oc_123", "sdk_456", "claude-opus-4")
      expect(await store.get("oc_123", "claude-opus-4")).toBe("sdk_456")
    })

    test("different model invalidates session", async () => {
      const store = new ClaudeAgentSDKSessionStore()
      await store.set("oc_123", "sdk_456", "claude-opus-4")
      expect(await store.get("oc_123", "claude-sonnet-4")).toBeUndefined()
      expect(await store.get("oc_123", "claude-opus-4")).toBeUndefined()
    })

    test("touch updates lastUsedAt", async () => {
      const store = new ClaudeAgentSDKSessionStore()
      await store.set("oc_123", "sdk_456", "claude-opus-4")
      const cache = store as unknown as { cache: Map<string, { lastUsedAt: number }> }
      const before = cache.cache.get("oc_123")
      const first = before?.lastUsedAt ?? 0

      await new Promise((resolve) => setTimeout(resolve, 5))
      await store.touch("oc_123")

      const after = cache.cache.get("oc_123")
      const second = after?.lastUsedAt ?? 0

      expect(second).toBeGreaterThan(first)
    })
  })
})
