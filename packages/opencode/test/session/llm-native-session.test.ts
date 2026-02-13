import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import type { MessageV2 } from "../../src/session/message-v2"
import type { ClaudeNativeInput } from "../../src/provider/native/claude-agent-sdk"

const calls: ClaudeNativeInput[] = []

const originals = {
  getLanguage: Provider.getLanguage,
  getProvider: Provider.getProvider,
  configGet: Config.get,
  authGet: Auth.get,
  pluginTrigger: Plugin.trigger,
}

const setupMocks = () => {
  ;(
    globalThis as {
      __opencodeStreamClaudeNative?: (input: ClaudeNativeInput) => Promise<{ fullStream: AsyncIterable<unknown> }>
    }
  ).__opencodeStreamClaudeNative = async (input) => {
    calls.push(input)
    input.onSessionId?.("sdk_123")
    return { fullStream: (async function* () {})() }
  }

  Provider.getLanguage = async () => ({}) as Awaited<ReturnType<typeof Provider.getLanguage>>
  Provider.getProvider = async () =>
    ({
      id: "claude-agent-sdk",
      name: "Claude Agent SDK",
      source: "custom",
      env: [],
      options: {},
      models: {
        [modelBase.id]: modelBase,
        [modelAlt.id]: modelAlt,
      },
    }) as Awaited<ReturnType<typeof Provider.getProvider>>
  Config.get = async () => ({ experimental: {} })
  Auth.get = async () => ({ type: "api", key: "test" })
  Plugin.trigger = async (_event, _ctx, payload) => payload
}

const loadLLM = async () =>
  (await import(
    new URL("../../src/session/llm.ts?llm-native-session", import.meta.url).href
  )) as typeof import("../../src/session/llm")

const modelBase: Provider.Model = {
  id: "claude-sonnet-4-5",
  providerID: "claude-agent-sdk",
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

const modelAlt: Provider.Model = {
  ...modelBase,
  id: "claude-haiku-4-5",
  api: {
    ...modelBase.api,
    id: "claude-haiku-4-5",
  },
}

const baseAgent = {
  name: "build",
  mode: "primary",
  native: true,
  permission: [],
  options: {},
} as Agent.Info

const baseUser = {
  id: "msg_1",
  sessionID: "ses_test",
  role: "user",
  time: { created: Date.now() },
  agent: "build",
  model: {
    providerID: "claude-agent-sdk",
    modelID: "claude-sonnet-4-5",
  },
} as MessageV2.User

const baseMessages: ModelMessage[] = [
  {
    role: "user",
    content: "Hello",
  },
]

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  Provider.getLanguage = originals.getLanguage
  Provider.getProvider = originals.getProvider
  Config.get = originals.configGet
  Auth.get = originals.authGet
  Plugin.trigger = originals.pluginTrigger
  delete (globalThis as { __opencodeStreamClaudeNative?: unknown }).__opencodeStreamClaudeNative
})

describe("session.llm.nativeSession", () => {
  test("stores and resumes sdk session ids", async () => {
    setupMocks()
    const { LLM } = await loadLLM()
    const sessionID = "ses_native_1"
    await LLM.stream({
      user: { ...baseUser, sessionID },
      sessionID,
      model: modelBase,
      agent: baseAgent,
      system: [],
      abort: new AbortController().signal,
      messages: baseMessages,
      tools: {},
    })

    await LLM.stream({
      user: { ...baseUser, sessionID },
      sessionID,
      model: modelBase,
      agent: baseAgent,
      system: [],
      abort: new AbortController().signal,
      messages: baseMessages,
      tools: {},
    })

    expect(calls[0]?.sdkSessionId).toBeUndefined()
    expect(calls[1]?.sdkSessionId).toBe("sdk_123")
  })

  test("invalidates stored session on model change", async () => {
    setupMocks()
    const { LLM } = await loadLLM()
    const sessionID = "ses_native_2"
    await LLM.stream({
      user: { ...baseUser, sessionID },
      sessionID,
      model: modelBase,
      agent: baseAgent,
      system: [],
      abort: new AbortController().signal,
      messages: baseMessages,
      tools: {},
    })

    await LLM.stream({
      user: { ...baseUser, sessionID },
      sessionID,
      model: modelAlt,
      agent: baseAgent,
      system: [],
      abort: new AbortController().signal,
      messages: baseMessages,
      tools: {},
    })

    expect(calls[1]?.sdkSessionId).toBeUndefined()
  })
})
