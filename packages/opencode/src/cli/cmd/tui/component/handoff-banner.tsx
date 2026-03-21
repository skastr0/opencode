import { createSignal, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"

export function HandoffBanner(props: { summary: string }) {
  const { theme, syntax } = useTheme()
  const [expanded, setExpanded] = createSignal(true)

  return (
    <box
      border={["left"]}
      borderColor={theme.accent}
      customBorderChars={SplitBorder.customBorderChars}
      marginBottom={1}
    >
      <box
        paddingTop={1}
        paddingBottom={expanded() ? 0 : 1}
        paddingLeft={2}
        backgroundColor={theme.backgroundPanel}
        onMouseUp={() => setExpanded((prev) => !prev)}
      >
        <text fg={theme.accent}>
          <span style={{ bold: true }}>{expanded() ? "▼" : "▶"} Handoff Context</span>
        </text>
      </box>
      <Show when={expanded()}>
        <box paddingLeft={2} paddingBottom={1} backgroundColor={theme.backgroundPanel}>
          <code
            filetype="markdown"
            drawUnstyledText={false}
            streaming={false}
            syntaxStyle={syntax()}
            content={props.summary}
            fg={theme.text}
          />
        </box>
      </Show>
    </box>
  )
}
