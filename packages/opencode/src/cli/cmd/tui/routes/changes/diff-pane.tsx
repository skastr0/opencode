import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { useKV } from "@tui/context/kv"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useToast } from "@tui/ui/toast"
import type { ScrollBoxRenderable } from "@opentui/core"
import path from "path"
import { createEffect, createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import type { FileSelection, Stage } from "./file-list"
import { lineAnchors, type ReviewComment } from "./format-comments"

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

const textExtensions = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "md",
  "txt",
  "css",
  "scss",
  "html",
  "yaml",
  "yml",
  "toml",
  "sh",
  "py",
  "go",
  "rs",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
])

function isTextPath(input?: string) {
  if (!input) return false
  const ext = path.extname(input).toLowerCase().slice(1)
  return textExtensions.has(ext)
}

function makeDiff(file: string, content: string, status: "added" | "deleted") {
  const lines = content.length ? content.split("\n") : []
  const count = lines.length
  if (status === "added") {
    return [
      `diff --git a/${file} b/${file}`,
      `--- /dev/null`,
      `+++ b/${file}`,
      `@@ -0,0 +1,${count} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n")
  }
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ /dev/null`,
    `@@ -1,${count} +0,0 @@`,
    ...lines.map((line) => `-${line}`),
  ].join("\n")
}

export function DiffPane(props: {
  selection: FileSelection | null
  comments: ReviewComment[]
  onComment?: (value: ReviewComment) => void
}) {
  const sdk = useSDK()
  const sync = useSync()
  const { theme, syntax } = useTheme()
  const kv = useKV()
  const toast = useToast()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const [wrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [stage, setStage] = createSignal<Stage>("unstaged")
  const [lastLine, setLastLine] = createSignal<number>()
  let diffScroll: ScrollBoxRenderable | undefined

  const [status] = createResource(async () => {
    const result = await sdk.client.file.status()
    return result.data ?? []
  })

  createEffect(() => {
    const selection = props.selection
    if (!selection) return
    setStage(selection.stage)
  })

  const stages = createMemo<Array<"staged" | "unstaged">>(() => {
    const selection = props.selection
    if (!selection) return []
    if (selection.stage === "untracked") return []
    const list = status() ?? []
    const hasStaged = list.some((item) => item.path === selection.path && "stage" in item && item.stage === "staged")
    const hasUnstaged = list.some(
      (item) => item.path === selection.path && "stage" in item && item.stage === "unstaged",
    )
    if (hasStaged && hasUnstaged) return ["staged", "unstaged"]
    if (hasStaged) return ["staged"]
    if (hasUnstaged) return ["unstaged"]
    return []
  })

  const target = createMemo(() => {
    const selection = props.selection
    if (!selection) return
    const selected = stage()
    if (selected === "staged" || selected === "unstaged") {
      if (stages().includes(selected)) return { path: selection.path, stage: selected }
      if (selection.stage === selected) return { path: selection.path, stage: selected }
    }
    if (selection.stage === "staged" || selection.stage === "unstaged") {
      return { path: selection.path, stage: selection.stage }
    }
    return { path: selection.path, stage: undefined }
  })

  const [content] = createResource(target, async (input) => {
    const query: { path: string; stage?: "staged" | "unstaged" } = {
      path: input.path,
    }
    if (input.stage) query.stage = input.stage
    const result = await sdk.client.file.read({
      ...query,
    } as Parameters<typeof sdk.client.file.read>[0])
    return result.data
  })

  const view = createMemo(() => {
    const diffStyle = sync.data.config.tui?.diff_style
    if (diffStyle === "stacked") return "unified"
    return dimensions().width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(props.selection?.path))

  const diff = createMemo(() => {
    const selection = props.selection
    const value = content()
    if (!selection || !value) return ""
    if (value.diff?.trim()) return value.diff
    if (value.type !== "text") return ""
    if (selection.status === "added") return makeDiff(selection.path, value.content, "added")
    if (selection.status === "deleted") return makeDiff(selection.path, value.content, "deleted")
    return ""
  })

  const binary = createMemo(() => {
    const value = content()
    if (!value) return false
    if (value.diff?.includes("Binary files") || value.diff?.includes("GIT binary patch")) return true
    if (value.type !== "binary") return false
    return !isTextPath(props.selection?.path)
  })

  const anchors = createMemo(() => lineAnchors(content()?.patch, props.selection?.status ?? "modified"))

  const commentStage = createMemo<Stage>(() => {
    const selected = target()?.stage ?? props.selection?.stage
    if (selected === "staged" || selected === "unstaged" || selected === "untracked") return selected
    return "unstaged"
  })

  const comments = createMemo(() => {
    const selection = props.selection
    if (!selection) return []
    return props.comments
      .filter((item) => item.file === selection.path && item.stage === commentStage())
      .toSorted((a, b) => a.line - b.line)
  })

  const markers = createMemo(() => {
    const grouped = comments().reduce((result, item) => {
      result.set(item.line, (result.get(item.line) ?? 0) + 1)
      return result
    }, new Map<number, number>())
    return Array.from(grouped.entries()).toSorted((a, b) => a[0] - b[0])
  })

  async function addComment(line?: number) {
    const selection = props.selection
    if (!selection) return
    const available = anchors()
    if (available.length === 0) {
      toast.show({ variant: "warning", message: "No line anchors available for this diff" })
      return
    }

    const first = available[0]
    const last = available.at(-1) ?? first
    const suggested =
      line && available.includes(line)
        ? line
        : lastLine() && available.includes(lastLine()!)
          ? lastLine()!
          : (comments().at(-1)?.line ?? first)

    const chosen = line
      ? suggested
      : await (async () => {
          const lineInput = await DialogPrompt.show(dialog, "Select line", {
            placeholder: `${first}-${last}`,
            description: () => {
              return (
                <text fg={theme.textMuted}>
                  Enter a line number from the rendered diff ({available.length} available, default {suggested})
                </text>
              )
            },
          })
          if (lineInput === null) return undefined
          const value = lineInput.trim()
          const next = value.length === 0 ? suggested : Number.parseInt(value, 10)
          if (!Number.isFinite(next) || !available.includes(next)) {
            toast.show({ variant: "error", message: "Line is not visible in the current diff" })
            return undefined
          }
          return next
        })()

    if (!chosen) return
    setLastLine(chosen)

    const textInput = await DialogPrompt.show(dialog, "Add comment", {
      placeholder: `Comment for line ${chosen}`,
    })
    const text = textInput?.trim()
    if (!text) return
    props.onComment?.({ file: selection.path, stage: commentStage(), line: chosen, text })
  }

  useKeyboard(async (evt) => {
    if (evt.name !== "c") return
    if (dialog.stack.length > 0) return
    evt.preventDefault()
    await addComment()
  })

  return (
    <Show when={props.selection} fallback={<text fg={theme.textMuted}>Select a file to view changes</text>}>
      {(selection) => (
        <box width="100%" height="100%" gap={1}>
          <box flexShrink={0} flexDirection="row" justifyContent="space-between" alignItems="center">
            <text fg={theme.text} wrapMode="none" overflow="hidden">
              <b>{selection().path}</b>
            </text>
            <text fg={theme.textMuted}>{target()?.stage ?? selection().stage}</text>
          </box>

          <Show when={stages().length > 1}>
            <box flexShrink={0} flexDirection="row" gap={1}>
              <For each={stages()}>
                {(item) => {
                  const active = () => target()?.stage === item
                  const backgroundColor = () => (active() ? theme.primary : theme.backgroundElement)
                  const fg = () => (active() ? selectedForeground(theme, theme.primary) : theme.textMuted)
                  return (
                    <box
                      backgroundColor={backgroundColor()}
                      paddingLeft={1}
                      paddingRight={1}
                      onMouseUp={() => setStage(item)}
                    >
                      <text fg={fg()}>{item === "staged" ? "Staged" : "Unstaged"}</text>
                    </box>
                  )
                }}
              </For>
            </box>
          </Show>

          <Show when={markers().length > 0}>
            <box flexShrink={0} flexDirection="row" gap={1}>
              <text fg={theme.info}>{comments().length} comments</text>
              <For each={markers().slice(0, 8)}>
                {(item) => (
                  <text fg={theme.textMuted}>
                    L{item[0]}
                    <Show when={item[1] > 1}>x{item[1]}</Show>
                  </text>
                )}
              </For>
              <Show when={markers().length > 8}>
                <text fg={theme.textMuted}>+{markers().length - 8}</text>
              </Show>
            </box>
          </Show>

          <Show when={!content.loading} fallback={<text fg={theme.textMuted}>Loading diff...</text>}>
            <Switch>
              <Match when={content.error}>
                <text fg={theme.error}>Failed to load diff</text>
              </Match>
              <Match when={diff()}>
                <scrollbox
                  ref={(value: ScrollBoxRenderable) => (diffScroll = value)}
                  flexGrow={1}
                  scrollbarOptions={{ visible: false }}
                  onMouseUp={(evt) => {
                    if (dialog.stack.length > 0) return
                    const box = diffScroll
                    const available = anchors()
                    if (!box || available.length === 0) return
                    const row = Math.floor(evt.y - box.y + box.scrollTop)
                    const index = Math.max(0, Math.min(available.length - 1, row))
                    const line = available[index]
                    void addComment(line)
                  }}
                >
                  <diff
                    diff={diff()}
                    view={view()}
                    filetype={ft()}
                    syntaxStyle={syntax()}
                    showLineNumbers={true}
                    width="100%"
                    wrapMode={wrapMode()}
                    fg={theme.text}
                    addedBg={theme.diffAddedBg}
                    removedBg={theme.diffRemovedBg}
                    contextBg={theme.diffContextBg}
                    addedSignColor={theme.diffHighlightAdded}
                    removedSignColor={theme.diffHighlightRemoved}
                    lineNumberFg={theme.diffLineNumber}
                    lineNumberBg={theme.diffContextBg}
                    addedLineNumberBg={theme.diffAddedLineNumberBg}
                    removedLineNumberBg={theme.diffRemovedLineNumberBg}
                  />
                </scrollbox>
              </Match>
              <Match when={binary()}>
                <text fg={theme.textMuted}>Binary file</text>
              </Match>
              <Match when={true}>
                <text fg={theme.textMuted}>No diff for this file</text>
              </Match>
            </Switch>
          </Show>
        </box>
      )}
    </Show>
  )
}
