import { Show } from "solid-js"
import { useTheme } from "@tui/context/theme"

type ChangesFooterProps = {
  files: number
  added: number
  removed: number
  comments: number
  submit: boolean
  commenting?: boolean
  dirSelected?: boolean
}

export function ChangesFooter(props: ChangesFooterProps) {
  const { theme } = useTheme()

  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
      <box flexDirection="row" gap={1}>
        <text fg={theme.text}>{props.files} files changed</text>
        <text fg={theme.diffAdded}>+{props.added}</text>
        <text fg={theme.diffRemoved}>-{props.removed}</text>
      </box>

      <box flexDirection="row" gap={2} flexShrink={0}>
        <text fg={theme.textMuted}>esc close</text>
        <text fg={theme.textMuted}>↑↓ navigate</text>
        <text fg={theme.textMuted}>/ filter</text>
        <Show when={props.dirSelected}>
          <text fg={theme.textMuted}>space toggle</text>
        </Show>
        <Show when={props.commenting}>
          <text fg={theme.textMuted}>c comment</text>
        </Show>
        <text fg={theme.textMuted}>{props.comments} comments</text>
        <text fg={props.submit ? theme.success : theme.textMuted}>
          {props.submit ? "S submit" : "S submit (disabled)"}
        </text>
      </box>
    </box>
  )
}
