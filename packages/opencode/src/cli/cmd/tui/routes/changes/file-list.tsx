import { useKeyboard } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { selectedForeground, useTheme } from "@tui/context/theme"
import path from "path"
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Locale } from "@/util/locale"

const STAGES = ["staged", "unstaged", "untracked"] as const

const LABEL: Record<Stage, string> = {
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
}

export type Stage = (typeof STAGES)[number]

type Item = {
  id: string
  path: string
  added: number
  removed: number
  status: "added" | "deleted" | "modified"
  stage: Stage
}

type Group = {
  stage: Stage
  label: string
  files: Item[]
  dirs: {
    name: string
    files: Item[]
  }[]
}

export type FileSelection = {
  id: string
  path: string
  stage: Stage
  status: "added" | "deleted" | "modified"
}

export type FileTotals = {
  files: number
  added: number
  removed: number
}

export function FileList(props: {
  onSelect?: (value: FileSelection) => void
  onSummary?: (value: FileTotals) => void
  comments?: Map<string, number>
}) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const [index, setIndex] = createSignal(0)

  const [status, { refetch }] = createResource(async () => {
    const result = await sdk.client.file.status()
    const list = result.data ?? []
    return list.map((item) => {
      const raw = "stage" in item ? item.stage : undefined
      const stage = raw === "staged" || raw === "untracked" ? raw : "unstaged"
      return {
        id: `${stage}:${item.path}`,
        path: item.path,
        added: item.added,
        removed: item.removed,
        status: item.status,
        stage,
      } satisfies Item
    })
  })

  const groups = createMemo<Group[]>(() => {
    const list = status() ?? []
    return STAGES.flatMap((stage) => {
      const files = list.filter((item) => item.stage === stage).sort((a, b) => a.path.localeCompare(b.path))
      if (files.length === 0) return []
      const dirs = files.reduce((acc, item) => {
        const dir = path.posix.dirname(item.path)
        const files = acc.get(dir)
        if (files) {
          files.push(item)
          return acc
        }
        acc.set(dir, [item])
        return acc
      }, new Map<string, Item[]>())
      return [
        {
          stage,
          label: LABEL[stage],
          files,
          dirs: Array.from(dirs.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([name, files]) => ({
              name,
              files: files.sort((a, b) => a.path.localeCompare(b.path)),
            })),
        },
      ]
    })
  })

  const files = createMemo(() => groups().flatMap((group) => group.files))
  const summary = createMemo<FileTotals>(() => {
    const list = files()
    return {
      files: list.length,
      added: list.reduce((total, item) => total + item.added, 0),
      removed: list.reduce((total, item) => total + item.removed, 0),
    }
  })
  const positions = createMemo(() => new Map(files().map((item, i) => [item.id, i])))
  const selected = createMemo(() => files()[index()])

  createEffect(() => props.onSummary?.(summary()))
  createEffect(() => {
    const item = selected()
    if (!item) return
    props.onSelect?.({
      id: item.id,
      path: item.path,
      stage: item.stage,
      status: item.status,
    })
  })

  createEffect(() => {
    const total = files().length
    if (total === 0) {
      setIndex(0)
      return
    }
    if (index() >= total) setIndex(total - 1)
  })

  function move(delta: number) {
    const total = files().length
    if (total === 0) return
    const next = index() + delta
    if (next < 0) {
      setIndex(total - 1)
      return
    }
    if (next >= total) {
      setIndex(0)
      return
    }
    setIndex(next)
  }

  function choose(item = selected()) {
    if (!item) return
    props.onSelect?.({
      id: item.id,
      path: item.path,
      stage: item.stage,
      status: item.status,
    })
  }

  useKeyboard((evt) => {
    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      move(-1)
      return
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      move(1)
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      choose()
      return
    }
    if (evt.name === "r") {
      evt.preventDefault()
      refetch()
    }
  })

  return (
    <box width="100%" height="100%" paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text}>
          <b>Files</b>
        </text>
        <text fg={theme.textMuted} onMouseUp={() => refetch()}>
          {status.loading ? "Refreshing..." : "Refresh [r]"}
        </text>
      </box>

      <Show
        when={!status.loading && files().length > 0}
        fallback={
          <box gap={1} paddingTop={1}>
            <text fg={theme.textMuted}>{status.loading ? "Loading changes..." : "No changes"}</text>
            <text fg={theme.textMuted} onMouseUp={() => refetch()}>
              Refresh [r]
            </text>
          </box>
        }
      >
        <scrollbox flexGrow={1} scrollbarOptions={{ visible: false }}>
          <box gap={1}>
            <For each={groups()}>
              {(group) => (
                <box>
                  <text
                    fg={
                      {
                        staged: theme.success,
                        unstaged: theme.warning,
                        untracked: theme.info,
                      }[group.stage]
                    }
                  >
                    <b>
                      {group.label} ({group.files.length})
                    </b>
                  </text>
                  <For each={group.dirs}>
                    {(dir) => (
                      <box>
                        <text fg={theme.textMuted}>{dir.name === "." ? "  root/" : `  ${dir.name}/`}</text>
                        <For each={dir.files}>
                          {(item) => {
                            const active = () => selected()?.id === item.id
                            const fg = () => (active() ? selectedForeground(theme, theme.primary) : theme.text)
                            const count = () => (active() ? selectedForeground(theme, theme.primary) : undefined)
                            return (
                              <box
                                backgroundColor={active() ? theme.primary : undefined}
                                flexDirection="row"
                                justifyContent="space-between"
                                paddingLeft={4}
                                paddingRight={1}
                                onMouseDown={() => {
                                  const at = positions().get(item.id)
                                  if (at === undefined) return
                                  setIndex(at)
                                }}
                                onMouseUp={() => choose(item)}
                              >
                                <text fg={fg()} wrapMode="none" overflow="hidden">
                                  {Locale.truncate(item.path, 24)}
                                </text>
                                <box flexDirection="row" gap={1} flexShrink={0}>
                                  <Show when={(props.comments?.get(item.id) ?? 0) > 0}>
                                    <text fg={count() ?? theme.info}>{props.comments?.get(item.id)}c</text>
                                  </Show>
                                  <text fg={count() ?? theme.diffAdded}>+{item.added}</text>
                                  <text fg={count() ?? theme.diffRemoved}>-{item.removed}</text>
                                </box>
                              </box>
                            )
                          }}
                        </For>
                      </box>
                    )}
                  </For>
                </box>
              )}
            </For>
          </box>
        </scrollbox>
      </Show>
    </box>
  )
}
