import { describe, expect, it } from "bun:test"
import { ClaudeAgentSDK } from "../../../src/provider/native/errors"

describe("ClaudeAgentSDK.classify", () => {
  describe("AuthError", () => {
    it("classifies authentication_error code", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Invalid API key",
        code: "authentication_error",
      })
      expect(ClaudeAgentSDK.AuthError.isInstance(error)).toBe(true)
    })

    it("classifies invalid_api_key code", () => {
      const error = ClaudeAgentSDK.classify({
        message: "API key is invalid",
        code: "invalid_api_key",
      })
      expect(ClaudeAgentSDK.AuthError.isInstance(error)).toBe(true)
    })

    it("classifies 401 status code", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Unauthorized",
        statusCode: 401,
      })
      expect(ClaudeAgentSDK.AuthError.isInstance(error)).toBe(true)
    })

    it("classifies 403 status code", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Forbidden",
        statusCode: 403,
      })
      expect(ClaudeAgentSDK.AuthError.isInstance(error)).toBe(true)
    })

    it("classifies message containing 'api key'", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Your API key is missing or invalid",
      })
      expect(ClaudeAgentSDK.AuthError.isInstance(error)).toBe(true)
    })
  })

  describe("RateLimitError", () => {
    it("classifies rate_limit_error code", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Rate limit exceeded",
        code: "rate_limit_error",
      })
      expect(ClaudeAgentSDK.RateLimitError.isInstance(error)).toBe(true)
    })

    it("classifies 429 status code", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Too many requests",
        statusCode: 429,
      })
      expect(ClaudeAgentSDK.RateLimitError.isInstance(error)).toBe(true)
    })

    it("preserves retryAfterMs", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Rate limit exceeded",
        code: "rate_limit_error",
        retryAfterMs: 5000,
      })
      expect(ClaudeAgentSDK.RateLimitError.isInstance(error)).toBe(true)
      if (ClaudeAgentSDK.RateLimitError.isInstance(error)) {
        expect(error.data.retryAfterMs).toBe(5000)
      }
    })
  })

  describe("ServerError", () => {
    it("classifies overloaded_error code", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Service is overloaded",
        code: "overloaded_error",
      })
      expect(ClaudeAgentSDK.ServerError.isInstance(error)).toBe(true)
      if (ClaudeAgentSDK.ServerError.isInstance(error)) {
        expect(error.data.isRetryable).toBe(true)
      }
    })

    it("classifies server_error code", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Internal server error",
        code: "server_error",
      })
      expect(ClaudeAgentSDK.ServerError.isInstance(error)).toBe(true)
    })

    it("classifies 5xx status codes", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Internal error",
        statusCode: 500,
      })
      expect(ClaudeAgentSDK.ServerError.isInstance(error)).toBe(true)
    })

    it("classifies 503 status code", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Service unavailable",
        statusCode: 503,
      })
      expect(ClaudeAgentSDK.ServerError.isInstance(error)).toBe(true)
    })
  })

  describe("SessionError", () => {
    it("classifies session_error code", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Session has expired",
        code: "session_error",
      })
      expect(ClaudeAgentSDK.SessionError.isInstance(error)).toBe(true)
    })

    it("classifies message containing 'session'", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Invalid session state",
      })
      expect(ClaudeAgentSDK.SessionError.isInstance(error)).toBe(true)
    })

    it("preserves sessionId", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Session expired",
        code: "session_error",
        sessionId: "ses_12345",
      })
      expect(ClaudeAgentSDK.SessionError.isInstance(error)).toBe(true)
      if (ClaudeAgentSDK.SessionError.isInstance(error)) {
        expect(error.data.sessionId).toBe("ses_12345")
      }
    })
  })

  describe("ModelError", () => {
    it("classifies context_length_exceeded code", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Context length exceeded",
        code: "context_length_exceeded",
      })
      expect(ClaudeAgentSDK.ModelError.isInstance(error)).toBe(true)
    })

    it("classifies message containing 'context'", () => {
      const error = ClaudeAgentSDK.classify({
        message: "The context window is full",
      })
      expect(ClaudeAgentSDK.ModelError.isInstance(error)).toBe(true)
    })

    it("classifies message containing 'tokens'", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Too many tokens in request",
      })
      expect(ClaudeAgentSDK.ModelError.isInstance(error)).toBe(true)
    })
  })

  describe("Generic Error", () => {
    it("falls back to generic error for unknown codes", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Something went wrong",
        code: "unknown_error",
      })
      expect(ClaudeAgentSDK.Error.isInstance(error)).toBe(true)
    })

    it("marks timeout errors as retryable", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Request timeout",
      })
      expect(ClaudeAgentSDK.Error.isInstance(error)).toBe(true)
      if (ClaudeAgentSDK.Error.isInstance(error)) {
        expect(error.data.isRetryable).toBe(true)
      }
    })

    it("marks connection errors as retryable", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Connection reset by peer",
      })
      expect(ClaudeAgentSDK.Error.isInstance(error)).toBe(true)
      if (ClaudeAgentSDK.Error.isInstance(error)) {
        expect(error.data.isRetryable).toBe(true)
      }
    })

    it("marks unknown errors as non-retryable", () => {
      const error = ClaudeAgentSDK.classify({
        message: "Something unexpected happened",
      })
      expect(ClaudeAgentSDK.Error.isInstance(error)).toBe(true)
      if (ClaudeAgentSDK.Error.isInstance(error)) {
        expect(error.data.isRetryable).toBe(false)
      }
    })
  })

  describe("ToolError", () => {
    it("can be created directly", () => {
      const error = new ClaudeAgentSDK.ToolError({
        toolName: "read",
        toolCallId: "tc_123",
        message: "File not found",
      })
      expect(ClaudeAgentSDK.ToolError.isInstance(error)).toBe(true)
      expect(error.data.toolName).toBe("read")
      expect(error.data.toolCallId).toBe("tc_123")
      expect(error.data.message).toBe("File not found")
    })
  })
})
