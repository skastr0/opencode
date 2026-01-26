import type { Provider } from "../provider"

export const CLAUDE_AGENT_SDK_MODELS: Record<string, Provider.Model> = {
  "claude-opus-4-5": {
    id: "claude-opus-4-5",
    providerID: "claude-agent-sdk",
    name: "Claude Opus 4.5",
    family: "claude-4",
    api: {
      id: "claude-opus-4-5",
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
    release_date: "2025-11-01",
    variants: {
      high: { thinking: { type: "enabled", budgetTokens: 16000 } },
      max: { thinking: { type: "enabled", budgetTokens: 31999 } },
    },
  },
  "claude-sonnet-4-5": {
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
    variants: {
      high: { thinking: { type: "enabled", budgetTokens: 16000 } },
      max: { thinking: { type: "enabled", budgetTokens: 31999 } },
    },
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    providerID: "claude-agent-sdk",
    name: "Claude Haiku 4.5",
    family: "claude-4",
    api: {
      id: "claude-haiku-4-5",
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
    release_date: "2025-10-01",
    variants: {
      high: { thinking: { type: "enabled", budgetTokens: 16000 } },
      max: { thinking: { type: "enabled", budgetTokens: 31999 } },
    },
  },
}

export const MODEL_ID_MAP: Record<string, string> = {
  "claude-opus-4-5": "claude-opus-4-5",
  "claude-sonnet-4-5": "claude-sonnet-4-5",
  "claude-haiku-4-5": "claude-haiku-4-5",
  opus: "claude-opus-4-5",
  sonnet: "claude-sonnet-4-5",
  haiku: "claude-haiku-4-5",
}

export function mapModelId(id: string): string {
  return MODEL_ID_MAP[id] ?? id
}
