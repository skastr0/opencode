export namespace ThinkingEffort {
  export type Level = {
    effort: "low" | "medium" | "high"
    budgetTokens: number
  }

  export type Input = {
    effort?: Level["effort"]
    budgetTokens?: number
  }

  // Safe cross-provider budget defaults:
  // - Anthropic max: 32,000 (docs.anthropic.com/en/build-with-claude/extended-thinking)
  // - Google Flash max: 24,576, Pro max: 32,768 (ai.google.dev/gemini-api/docs/thinking)
  // buildThinkingOptions() clamps to provider-specific limits
  export const BUDGET_HIGH = 16_000
  export const BUDGET_MEDIUM = 10_000
  export const BUDGET_LOW = 4_000

  export function budgetFor(effort: Level["effort"]): number {
    if (effort === "high") return BUDGET_HIGH
    if (effort === "low") return BUDGET_LOW
    return BUDGET_MEDIUM
  }

  export function resolve(input?: Input): Level | undefined {
    if (!input) return undefined
    const effort = input.effort ?? "medium"
    const budgetTokens = input.budgetTokens ?? budgetFor(effort)
    return { effort, budgetTokens }
  }
}
