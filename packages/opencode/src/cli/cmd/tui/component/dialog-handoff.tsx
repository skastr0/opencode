import { createSignal, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { useLocal } from "../context/local"
import { useRoute } from "@tui/context/route"
import { useToast } from "../ui/toast"
import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { onMount } from "solid-js"

interface DialogHandoffProps {
  sessionID: string
}

export function DialogHandoff(props: DialogHandoffProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const local = useLocal()
  const route = useRoute()
  const toast = useToast()
  const { theme } = useTheme()
  const [isSubmitting, setIsSubmitting] = createSignal(false)
  let textarea: TextareaRenderable

  function handleSubmit() {
    // Prevent double submission
    if (isSubmitting()) return

    const selectedModel = local.model.current()
    if (!selectedModel) {
      toast.show({
        message: "Select a model to create a handoff session",
        variant: "warning",
      })
      return
    }

    const instruction = textarea.plainText.trim()
    if (!instruction) {
      toast.show({
        message: "Add a brief handoff focus before submitting",
        variant: "warning",
      })
      return
    }

    setIsSubmitting(true)

    sdk.client.session
      .handoff({
        sessionID: props.sessionID,
        instruction,
        modelID: selectedModel.modelID,
        providerID: selectedModel.providerID,
      })
      .then((result) => {
        // Navigate directly to the new session (following Fork pattern)
        route.navigate({
          type: "session",
          sessionID: result.data!.id,
        })
        dialog.clear()
      })
      .catch(() => {
        toast.show({
          message: "Failed to create handoff session",
          variant: "error",
        })
        setIsSubmitting(false)
      })
  }

  useKeyboard((evt) => {
    if (evt.name === "return" && !isSubmitting()) {
      handleSubmit()
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      textarea.focus()
    }, 1)
    textarea.gotoLineEnd()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Handoff Session
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <box gap={1}>
        <text fg={theme.textMuted}>
          Create a new session with summarized context. What should the new session focus on?
        </text>
        <textarea
          onSubmit={() => {
            if (!isSubmitting()) handleSubmit()
          }}
          height={3}
          keyBindings={[{ name: "return", action: "submit" }]}
          ref={(val: TextareaRenderable) => (textarea = val)}
          placeholder="Continue working on..."
          textColor={isSubmitting() ? theme.textMuted : theme.text}
          focusedTextColor={isSubmitting() ? theme.textMuted : theme.text}
          cursorColor={theme.text}
        />
      </box>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <Show
          when={!isSubmitting()}
          fallback={
            <text fg={theme.accent}>
              <span style={{ bold: true }}>Creating handoff...</span>
            </text>
          }
        >
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>submit</span>
          </text>
        </Show>
      </box>
    </box>
  )
}
