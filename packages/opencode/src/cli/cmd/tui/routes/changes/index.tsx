import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { usePromptRef } from "@tui/context/prompt"
import { useRoute, useRouteData } from "@tui/context/route"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { DiffPane } from "./diff-pane"
import { FileList, type FileSelection, type FileTotals } from "./file-list"
import { formatComments, mergePromptInput, type ReviewComment } from "./format-comments"
import { ChangesFooter } from "./footer"

export function Changes() {
  const route = useRouteData("changes")
  const { navigate } = useRoute()
  const { theme } = useTheme()
  const toast = useToast()
  const prompt = usePromptRef()
  const dimensions = useTerminalDimensions()
  const [selected, setSelected] = createSignal<FileSelection | null>(null)
  const [summary, setSummary] = createSignal<FileTotals>({ files: 0, added: 0, removed: 0 })
  const [comments, setComments] = createStore<ReviewComment[]>([])

  const commentTotal = createMemo(() => comments.length)
  const commentCount = createMemo(() => {
    const result = new Map<string, number>()
    for (const comment of comments) {
      const key = `${comment.stage}:${comment.file}`
      result.set(key, (result.get(key) ?? 0) + 1)
    }
    return result
  })

  function submit() {
    if (comments.length === 0) {
      toast.show({ variant: "warning", message: "No comments to submit" })
      return
    }
    const block = formatComments(comments)
    const current =
      prompt.current?.current ??
      (route.returnTo?.type === "home" || route.returnTo?.type === "session" ? route.returnTo.initialPrompt : undefined)
    const initialPrompt = {
      input: mergePromptInput(current?.input ?? "", block),
      parts: current?.parts ?? [],
    }
    const target = route.returnTo
    setComments([])
    if (!target || target.type === "home") {
      navigate({ type: "home", initialPrompt })
      return
    }
    navigate({ type: "session", sessionID: target.sessionID, initialPrompt })
  }

  useKeyboard((evt) => {
    if (evt.name === "S" || (evt.name === "s" && evt.shift)) {
      evt.preventDefault()
      submit()
      return
    }
    if (evt.name !== "escape") return
    navigate(route.returnTo ?? { type: "home" })
  })

  return (
    <box width={dimensions().width} height={dimensions().height} padding={1} flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1} flexGrow={1}>
        <box width={38} height="100%" backgroundColor={theme.backgroundPanel}>
          <FileList onSelect={setSelected} onSummary={setSummary} comments={commentCount()} />
        </box>
        <box flexGrow={1} height="100%" backgroundColor={theme.backgroundPanel} padding={1}>
          <DiffPane
            selection={selected()}
            comments={comments}
            onComment={(comment) => setComments(comments.length, comment)}
          />
        </box>
      </box>
      <ChangesFooter
        files={summary().files}
        added={summary().added}
        removed={summary().removed}
        comments={commentTotal()}
        submit={commentTotal() > 0}
        commenting={!!selected()}
      />
    </box>
  )
}
