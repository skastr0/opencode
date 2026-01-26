import type { LanguageModelV2FilePart, LanguageModelV2Prompt, LanguageModelV2ToolResultOutput } from "@ai-sdk/provider"

type SDKPrompt = string | AsyncIterable<SDKInputMessage>

type SDKInputMessage = {
  type: "user" | "tool_result"
  message?: {
    role: "user"
    content: string | SDKContentPart[]
  }
  tool_use_id?: string
  content?: string
}

type SDKContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: SDKMediaSource }
  | { type: "document"; source: SDKMediaSource }

type SDKMediaSource = { type: "base64"; media_type: string; data: string } | { type: "url"; url: string }

type ToolResultInfo = {
  toolCallId: string
  output: string
}

type UserMessage = Extract<LanguageModelV2Prompt[number], { role: "user" }>

export function translateToSDKPrompt(prompt: LanguageModelV2Prompt): SDKPrompt {
  const toolResults = extractToolResults(prompt)
  const user = findLastUser(prompt)
  const content = user ? formatUserContent(user.content) : undefined

  if (toolResults.length === 0 && typeof content === "string") {
    return content
  }

  if (toolResults.length === 0 && !content) {
    return ""
  }

  return createPromptGenerator(toolResults, content)
}

function findLastUser(prompt: LanguageModelV2Prompt): UserMessage | undefined {
  return prompt.reduce<UserMessage | undefined>((acc, msg) => {
    if (msg.role === "user") return msg
    return acc
  }, undefined)
}

function extractToolResults(prompt: LanguageModelV2Prompt): ToolResultInfo[] {
  const results: ToolResultInfo[] = []

  for (const msg of prompt) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type !== "tool-result") continue
      results.push({
        toolCallId: part.toolCallId,
        output: formatToolOutput(part.output),
      })
    }
  }

  return results
}

async function* createPromptGenerator(
  toolResults: ToolResultInfo[],
  content?: string | SDKContentPart[],
): AsyncIterable<SDKInputMessage> {
  for (const result of toolResults) {
    const item: SDKInputMessage = {
      type: "tool_result",
      tool_use_id: result.toolCallId,
      content: result.output,
    }
    yield item
  }

  if (!content) return

  const msg: SDKInputMessage = {
    type: "user",
    message: {
      role: "user",
      content,
    },
  }
  yield msg
}

function formatUserContent(content: UserMessage["content"]) {
  const parts: SDKContentPart[] = []
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text })
      continue
    }
    if (part.type === "file") {
      parts.push(formatFilePart(part))
    }
  }

  const first = parts[0]
  const textOnly = parts.length === 1 && first?.type === "text"
  if (textOnly && first.type === "text") return first.text
  return parts
}

function formatFilePart(part: LanguageModelV2FilePart): SDKContentPart {
  const source = toMediaSource(part)
  if (part.mediaType.startsWith("image/")) return { type: "image", source }
  return { type: "document", source }
}

function toMediaSource(part: LanguageModelV2FilePart): SDKMediaSource {
  const data = part.data

  if (data instanceof URL) {
    return { type: "url", url: data.toString() }
  }

  if (typeof data === "string") {
    if (isUrlString(data)) return { type: "url", url: data }
    return { type: "base64", media_type: part.mediaType, data }
  }

  const base64 = Buffer.from(data).toString("base64")
  return { type: "base64", media_type: part.mediaType, data: base64 }
}

function isUrlString(value: string): boolean {
  if (value.startsWith("http://")) return true
  if (value.startsWith("https://")) return true
  return false
}

function formatToolOutput(output: LanguageModelV2ToolResultOutput): string {
  if (output.type === "text") return output.value
  if (output.type === "error-text") return output.value
  if (output.type === "json") return toJson(output.value)
  if (output.type === "error-json") return toJson(output.value)
  return toJson(output.value)
}

function toJson(value: unknown): string {
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
  return "null"
}
