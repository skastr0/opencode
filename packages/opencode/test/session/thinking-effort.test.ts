import { describe, expect, test } from "bun:test"
import { ThinkingEffort } from "../../src/session/thinking-effort"

describe("ThinkingEffort", () => {
  test("exports BUDGET_HIGH", () => {
    expect(ThinkingEffort.BUDGET_HIGH).toBe(16_000)
  })

  test("exports BUDGET_MEDIUM", () => {
    expect(ThinkingEffort.BUDGET_MEDIUM).toBe(10_000)
  })

  test("exports BUDGET_LOW", () => {
    expect(ThinkingEffort.BUDGET_LOW).toBe(4_000)
  })

  test("resolve returns undefined without input", () => {
    expect(ThinkingEffort.resolve()).toBeUndefined()
  })

  test("resolve defaults to medium effort and budget", () => {
    expect(ThinkingEffort.resolve({})).toEqual({
      effort: "medium",
      budgetTokens: ThinkingEffort.BUDGET_MEDIUM,
    })
  })

  test("resolve uses effort defaults when budgetTokens is missing", () => {
    expect(ThinkingEffort.resolve({ effort: "high" })).toEqual({
      effort: "high",
      budgetTokens: ThinkingEffort.BUDGET_HIGH,
    })
  })

  test("resolve preserves explicit budgetTokens", () => {
    expect(ThinkingEffort.resolve({ effort: "low", budgetTokens: 1234 })).toEqual({
      effort: "low",
      budgetTokens: 1234,
    })
  })

  test("budgets are within safe provider limits", () => {
    // Anthropic max: 32,000
    // Google Flash max: 24,576
    const SAFE_MAX = 24_576
    expect(ThinkingEffort.BUDGET_HIGH).toBeLessThanOrEqual(SAFE_MAX)
    expect(ThinkingEffort.BUDGET_MEDIUM).toBeLessThanOrEqual(SAFE_MAX)
    expect(ThinkingEffort.BUDGET_LOW).toBeLessThanOrEqual(SAFE_MAX)
  })
})
