import { describe, expect, test } from "bun:test"
import { ThinkingEffort } from "../../src/session/thinking-effort"

describe("ThinkingEffort.detect", () => {
  describe("ultrathink patterns", () => {
    test("ultrathink returns high/128k", () => {
      const result = ThinkingEffort.detect("ultrathink")
      expect(result).toEqual({ effort: "high", budgetTokens: 128_000 })
    })

    test("think really hard returns high/128k", () => {
      const result = ThinkingEffort.detect("think really hard")
      expect(result).toEqual({ effort: "high", budgetTokens: 128_000 })
    })

    test("ULTRATHINK (case insensitive) returns high/128k", () => {
      const result = ThinkingEffort.detect("ULTRATHINK")
      expect(result).toEqual({ effort: "high", budgetTokens: 128_000 })
    })

    test("ultrathink in middle of message", () => {
      const result = ThinkingEffort.detect("please ultrathink about this")
      expect(result).toEqual({ effort: "high", budgetTokens: 128_000 })
    })
  })

  describe("think hard patterns", () => {
    test("think hard returns high/32k", () => {
      const result = ThinkingEffort.detect("think hard")
      expect(result).toEqual({ effort: "high", budgetTokens: 32_000 })
    })

    test("think harder returns high/32k", () => {
      const result = ThinkingEffort.detect("think harder")
      expect(result).toEqual({ effort: "high", budgetTokens: 32_000 })
    })

    test("THINK HARD (case insensitive) returns high/32k", () => {
      const result = ThinkingEffort.detect("THINK HARD")
      expect(result).toEqual({ effort: "high", budgetTokens: 32_000 })
    })
  })

  describe("think at start patterns", () => {
    test("think at start returns medium/10k", () => {
      const result = ThinkingEffort.detect("think")
      expect(result).toEqual({ effort: "medium", budgetTokens: 10_000 })
    })

    test("think with newlines returns medium/10k", () => {
      const result = ThinkingEffort.detect("think\n\nDo this task")
      expect(result).toEqual({ effort: "medium", budgetTokens: 10_000 })
    })

    test("Think about this carefully returns medium/10k", () => {
      const result = ThinkingEffort.detect("Think about this carefully")
      expect(result).toEqual({ effort: "medium", budgetTokens: 10_000 })
    })

    test("THINK (case insensitive) at start returns medium/10k", () => {
      const result = ThinkingEffort.detect("THINK about it")
      expect(result).toEqual({ effort: "medium", budgetTokens: 10_000 })
    })
  })

  describe("no pattern matches", () => {
    test("I think you should returns undefined (think not at start)", () => {
      const result = ThinkingEffort.detect("I think you should...")
      expect(result).toBeUndefined()
    })

    test("empty string returns undefined", () => {
      const result = ThinkingEffort.detect("")
      expect(result).toBeUndefined()
    })

    test("random text returns undefined", () => {
      const result = ThinkingEffort.detect("do something for me")
      expect(result).toBeUndefined()
    })

    test("thinking (partial match) returns undefined", () => {
      const result = ThinkingEffort.detect("I was thinking about this")
      expect(result).toBeUndefined()
    })
  })

  describe("pattern priority", () => {
    test("ultrathink takes priority over think hard", () => {
      const result = ThinkingEffort.detect("ultrathink think hard")
      expect(result).toEqual({ effort: "high", budgetTokens: 128_000 })
    })

    test("think really hard takes priority over think hard", () => {
      const result = ThinkingEffort.detect("think really hard think hard")
      expect(result).toEqual({ effort: "high", budgetTokens: 128_000 })
    })

    test("think hard takes priority over think at start", () => {
      const result = ThinkingEffort.detect("think hard about this")
      expect(result).toEqual({ effort: "high", budgetTokens: 32_000 })
    })
  })
})
