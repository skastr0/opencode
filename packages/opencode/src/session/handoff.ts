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
        const filesRead = FileTime.state().read[input.sessionID] ?? {}
        const filesList = Object.keys(filesRead)
          .map((f) => f.replace(Instance.worktree + "/", ""))
          .join("\n")

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
          filesList
            ? [`Files that were read during this session:`, `<files_read>`, filesList, `</files_read>`].join("\n")
            : "",
          ``,
          `Please provide a handoff summary.`,
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
        let summaryText = ""
        for await (const chunk of stream.fullStream) {
          if (chunk.type === "text-delta") {
            summaryText += chunk.text
          }
        }

        if (!summaryText.trim()) {
          summaryText = "Handoff from previous session."
        }

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

        Bus.publish(TuiEvent.SessionNavigate, {
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
