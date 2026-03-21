import type { Stage } from "./file-list"

export type ReviewComment = {
  file: string
  stage: Stage
  line: number
  text: string
}

type Patch = {
  hunks: {
    oldStart: number
    newStart: number
    lines: string[]
  }[]
}

export function lineAnchors(patch: Patch | undefined, status: "added" | "deleted" | "modified") {
  if (!patch) return []
  const side = status === "deleted" ? "old" : "new"
  const result = [] as number[]

  for (const hunk of patch.hunks) {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart

    for (const line of hunk.lines) {
      const mark = line[0]
      if (mark === "\\") continue

      if (mark === "-") {
        if (side === "old") result.push(oldLine)
        oldLine += 1
        continue
      }

      if (mark === "+") {
        if (side === "new") result.push(newLine)
        newLine += 1
        continue
      }

      if (side === "old") result.push(oldLine)
      if (side === "new") result.push(newLine)
      oldLine += 1
      newLine += 1
    }
  }

  return Array.from(new Set(result.filter((line) => Number.isInteger(line) && line > 0)))
}

export function formatComments(comments: ReviewComment[]) {
  const lines = comments
    .slice()
    .sort((a, b) => a.file.localeCompare(b.file) || a.stage.localeCompare(b.stage) || a.line - b.line)
    .map((comment) => {
      return `**${comment.file}:${comment.line} (${comment.stage})** - ${comment.text.trim()}`
    })

  return ["Review comments on current changes:", "", ...lines].join("\n")
}

export function mergePromptInput(input: string, block: string) {
  const base = input.trimEnd()
  if (!base) return block
  return `${base}\n\n${block}`
}
