export namespace ThinkingEffort {
  export type Level = {
    effort: "low" | "medium" | "high"
    budgetTokens: number
  }

  export function detect(text: string): Level | undefined {
    const lower = text.toLowerCase().trim()

    // Check ultrathink first (most specific)
    if (lower.includes("ultrathink") || lower.includes("think really hard")) {
      return { effort: "high", budgetTokens: 128_000 }
    }

    // Check think hard
    if (lower.includes("think hard") || lower.includes("think harder")) {
      return { effort: "high", budgetTokens: 32_000 }
    }

    // Check basic think (only at start)
    if (lower.startsWith("think")) {
      return { effort: "medium", budgetTokens: 10_000 }
    }

    return undefined
  }
}
