import z from "zod"
import { NamedError } from "@opencode-ai/util/error"

/**
 * Claude Agent SDK Error Types
 *
 * These typed errors enable:
 * 1. Proper retry logic for transient failures
 * 2. Actionable user-facing messages
 * 3. Structured error handling throughout the codebase
 * 4. Distinction between tool errors, API errors, and session errors
 */
export namespace ClaudeAgentSDK {
  /**
   * Authentication/authorization failures
   * Not retryable - requires user action (login, API key)
   */
  export const AuthError = NamedError.create(
    "ClaudeAgentSDKAuthError",
    z.object({
      message: z.string(),
      code: z.string().optional(),
    }),
  )

  /**
   * Rate limiting errors
   * Retryable - should back off and retry
   */
  export const RateLimitError = NamedError.create(
    "ClaudeAgentSDKRateLimitError",
    z.object({
      message: z.string(),
      retryAfterMs: z.number().optional(),
    }),
  )

  /**
   * Server errors (5xx, overloaded, etc.)
   * Retryable - transient failures
   */
  export const ServerError = NamedError.create(
    "ClaudeAgentSDKServerError",
    z.object({
      message: z.string(),
      statusCode: z.number().optional(),
      isRetryable: z.literal(true),
    }),
  )

  /**
   * Session-related errors
   * Not retryable with same session - may need new session
   */
  export const SessionError = NamedError.create(
    "ClaudeAgentSDKSessionError",
    z.object({
      message: z.string(),
      sessionId: z.string().optional(),
    }),
  )

  /**
   * Tool execution errors (distinct from API errors)
   * These occur when a tool fails, not the API itself
   */
  export const ToolError = NamedError.create(
    "ClaudeAgentSDKToolError",
    z.object({
      toolName: z.string(),
      toolCallId: z.string(),
      message: z.string(),
    }),
  )

  /**
   * Model/context errors (context too long, invalid model, etc.)
   * Not retryable - requires different input
   */
  export const ModelError = NamedError.create(
    "ClaudeAgentSDKModelError",
    z.object({
      message: z.string(),
      code: z.string().optional(),
    }),
  )

  /**
   * Generic SDK errors (fallback for unclassified errors)
   */
  export const Error = NamedError.create(
    "ClaudeAgentSDKError",
    z.object({
      message: z.string(),
      code: z.string().optional(),
      isRetryable: z.boolean(),
    }),
  )

  /**
   * Classify an SDK error based on error code, type, and message
   */
  export function classify(input: {
    message: string
    code?: string
    type?: string
    statusCode?: number
    retryAfterMs?: number
    sessionId?: string
  }): InstanceType<
    | typeof AuthError
    | typeof RateLimitError
    | typeof ServerError
    | typeof SessionError
    | typeof ModelError
    | typeof Error
  > {
    const { message, code, type, statusCode, retryAfterMs, sessionId } = input
    const errorCode = code ?? type

    // Authentication errors
    if (
      errorCode === "authentication_error" ||
      errorCode === "invalid_api_key" ||
      errorCode === "permission_denied" ||
      errorCode === "unauthorized" ||
      message.toLowerCase().includes("api key") ||
      message.toLowerCase().includes("authentication") ||
      message.toLowerCase().includes("unauthorized") ||
      statusCode === 401 ||
      statusCode === 403
    ) {
      return new AuthError({ message, code: errorCode })
    }

    // Rate limit errors
    if (
      errorCode === "rate_limit_error" ||
      errorCode === "too_many_requests" ||
      errorCode === "rate_limited" ||
      message.toLowerCase().includes("rate limit") ||
      message.toLowerCase().includes("too many requests") ||
      statusCode === 429
    ) {
      return new RateLimitError({ message, retryAfterMs })
    }

    // Server errors (retryable)
    if (
      errorCode === "overloaded_error" ||
      errorCode === "server_error" ||
      errorCode === "internal_error" ||
      errorCode === "service_unavailable" ||
      message.toLowerCase().includes("overloaded") ||
      message.toLowerCase().includes("server error") ||
      message.toLowerCase().includes("temporarily unavailable") ||
      (statusCode && statusCode >= 500 && statusCode < 600)
    ) {
      return new ServerError({ message, statusCode, isRetryable: true })
    }

    // Session errors
    if (
      errorCode === "session_error" ||
      errorCode === "invalid_session" ||
      errorCode === "session_expired" ||
      message.toLowerCase().includes("session")
    ) {
      return new SessionError({ message, sessionId })
    }

    // Model/context errors
    if (
      errorCode === "context_length_exceeded" ||
      errorCode === "invalid_model" ||
      errorCode === "model_not_found" ||
      message.toLowerCase().includes("context") ||
      message.toLowerCase().includes("tokens")
    ) {
      return new ModelError({ message, code: errorCode })
    }

    // Generic fallback - determine retryability
    const isRetryable = isRetryableByMessage(message, errorCode)
    return new Error({ message, code: errorCode, isRetryable })
  }

  /**
   * Determine if an error is retryable based on message patterns
   */
  function isRetryableByMessage(message: string, code?: string): boolean {
    const lowerMessage = message.toLowerCase()
    const retryablePatterns = [
      "timeout",
      "connection reset",
      "connection refused",
      "network error",
      "econnreset",
      "econnrefused",
      "etimedout",
      "temporarily",
      "try again",
      "retry",
    ]

    for (const pattern of retryablePatterns) {
      if (lowerMessage.includes(pattern)) {
        return true
      }
    }

    // Check code patterns
    if (code) {
      const retryableCodes = ["timeout", "connection_error", "network_error"]
      for (const rc of retryableCodes) {
        if (code.includes(rc)) {
          return true
        }
      }
    }

    return false
  }
}
