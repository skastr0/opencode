import { ConfigMarkdown } from "@/config/markdown"
import { Config } from "../config/config"
import { MCP } from "../mcp"
import { Provider } from "../provider/provider"
import { UI } from "./ui"
import { ClaudeAgentSDK } from "@/provider/native/errors"

export function FormatError(input: unknown) {
  if (MCP.Failed.isInstance(input))
    return `MCP server "${input.data.name}" failed. Note, opencode does not support MCP authentication yet.`
  if (Provider.ModelNotFoundError.isInstance(input)) {
    const { providerID, modelID, suggestions } = input.data
    return [
      `Model not found: ${providerID}/${modelID}`,
      ...(Array.isArray(suggestions) && suggestions.length ? ["Did you mean: " + suggestions.join(", ")] : []),
      `Try: \`opencode models\` to list available models`,
      `Or check your config (opencode.json) provider/model names`,
    ].join("\n")
  }
  if (Provider.InitError.isInstance(input)) {
    return `Failed to initialize provider "${input.data.providerID}". Check credentials and configuration.`
  }
  if (Config.JsonError.isInstance(input)) {
    return (
      `Config file at ${input.data.path} is not valid JSON(C)` + (input.data.message ? `: ${input.data.message}` : "")
    )
  }
  if (Config.ConfigDirectoryTypoError.isInstance(input)) {
    return `Directory "${input.data.dir}" in ${input.data.path} is not valid. Rename the directory to "${input.data.suggestion}" or remove it. This is a common typo.`
  }
  if (ConfigMarkdown.FrontmatterError.isInstance(input)) {
    return input.data.message
  }
  if (Config.InvalidError.isInstance(input))
    return [
      `Configuration is invalid${input.data.path && input.data.path !== "config" ? ` at ${input.data.path}` : ""}` +
        (input.data.message ? `: ${input.data.message}` : ""),
      ...(input.data.issues?.map((issue) => "↳ " + issue.message + " " + issue.path.join(".")) ?? []),
    ].join("\n")

  // Claude Agent SDK error formatting
  if (ClaudeAgentSDK.AuthError.isInstance(input)) {
    return [
      "Claude Agent SDK authentication failed",
      input.data.message,
      "",
      "To fix this:",
      "  1. Run `claude login` to authenticate with your Anthropic account",
      "  2. Or set the ANTHROPIC_API_KEY environment variable",
      "  3. Or configure an API key in your opencode.json",
    ].join("\n")
  }
  if (ClaudeAgentSDK.RateLimitError.isInstance(input)) {
    const retryInfo = input.data.retryAfterMs
      ? `Retry after ${Math.ceil(input.data.retryAfterMs / 1000)} seconds.`
      : "Please wait and try again."
    return [
      "Claude Agent SDK rate limited",
      input.data.message,
      retryInfo,
    ].join("\n")
  }
  if (ClaudeAgentSDK.ServerError.isInstance(input)) {
    return [
      "Claude Agent SDK server error",
      input.data.message,
      "",
      "This is a temporary issue. The request will be retried automatically.",
    ].join("\n")
  }
  if (ClaudeAgentSDK.SessionError.isInstance(input)) {
    return [
      "Claude session error",
      input.data.message,
      "",
      "Try starting a new session or conversation.",
    ].join("\n")
  }
  if (ClaudeAgentSDK.ModelError.isInstance(input)) {
    return [
      "Claude model error",
      input.data.message,
      "",
      "This may be due to context length limits or an invalid model configuration.",
    ].join("\n")
  }
  if (ClaudeAgentSDK.ToolError.isInstance(input)) {
    return [
      `Tool execution failed: ${input.data.toolName}`,
      input.data.message,
    ].join("\n")
  }
  if (ClaudeAgentSDK.Error.isInstance(input)) {
    const retryHint = input.data.isRetryable
      ? "This error may be retried automatically."
      : "This error is not retryable."
    return [
      "Claude Agent SDK error",
      input.data.message,
      ...(input.data.code ? [`Error code: ${input.data.code}`] : []),
      retryHint,
    ].join("\n")
  }

  if (UI.CancelledError.isInstance(input)) return ""
}

export function FormatUnknownError(input: unknown): string {
  if (input instanceof Error) {
    return input.stack ?? `${input.name}: ${input.message}`
  }

  if (typeof input === "object" && input !== null) {
    try {
      return JSON.stringify(input, null, 2)
    } catch {
      return "Unexpected error (unserializable)"
    }
  }

  return String(input)
}
