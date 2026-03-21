import { InputRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import * as fuzzysort from "fuzzysort"
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

type DirRow = {
  type: "dir"
  key: string
  stage: Stage
  name: string
  collapsed: boolean
  fileCount: number
}

type FileRow = {
  type: "file"
  item: Item
}

type Row = DirRow | FileRow

export function FileList(props: {
  onSelect?: (value: FileSelection) => void
  onSummary?: (value: FileTotals) => void
  onDirHighlight?: (isDir: boolean) => void
  comments?: Map<string, number>
}) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const dialog = useDialog()
  const [index, setIndex] = createSignal(0)
  const [collapsed, setCollapsed] = createSignal<Map<string, boolean>>(new Map())
  const [filter, setFilter] = createSignal("")
  const [editing, setEditing] = createSignal(false)
  let inputRef: InputRenderable | undefined

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

  const filtered = createMemo(() => {
    const list = status() ?? []
    const needle = filter()
    if (!needle) return list
    return fuzzysort.go(needle, list, { key: "path" }).map((r) => r.obj)
  })

  const groups = createMemo<Group[]>(() => {
    const list = filtered()
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

  // Prune stale collapse keys when groups change (e.g. after refetch)
  // Skip while filter is active — filtered groups omit dirs that should keep their state
  createEffect(() => {
    const current = groups()
    if (filter().length > 0) return
    const valid = new Set<string>()
    for (const group of current) {
      for (const dir of group.dirs) {
        valid.add(`${group.stage}:${dir.name}`)
      }
    }
    const prev = collapsed()
    if (prev.size === 0) return
    let pruned = false
    const next = new Map(prev)
    for (const key of next.keys()) {
      if (!valid.has(key)) {
        next.delete(key)
        pruned = true
      }
    }
    if (pruned) setCollapsed(next)
  })

  function isCollapsed(key: string) {
    return collapsed().get(key) ?? false
  }

  function toggleDir(key: string) {
    const prev = collapsed()
    const next = new Map(prev)
    next.set(key, !(prev.get(key) ?? false))
    setCollapsed(next)
  }

  const visibleRows = createMemo<Row[]>(() => {
    const result: Row[] = []
    const filtering = filter().length > 0
    for (const group of groups()) {
      for (const dir of group.dirs) {
        const key = `${group.stage}:${dir.name}`
        const dirCollapsed = filtering ? false : isCollapsed(key)
        result.push({
          type: "dir",
          key,
          stage: group.stage,
          name: dir.name,
          collapsed: dirCollapsed,
          fileCount: dir.files.length,
        })
        if (!dirCollapsed) {
          for (const item of dir.files) {
            result.push({ type: "file", item })
          }
        }
      }
    }
    return result
  })

  const allFiles = createMemo(() => groups().flatMap((group) => group.files))
  const summary = createMemo<FileTotals>(() => {
    const list = allFiles()
    return {
      files: list.length,
      added: list.reduce((total, item) => total + item.added, 0),
      removed: list.reduce((total, item) => total + item.removed, 0),
    }
  })

  // Map from file id → index in visibleRows for mouse click lookup
  const positions = createMemo(() => {
    const map = new Map<string, number>()
    const rows = visibleRows()
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (row.type === "file") map.set(row.item.id, i)
      if (row.type === "dir") map.set(row.key, i)
    }
    return map
  })

  const selectedRow = createMemo(() => visibleRows()[index()])
  const selectedFile = createMemo(() => {
    const row = selectedRow()
    if (row?.type === "file") return row.item
    return undefined
  })

  createEffect(() => props.onSummary?.(summary()))
  createEffect(() => {
    const item = selectedFile()
    if (!item) return
    props.onSelect?.({
      id: item.id,
      path: item.path,
      stage: item.stage,
      status: item.status,
    })
  })
  createEffect(() => props.onDirHighlight?.(selectedRow()?.type === "dir"))

  // Clamp index when visibleRows shrinks and remap selection when collapsed away
  createEffect(() => {
    const rows = visibleRows()
    const total = rows.length
    if (total === 0) {
      setIndex(0)
      return
    }
    const current = index()
    if (current >= total) {
      // Clamp to last row — find nearest file row from end
      for (let i = total - 1; i >= 0; i--) {
        if (rows[i].type === "file") {
          setIndex(i)
          return
        }
      }
      setIndex(total - 1)
      return
    }
    // Current row is still valid, no adjustment needed
  })

  // When collapse state changes, remap selection to nearest visible file if current selection was hidden
  let lastSelectedId: string | undefined
  createEffect(() => {
    const rows = visibleRows()
    if (rows.length === 0) return
    const current = index()
    const row = rows[current]

    // Track last known file selection
    if (row?.type === "file") {
      lastSelectedId = row.item.id
      return
    }

    // If we're on a dir row or out of bounds, try to find last selected file
    if (lastSelectedId) {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        if (r.type === "file" && r.item.id === lastSelectedId) {
          setIndex(i)
          return
        }
      }
    }

    // Last selected file not visible — find nearest file row downward from current, then upward
    for (let i = Math.min(current, rows.length - 1); i < rows.length; i++) {
      if (rows[i].type === "file") {
        setIndex(i)
        return
      }
    }
    for (let i = Math.min(current, rows.length - 1); i >= 0; i--) {
      if (rows[i].type === "file") {
        setIndex(i)
        return
      }
    }
  })

  // Restore selection when filter is cleared
  let snapshotId: string | undefined
  createEffect(() => {
    const needle = filter()
    const rows = visibleRows()
    if (needle.length > 0) return
    if (!snapshotId) return
    const target = snapshotId
    snapshotId = undefined
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (row.type === "file" && row.item.id === target) {
        setIndex(i)
        return
      }
    }
  })

  function move(delta: number) {
    const rows = visibleRows()
    const total = rows.length
    if (total === 0) return
    let next = index() + delta
    if (next < 0) next = total - 1
    if (next >= total) next = 0
    setIndex(next)
  }

  function choose(item?: Item) {
    if (!item) return
    props.onSelect?.({
      id: item.id,
      path: item.path,
      stage: item.stage,
      status: item.status,
    })
  }

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    if (editing()) {
      if (evt.name === "escape") {
        evt.preventDefault()
        setEditing(false)
        setFilter("")
        if (inputRef) inputRef.value = ""
      }
      return
    }

    if (evt.name === "/") {
      evt.preventDefault()
      // Snapshot current selection before entering filter mode
      const row = selectedRow()
      if (row?.type === "file") snapshotId = row.item.id
      setEditing(true)
      setTimeout(() => {
        if (!inputRef) return
        if (inputRef.isDestroyed) return
        inputRef.focus()
      }, 1)
      return
    }

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
      const row = selectedRow()
      if (row?.type === "dir") {
        toggleDir(row.key)
        return
      }
      choose(selectedFile())
      return
    }
    if (evt.name === "space") {
      evt.preventDefault()
      const row = selectedRow()
      if (row?.type === "dir") {
        toggleDir(row.key)
        return
      }
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

      <Show when={editing()}>
        <box flexShrink={0}>
          <input
            ref={(r: InputRenderable) => {
              inputRef = r
              setTimeout(() => {
                if (!inputRef) return
                if (inputRef.isDestroyed) return
                inputRef.focus()
              }, 1)
            }}
            placeholder="Filter files…"
            cursorColor={theme.primary}
            focusedBackgroundColor={theme.backgroundPanel}
            focusedTextColor={theme.text}
            onInput={(e: string) => setFilter(e)}
          />
        </box>
      </Show>

      <Show
        when={!status.loading && allFiles().length > 0}
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
                    {(dir) => {
                      const key = `${group.stage}:${dir.name}`
                      const dirCollapsed = () => (filter().length > 0 ? false : isCollapsed(key))
                      const active = () => {
                        const row = selectedRow()
                        return row?.type === "dir" && row.key === key
                      }
                      return (
                        <box>
                          <box
                            backgroundColor={active() ? theme.primary : undefined}
                            flexDirection="row"
                            justifyContent="space-between"
                            paddingLeft={2}
                            paddingRight={1}
                            onMouseDown={() => {
                              const at = positions().get(key)
                              if (at === undefined) return
                              setIndex(at)
                            }}
                            onMouseUp={() => toggleDir(key)}
                          >
                            <text fg={active() ? selectedForeground(theme, theme.primary) : theme.textMuted}>
                              {dirCollapsed() ? "▶" : "▼"} {dir.name === "." ? "root/" : `${dir.name}/`}
                            </text>
                            <text fg={active() ? selectedForeground(theme, theme.primary) : theme.textMuted}>
                              {dir.files.length}
                            </text>
                          </box>
                          <Show when={!dirCollapsed()}>
                            <For each={dir.files}>
                              {(item) => {
                                const fileActive = () => selectedFile()?.id === item.id
                                const fg = () => (fileActive() ? selectedForeground(theme, theme.primary) : theme.text)
                                const count = () =>
                                  fileActive() ? selectedForeground(theme, theme.primary) : undefined
                                return (
                                  <box
                                    backgroundColor={fileActive() ? theme.primary : undefined}
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
                          </Show>
                        </box>
                      )
                    }}
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
