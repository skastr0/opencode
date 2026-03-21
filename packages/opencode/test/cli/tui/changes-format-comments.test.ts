import { describe, expect, test } from "bun:test"
import {
  formatComments,
  lineAnchors,
  mergePromptInput,
  type ReviewComment,
} from "../../../src/cli/cmd/tui/routes/changes/format-comments"

describe("changes.format-comments", () => {
  test("formats comments with stable file/stage/line ordering", () => {
    const comments: ReviewComment[] = [
      { file: "src/b.ts", stage: "unstaged", line: 9, text: "B" },
      { file: "src/a.ts", stage: "staged", line: 42, text: "A" },
    ]
    expect(formatComments(comments)).toBe(
      "Review comments on current changes:\n\n**src/a.ts:42 (staged)** - A\n**src/b.ts:9 (unstaged)** - B",
    )
  })

  test("appends formatted comments to existing prompt input", () => {
    expect(mergePromptInput("Existing prompt", "New block")).toBe("Existing prompt\n\nNew block")
    expect(mergePromptInput("", "New block")).toBe("New block")
  })

  test("extracts deterministic line anchors for modified and deleted hunks", () => {
    const patch = {
      hunks: [
        {
          oldStart: 10,
          newStart: 10,
          lines: [" context", "-old", " context 2"],
        },
      ],
    }
    expect(lineAnchors(patch, "modified")).toEqual([10, 11])
    expect(lineAnchors(patch, "deleted")).toEqual([10, 11, 12])
  })
})
