import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import { TuiEvent } from "../cli/cmd/tui/event"
import { FileTime } from "../file/time"
import { Log } from "../util/log"
import { fn } from "@/util/fn"
import z from "zod"
import { Agent } from "@/agent/agent"
import { SessionPrompt } from "./prompt"
import { LLM } from "./llm"
import { Global } from "../global"
import path from "path"
import PROMPT_HANDOFF from "./prompt/handoff.txt"

export namespace SessionHandoff {
  const log = Log.create({ service: "session.handoff" })

  // Lock to prevent concurrent handoffs from the same session
  const activeHandoffs = new Set<string>()

  export const Event = {
    Completed: BusEvent.define(
      "session.handoff.completed",
      z.object({
        sourceSessionID: z.string(),
        targetSessionID: z.string(),
      }),
    ),
  }

  /**
   * Generate a skeleton of the session conversation for context preservation.
   * Format: numbered list with role, truncated content, and tools used.
   */
  function generateSessionSkeleton(msgs: Awaited<ReturnType<typeof Session.messages>>, maxLength = 150): string {
    const skeleton: string[] = []

    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      const role = msg.info.role === "user" ? "User" : "Assistant"

      // Extract text content
      const textParts = msg.parts
        .filter((p): p is MessageV2.TextPart => p.type === "text")
        .map((p) => p.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()

      // Extract tool names used
      const toolNames = msg.parts
        .filter((p): p is MessageV2.ToolPart => p.type === "tool")
        .map((p) => p.tool)
        .filter((v, i, arr) => arr.indexOf(v) === i) // unique

      // Truncate text for skeleton
      const truncatedText = textParts.length > maxLength ? textParts.slice(0, maxLength) + "..." : textParts

      let entry = `${i + 1}. **${role}**: ${truncatedText || "(no text)"}`
      if (toolNames.length > 0) {
        entry += `\n   - Tools: ${toolNames.join(", ")}`
      }

      skeleton.push(entry)
    }

    return skeleton.join("\n")
  }

  /**
   * Extract list of files that were modified (written/edited) during the session
   * by scanning tool calls for write/edit operations.
   */
  function getModifiedFiles(msgs: Awaited<ReturnType<typeof Session.messages>>): string[] {
    const modified = new Set<string>()
    const editTools = ["edit", "write", "morph-mcp_edit_file"]

    for (const msg of msgs) {
      for (const part of msg.parts) {
        if (part.type !== "tool") continue
        if (!editTools.includes(part.tool)) continue

        // Extract file path from tool input (input is inside state)
        const input = part.state.input as Record<string, unknown>
        const filePath = (input.filePath || input.path || input.file) as string | undefined
        if (filePath) {
          // Normalize path relative to worktree
          const relativePath = filePath.replace(Instance.worktree + "/", "")
          modified.add(relativePath)
        }
      }
    }

    return Array.from(modified).sort()
  }

  /**
   * Get the file path where the session is stored.
   */
  function getSessionFilePath(sessionID: string, projectID: string): string {
    return path.join(Global.Path.data, "storage", "session", projectID, `${sessionID}.json`)
  }

  export const create = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      instruction: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
    }),
    async (input) => {
      // Prevent concurrent handoffs from the same session
      if (activeHandoffs.has(input.sessionID)) {
        log.warn("handoff already in progress, ignoring duplicate request", {
          sessionID: input.sessionID,
        })
        throw new Error("Handoff already in progress for this session")
      }
      activeHandoffs.add(input.sessionID)

      try {
        log.info("starting handoff", {
          sessionID: input.sessionID,
          instruction: input.instruction,
        })

        // Cancel any existing generation in the source session
        SessionPrompt.cancel(input.sessionID)

        // Get the original session for title
        const originalSession = await Session.get(input.sessionID)

        const msgs = await Session.messages({ sessionID: input.sessionID })

        // Generate session skeleton and file lists
        const sessionSkeleton = generateSessionSkeleton(msgs)
        const modifiedFiles = getModifiedFiles(msgs)
        const sessionFilePath = getSessionFilePath(input.sessionID, originalSession.projectID)

        // Files read during session
        const filesRead = FileTime.state().read[input.sessionID] ?? {}
        const filesReadList = Object.keys(filesRead)
          .map((f) => f.replace(Instance.worktree + "/", ""))
          .sort()

        // Use summary agent for handoff
        const agent = await Agent.get("summary")
        const model = agent.model
          ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
          : await Provider.getModel(input.model.providerID, input.model.modelID)

        // Get the last user message for context
        const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
        if (!lastUserMsg) {
          throw new Error("No user messages found in session")
        }
        const userMessage = lastUserMsg.info as MessageV2.User

        const promptText = [
          PROMPT_HANDOFF,
          ``,
          `The user wants to hand off this session with the following instruction:`,
          ``,
          `<instruction>`,
          input.instruction,
          `</instruction>`,
          ``,
          `Please provide a BRIEF summary (2-4 sentences) of the current state and next steps.`,
          `Focus on what's working, what's not, and the immediate next action.`,
          `Do NOT repeat the session skeleton or file lists - those are already included.`,
        ]
          .filter(Boolean)
          .join("\n")

        // Use LLM directly WITHOUT creating a temp message in the source session
        // This prevents the "glitchy generation" from appearing behind the modal
        const abort = new AbortController()
        const stream = await LLM.stream({
          user: userMessage,
          agent,
          abort: abort.signal,
          sessionID: input.sessionID,
          tools: {},
          system: [],
          messages: [
            ...MessageV2.toModelMessage(msgs),
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: promptText,
                },
              ],
            },
          ],
          model,
        })

        // Collect the full text response
        let llmSummary = ""
        for await (const chunk of stream.fullStream) {
          if (chunk.type === "text-delta") {
            llmSummary += chunk.text
          }
        }

        if (!llmSummary.trim()) {
          llmSummary = "Continuing work from previous session."
        }

        // Build the comprehensive handoff summary with skeleton and references
        const summaryText = [
          `## Continuing from Session: ${input.sessionID}`,
          ``,
          `### Source Session`,
          `- **Session ID**: ${input.sessionID}`,
          `- **File Path**: ${sessionFilePath}`,
          `- **Message Count**: ${msgs.length}`,
          ``,
          `### Current State`,
          llmSummary,
          ``,
          modifiedFiles.length > 0 ? [`### Files Modified`, ...modifiedFiles.map((f) => `- ${f}`)].join("\n") : "",
          ``,
          filesReadList.length > 0
            ? [
                `### Files Read`,
                ...filesReadList.slice(0, 20).map((f) => `- ${f}`),
                filesReadList.length > 20 ? `- ... and ${filesReadList.length - 20} more` : "",
              ]
                .filter(Boolean)
                .join("\n")
            : "",
          ``,
          `### Conversation Skeleton`,
          `<details>`,
          `<summary>Click to expand (${msgs.length} messages)</summary>`,
          ``,
          sessionSkeleton,
          ``,
          `</details>`,
        ]
          .filter(Boolean)
          .join("\n")

        log.info("handoff summary generated", { length: summaryText.length })

        // Create new session with [Handoff] prefix title
        const title = originalSession.title.startsWith("[Handoff] ")
          ? originalSession.title
          : `[Handoff] ${originalSession.title}`

        const newSession = await Session.createNext({
          directory: Instance.directory,
          title,
        })

        const msg = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: newSession.id,
          agent: userMessage.agent,
          model: input.model,
          time: {
            created: Date.now(),
          },
        })

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: msg.id,
          sessionID: newSession.id,
          type: "text",
          synthetic: true,
          text: summaryText,
          time: {
            start: Date.now(),
            end: Date.now(),
          },
        })

        log.info("handoff complete", {
          sourceSessionID: input.sessionID,
          targetSessionID: newSession.id,
        })

        Bus.publish(TuiEvent.SessionSelect, {
          sessionID: newSession.id,
        })

        Bus.publish(Event.Completed, {
          sourceSessionID: input.sessionID,
          targetSessionID: newSession.id,
        })

        return newSession
      } finally {
        activeHandoffs.delete(input.sessionID)
      }
    },
  )
}
