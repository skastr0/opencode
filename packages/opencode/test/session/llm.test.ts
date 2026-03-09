import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { tool, type ModelMessage } from "ai"
import z from "zod"
import { LLM } from "../../src/session/llm"
import { Auth } from "../../src/auth"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import { ModelsDev } from "../../src/provider/models"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"
import type { Agent } from "../../src/agent/agent"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"

describe("session.llm.hasToolCalls", () => {
  test("returns false for empty messages array", () => {
    expect(LLM.hasToolCalls([])).toBe(false)
  })

  test("returns false for messages with only text content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when messages contain tool-call", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Run a command" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns true when messages contain tool-result", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns false for messages with string content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Hello world",
      },
      {
        role: "assistant",
        content: "Hi there",
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when tool-call is mixed with text content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that command" },
          {
            type: "tool-call",
            toolCallId: "call-456",
            toolName: "read",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })
})

describe("session.llm.serviceTier", () => {
  test("returns priority only for OpenAI OAuth gpt-5.4 fast requests", () => {
    expect(LLM.serviceTier({ provider: "openai", auth: "oauth", model: "gpt-5.4", fast: true })).toBe("priority")

    expect(LLM.serviceTier({ provider: "openai", auth: "api", model: "gpt-5.4", fast: true })).toBeUndefined()
    expect(LLM.serviceTier({ provider: "anthropic", auth: "oauth", model: "gpt-5.4", fast: true })).toBeUndefined()
    expect(LLM.serviceTier({ provider: "openai", auth: "oauth", model: "gpt-5.2", fast: true })).toBeUndefined()
    expect(LLM.serviceTier({ provider: "openai", auth: "oauth", model: "gpt-5.4", fast: false })).toBeUndefined()
  })
})

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{ path: string; response: Response; resolve: (value: Capture) => void }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  state.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = state.queue.shift()
      if (!next) {
        return new Response("unexpected request", { status: 500 })
      }

      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })

      if (!url.pathname.endsWith(next.path)) {
        return new Response("not found", { status: 404 })
      }

      return next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
})

afterAll(() => {
  state.server?.stop()
})

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

async function loadFixture(providerID: string, modelID: string) {
  const fixturePath = path.join(import.meta.dir, "../tool/fixtures/models-api.json")
  const data = await Filesystem.readJson<Record<string, ModelsDev.Provider>>(fixturePath)
  const provider = data[providerID]
  if (!provider) {
    throw new Error(`Missing provider in fixture: ${providerID}`)
  }
  const model = provider.models[modelID]
  if (!model) {
    throw new Error(`Missing model in fixture: ${modelID}`)
  }
  return { provider, model }
}

function createEventStream(chunks: unknown[], includeDone = false) {
  const lines = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`)
  if (includeDone) {
    lines.push("data: [DONE]")
  }
  const payload = lines.join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createEventResponse(chunks: unknown[], includeDone = false) {
  return new Response(createEventStream(chunks, includeDone), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

describe("session.llm.stream", () => {
  test("sends temperature, tokens, and reasoning options for openai-compatible models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const provider = fixture.provider
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-1")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-1"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          variant: "high",
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body
        const headers = capture.headers
        const url = capture.url

        expect(url.pathname.startsWith("/v1/")).toBe(true)
        expect(url.pathname.endsWith("/chat/completions")).toBe(true)
        expect(headers.get("Authorization")).toBe("Bearer test-key")

        expect(body.model).toBe(resolved.api.id)
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.8)
        expect(body.stream).toBe(true)

        const maxTokens = (body.max_tokens as number | undefined) ?? (body.max_output_tokens as number | undefined)
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)

        const reasoning = (body.reasoningEffort as string | undefined) ?? (body.reasoning_effort as string | undefined)
        expect(reasoning).toBe("high")
      },
    })
  })

  test("keeps tools enabled by prompt permissions", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "question", pattern: "*", action: "deny" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          tools: { question: true },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          permission: [{ permission: "question", pattern: "*", action: "allow" }],
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {
            question: tool({
              description: "Ask a question",
              inputSchema: z.object({}),
              execute: async () => ({ output: "" }),
            }),
          },
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const tools = capture.body.tools as Array<{ function?: { name?: string } }> | undefined
        expect(tools?.some((item) => item.function?.name === "question")).toBe(true)
      },
    })
  })

  test("sends responses API payload for OpenAI models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model

    const responseChunks = [
      {
        type: "response.created",
        response: {
          id: "resp-1",
          created_at: Math.floor(Date.now() / 1000),
          model: model.id,
          service_tier: null,
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-1",
        delta: "Hello",
        logprobs: null,
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(responseChunks, true))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                  websocketMode: false,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.openai, ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-2")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-2"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("openai"), modelID: resolved.id },
          variant: "high",
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.stream).toBe(true)
        expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")

        const maxTokens = body.max_output_tokens as number | undefined
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)
      },
    })
  })

  test("preserves service_tier for OAuth gpt-5.4 fast requests", async () => {
    const source = await loadFixture("openai", "gpt-5.2")
    const model = {
      ...source.model,
      id: "gpt-5.4",
      name: "GPT-5.4",
    }
    const response = createEventResponse(
      [
        {
          type: "response.created",
          response: {
            id: "resp-fast-1",
            created_at: Math.floor(Date.now() / 1000),
            model: model.id,
            service_tier: null,
          },
        },
        {
          type: "response.output_text.delta",
          item_id: "item-fast-1",
          delta: "Hello",
          logprobs: null,
        },
        {
          type: "response.completed",
          response: {
            incomplete_details: null,
            usage: {
              input_tokens: 1,
              input_tokens_details: null,
              output_tokens: 1,
              output_tokens_details: null,
            },
            service_tier: null,
          },
        },
      ],
      true,
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  websocketMode: false,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.set("openai", {
          type: "oauth",
          refresh: "test-refresh-token",
          access: "test-access-token",
          expires: Date.now() + 60_000,
          accountId: "acc-test",
        })

        const original = globalThis.fetch
        let capture: Capture | undefined

        globalThis.fetch = Object.assign(
          async (input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
            const req = new Request(input, init)
            capture = {
              url: new URL(req.url),
              headers: req.headers,
              body: (await req.json()) as Record<string, unknown>,
            }
            return response.clone()
          },
          { preconnect: original.preconnect.bind(original) },
        ) as typeof fetch

        try {
          const resolved = await Provider.getModel("openai", model.id)
          const agent = {
            name: "test",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
            temperature: 0.2,
          } satisfies Agent.Info

          const user = {
            id: "user-fast",
            sessionID: "session-fast",
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: "openai", modelID: resolved.id },
            fast: true,
          } satisfies MessageV2.User

          const stream = await LLM.stream({
            user,
            sessionID: user.sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            abort: new AbortController().signal,
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          })

          for await (const _ of stream.fullStream) {
          }

          expect(capture?.url.host).toBe("chatgpt.com")
          expect(capture?.url.pathname).toBe("/backend-api/codex/responses")
          expect(capture?.headers.get("authorization")).toBe("Bearer test-access-token")
          expect(capture?.body.model).toBe(model.id)
          expect(capture?.body.service_tier).toBe("priority")
        } finally {
          globalThis.fetch = original
          await Auth.remove("openai")
        }
      },
    })
  })

  test("uses responses websocket mode for OpenAI when enabled", async () => {
    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model
    const wsMessages: any[] = []

    // Create a server with WebSocket upgrade support
    const wsServer = Bun.serve({
      port: 0,
      async fetch(req, server) {
        if (server.upgrade(req)) return undefined
        return new Response("not found", { status: 404 })
      },
      websocket: {
        message(ws, data) {
          const text = typeof data === "string" ? data : new TextDecoder().decode(data)
          const payload = JSON.parse(text)
          wsMessages.push(payload)

          if (payload.type !== "response.create") return

          ws.send(
            JSON.stringify({
              type: "response.created",
              response: {
                id: "resp-ws-1",
                created_at: Math.floor(Date.now() / 1000),
                model: model.id,
                service_tier: null,
              },
            }),
          )

          ws.send(
            JSON.stringify({
              type: "response.output_text.delta",
              item_id: "item-ws-1",
              delta: "Hello from websocket",
              logprobs: null,
            }),
          )

          ws.send(
            JSON.stringify({
              type: "response.completed",
              response: {
                incomplete_details: null,
                usage: {
                  input_tokens: 1,
                  input_tokens_details: null,
                  output_tokens: 1,
                  output_tokens_details: null,
                },
                service_tier: null,
              },
            }),
          )
        },
      },
    })

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["openai"],
              provider: {
                openai: {
                  name: "OpenAI",
                  env: ["OPENAI_API_KEY"],
                  npm: "@ai-sdk/openai",
                  api: `${wsServer.url.origin}/v1`,
                  models: {
                    [model.id]: model,
                  },
                  options: {
                    apiKey: "test-openai-key",
                    baseURL: `${wsServer.url.origin}/v1`,
                    websocketMode: true,
                    compactionThreshold: 1234,
                  },
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const resolved = await Provider.getModel("openai", model.id)
          const sessionID = "session-test-ws"
          const agent = {
            name: "test",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
            temperature: 0.2,
          } satisfies Agent.Info

          const user = {
            id: "user-ws",
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: "openai", modelID: resolved.id },
            variant: "high",
          } satisfies MessageV2.User

          const stream = await LLM.stream({
            user,
            sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            abort: new AbortController().signal,
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          })

          await stream.text

          expect(wsMessages).toHaveLength(1)
          expect(wsMessages[0].type).toBe("response.create")
          expect(wsMessages[0].stream).toBeUndefined()
          expect(wsMessages[0].context_management).toEqual([
            {
              type: "compaction",
              compact_threshold: 1234,
            },
          ])
        },
      })
    } finally {
      wsServer.stop()
    }
  })

  test("falls back to responses http when websocket connect fails", async () => {
    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model
    const captures: Capture[] = []

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (req.method !== "POST" || !url.pathname.endsWith("/responses")) {
          return new Response("not found", { status: 404 })
        }

        const body = (await req.json()) as Record<string, unknown>
        captures.push({ url, headers: req.headers, body })

        return createEventResponse(
          [
            {
              type: "response.created",
              response: {
                id: "resp-http-fallback-1",
                created_at: Math.floor(Date.now() / 1000),
                model: model.id,
                service_tier: null,
              },
            },
            {
              type: "response.output_text.delta",
              item_id: "item-http-fallback-1",
              delta: "Hello from http fallback",
              logprobs: null,
            },
            {
              type: "response.completed",
              response: {
                incomplete_details: null,
                usage: {
                  input_tokens: 1,
                  input_tokens_details: null,
                  output_tokens: 1,
                  output_tokens_details: null,
                },
                service_tier: null,
              },
            },
          ],
          true,
        )
      },
    })

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["openai"],
              provider: {
                openai: {
                  name: "OpenAI",
                  env: ["OPENAI_API_KEY"],
                  npm: "@ai-sdk/openai",
                  api: `${server.url.origin}/v1`,
                  models: {
                    [model.id]: model,
                  },
                  options: {
                    apiKey: "test-openai-key",
                    baseURL: `${server.url.origin}/v1`,
                    websocketMode: true,
                  },
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const resolved = await Provider.getModel("openai", model.id)
          const sessionID = "session-test-ws-http-fallback"
          const agent = {
            name: "test",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
            temperature: 0.2,
          } satisfies Agent.Info

          const user = {
            id: "user-ws-http-fallback",
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: "openai", modelID: resolved.id },
            variant: "high",
          } satisfies MessageV2.User

          const stream = await LLM.stream({
            user,
            sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            abort: new AbortController().signal,
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          })

          for await (const _ of stream.fullStream) {
          }
          expect(captures).toHaveLength(1)
          expect(captures[0].url.pathname.endsWith("/responses")).toBe(true)
          expect(captures[0].body.stream).toBe(true)
        },
      })
    } finally {
      server.stop()
    }
  }, 10_000)

  test("uses one responses websocket per session for parallel requests", async () => {
    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model
    const wsMessages: Array<Record<string, unknown>> = []
    let wsOpenCount = 0

    const wsServer = Bun.serve({
      port: 0,
      async fetch(req, server) {
        if (server.upgrade(req)) return undefined
        return new Response("unexpected http transport", { status: 500 })
      },
      websocket: {
        open() {
          wsOpenCount++
        },
        message(ws, data) {
          const text = typeof data === "string" ? data : new TextDecoder().decode(data)
          const payload = JSON.parse(text) as Record<string, unknown>
          wsMessages.push(payload)

          const index = wsMessages.length
          ws.send(
            JSON.stringify({
              type: "response.created",
              response: {
                id: `resp-ws-${index}`,
                created_at: Math.floor(Date.now() / 1000),
                model: model.id,
                service_tier: null,
              },
            }),
          )

          ws.send(
            JSON.stringify({
              type: "response.output_text.delta",
              item_id: `item-ws-${index}`,
              delta: `Hello from websocket ${index}`,
              logprobs: null,
            }),
          )

          const completed = JSON.stringify({
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
              },
              service_tier: null,
            },
          })

          if (index === 1) {
            setTimeout(() => ws.send(completed), 250)
            return
          }

          ws.send(completed)
        },
      },
    })

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["openai"],
              provider: {
                openai: {
                  name: "OpenAI",
                  env: ["OPENAI_API_KEY"],
                  npm: "@ai-sdk/openai",
                  api: `${wsServer.url.origin}/v1`,
                  models: {
                    [model.id]: model,
                  },
                  options: {
                    apiKey: "test-openai-key",
                    baseURL: `${wsServer.url.origin}/v1`,
                    websocketMode: true,
                  },
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const resolved = await Provider.getModel("openai", model.id)
          const agent = {
            name: "test",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
            temperature: 0.2,
          } satisfies Agent.Info

          const userA = {
            id: "user-ws-parallel-a",
            sessionID: "session-test-ws-parallel-a",
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: "openai", modelID: resolved.id },
            variant: "high",
          } satisfies MessageV2.User

          const userB = {
            id: "user-ws-parallel-b",
            sessionID: "session-test-ws-parallel-b",
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: "openai", modelID: resolved.id },
            variant: "high",
          } satisfies MessageV2.User

          const first = await LLM.stream({
            user: userA,
            sessionID: userA.sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            abort: new AbortController().signal,
            messages: [{ role: "user", content: "Hello from A" }],
            tools: {},
          })
          const firstText = first.text

          await Bun.sleep(25)

          const second = await LLM.stream({
            user: userB,
            sessionID: userB.sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            abort: new AbortController().signal,
            messages: [{ role: "user", content: "Hello from B" }],
            tools: {},
          })

          await Promise.all([firstText, second.text])
          expect(wsMessages).toHaveLength(2)
          expect(wsOpenCount).toBe(2)

          const sessionKeys = wsMessages
            .map((msg) => msg["prompt_cache_key"] ?? msg["promptCacheKey"])
            .sort((a, b) => String(a).localeCompare(String(b)))
          expect(sessionKeys).toEqual([userA.sessionID, userB.sessionID])
        },
      })
    } finally {
      wsServer.stop()
    }
  })

  test("evicts idle responses websocket after configured timeout", async () => {
    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model
    let wsOpenCount = 0

    const wsServer = Bun.serve({
      port: 0,
      async fetch(req, server) {
        if (server.upgrade(req)) return undefined
        return new Response("unexpected http transport", { status: 500 })
      },
      websocket: {
        open() {
          wsOpenCount++
        },
        message(ws, data) {
          const text = typeof data === "string" ? data : new TextDecoder().decode(data)
          const payload = JSON.parse(text) as Record<string, unknown>
          if (payload.type !== "response.create") return

          ws.send(
            JSON.stringify({
              type: "response.created",
              response: {
                id: "resp-idle-1",
                created_at: Math.floor(Date.now() / 1000),
                model: model.id,
                service_tier: null,
              },
            }),
          )

          ws.send(
            JSON.stringify({
              type: "response.output_text.delta",
              item_id: "item-idle-1",
              delta: "Hello",
              logprobs: null,
            }),
          )

          ws.send(
            JSON.stringify({
              type: "response.completed",
              response: {
                incomplete_details: null,
                usage: {
                  input_tokens: 1,
                  input_tokens_details: null,
                  output_tokens: 1,
                  output_tokens_details: null,
                },
                service_tier: null,
              },
            }),
          )
        },
      },
    })

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["openai"],
              provider: {
                openai: {
                  name: "OpenAI",
                  env: ["OPENAI_API_KEY"],
                  npm: "@ai-sdk/openai",
                  api: `${wsServer.url.origin}/v1`,
                  models: {
                    [model.id]: model,
                  },
                  options: {
                    apiKey: "test-openai-key",
                    baseURL: `${wsServer.url.origin}/v1`,
                    websocketMode: true,
                    responsesSocketIdleTimeoutMs: 25,
                  },
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const resolved = await Provider.getModel("openai", model.id)
          const sessionID = "session-test-ws-idle"
          const agent = {
            name: "test",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
            temperature: 0.2,
          } satisfies Agent.Info

          const user = {
            id: "user-ws-idle",
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: "openai", modelID: resolved.id },
            variant: "high",
          } satisfies MessageV2.User

          const first = await LLM.stream({
            user,
            sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            abort: new AbortController().signal,
            messages: [{ role: "user", content: "Hello one" }],
            tools: {},
          })
          await first.text

          await Bun.sleep(80)

          const second = await LLM.stream({
            user,
            sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            abort: new AbortController().signal,
            messages: [{ role: "user", content: "Hello two" }],
            tools: {},
          })
          await second.text

          expect(wsOpenCount).toBe(2)
        },
      })
    } finally {
      wsServer.stop()
    }
  }, 15_000)

  test("sends messages API payload for Anthropic models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "anthropic"
    const modelID = "claude-3-5-sonnet-20241022"
    const fixture = await loadFixture(providerID, modelID)
    const provider = fixture.provider
    const model = fixture.model

    const chunks = [
      {
        type: "message_start",
        message: {
          id: "msg-1",
          model: model.id,
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      { type: "message_stop" },
    ]
    const request = waitRequest("/messages", createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-anthropic-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-3")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.9,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-3"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.max_tokens).toBe(ProviderTransform.maxOutputTokens(resolved))
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.9)
      },
    })
  })

  test("sends Google API payload for Gemini models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "google"
    const modelID = "gemini-2.5-flash"
    const fixture = await loadFixture(providerID, modelID)
    const provider = fixture.provider
    const model = fixture.model
    const pathSuffix = `/v1beta/models/${model.id}:streamGenerateContent`

    const chunks = [
      {
        candidates: [
          {
            content: {
              parts: [{ text: "Hello" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      },
    ]
    const request = waitRequest(pathSuffix, createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-google-key",
                  baseURL: `${server.url.origin}/v1beta`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-4")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.3,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-4"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body
        const config = body.generationConfig as
          | { temperature?: number; topP?: number; maxOutputTokens?: number }
          | undefined

        expect(capture.url.pathname).toBe(pathSuffix)
        expect(config?.temperature).toBe(0.3)
        expect(config?.topP).toBe(0.8)
        expect(config?.maxOutputTokens).toBe(ProviderTransform.maxOutputTokens(resolved))
      },
    })
  })
})
