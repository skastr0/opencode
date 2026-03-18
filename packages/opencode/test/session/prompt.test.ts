import path from "path"
import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "url"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import { SessionPrompt } from "../../src/session/prompt"
import { TaskTool } from "../../src/tool/task"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("session.prompt missing file", () => {
  test("does not fail the prompt when a file part is missing", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "does-not-exist.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "please review @does-not-exist.ts" },
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "does-not-exist.ts",
            },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const hasFailure = msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
        )
        expect(hasFailure).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("keeps stored part order stable when file resolution is async", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "still-missing.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "still-missing.ts",
            },
            { type: "text", text: "after-file" },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const stored = await MessageV2.get({
          sessionID: session.id,
          messageID: msg.info.id,
        })
        const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

        expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
        expect(text[1]?.includes("Read tool failed to read")).toBe(true)
        expect(text[2]).toBe("after-file")

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt special characters", () => {
  test("handles filenames with # character", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "file#name.txt"), "special content\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const template = "Read @file#name.txt"
        const parts = await SessionPrompt.resolvePromptParts(template)
        const fileParts = parts.filter((part) => part.type === "file")

        expect(fileParts.length).toBe(1)
        expect(fileParts[0].filename).toBe("file#name.txt")
        expect(fileParts[0].url).toContain("%23")

        const decodedPath = fileURLToPath(fileParts[0].url)
        expect(decodedPath).toBe(path.join(tmp.path, "file#name.txt"))

        const message = await SessionPrompt.prompt({
          sessionID: session.id,
          parts,
          noReply: true,
        })
        const stored = await MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        const textParts = stored.parts.filter((part) => part.type === "text")
        const hasContent = textParts.some((part) => part.text.includes("special content"))
        expect(hasContent).toBe(true)

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt agent variant", () => {
  test("applies agent variant only when using agent model", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
              variant: "xhigh",
            },
          },
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})

          const other = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          })
          if (other.info.role !== "user") throw new Error("expected user message")
          expect(other.info.variant).toBeUndefined()

          const match = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello again" }],
          })
          if (match.info.role !== "user") throw new Error("expected user message")
          expect(match.info.model).toEqual({ providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") })
          expect(match.info.variant).toBe("xhigh")

          const override = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            variant: "high",
            parts: [{ type: "text", text: "hello third" }],
          })
          if (override.info.role !== "user") throw new Error("expected user message")
          expect(override.info.variant).toBe("high")

          await Session.remove(session.id)
        },
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })
})

describe("session.prompt fast", () => {
  test("uses agent fast by default and lets input override it", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.4",
            fast: true,
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const match = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })

        if (match.info.role !== "user") throw new Error("expected user message")
        expect(match.info.fast).toBe(true)

        const override = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          fast: false,
          noReply: true,
          parts: [{ type: "text", text: "hello again" }],
        })

        if (override.info.role !== "user") throw new Error("expected user message")
        expect(override.info.fast).toBe(false)

        await Session.remove(session.id)
      },
    })
  })

  test("stores fast on user messages and preserves it when forking a session", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.4",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.openai, modelID: ModelID.make("gpt-5.4") },
          fast: true,
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")
        expect(msg.info.fast).toBe(true)

        const stored = await MessageV2.get({
          sessionID: session.id,
          messageID: msg.info.id,
        })
        if (stored.info.role !== "user") throw new Error("expected stored user message")
        expect(stored.info.fast).toBe(true)

        const fork = await Session.fork({ sessionID: session.id })
        const msgs = await Session.messages({ sessionID: fork.id })
        const forked = msgs.find((item) => item.info.role === "user")
        if (!forked || forked.info.role !== "user") throw new Error("expected forked user message")
        expect(forked.info.fast).toBe(true)

        await Session.remove(fork.id)
        await Session.remove(session.id)
      },
    })
  })

  test("forwards fast through command prompts", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.4",
          },
        },
        command: {
          fast_test: {
            template: "hello",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const original = SessionPrompt.prompt
        let seen: SessionPrompt.PromptInput | undefined
        ;(SessionPrompt as any).prompt = async (input: SessionPrompt.PromptInput) => {
          seen = input
          return {
            info: {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
            },
            parts: [],
          }
        }

        try {
          await SessionPrompt.command({
            sessionID: session.id,
            command: "fast_test",
            arguments: "",
            agent: "build",
            model: "opencode/kimi-k2.5-free",
            fast: true,
          })
        } finally {
          ;(SessionPrompt as any).prompt = original
        }

        expect(seen?.fast).toBe(true)
        await Session.remove(session.id)
      },
    })
  })

  test("uses subagent fast defaults for task sessions", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          general: {
            fast: true,
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const parent = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.openai, modelID: ModelID.make("gpt-5.4") },
          noReply: true,
          parts: [{ type: "text", text: "parent" }],
        })

        if (parent.info.role !== "user") throw new Error("expected user message")

        const assistant = await Session.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          parentID: parent.info.id,
          role: "assistant",
          mode: "build",
          agent: "build",
          cost: 0,
          path: {
            cwd: tmp.path,
            root: tmp.path,
          },
          time: {
            created: Date.now(),
          },
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: ModelID.make("gpt-5.4"),
          providerID: ProviderID.openai,
        })

        const original = SessionPrompt.prompt
        ;(SessionPrompt as any).prompt = (input: SessionPrompt.PromptInput) =>
          original({
            ...input,
            noReply: true,
          })

        try {
          const task = await TaskTool.init()
          const result = await task.execute(
            {
              description: "child task",
              prompt: "hello from child",
              subagent_type: "general",
            },
            {
              sessionID: session.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { bypassAgentCheck: true },
              messages: [],
              metadata() {},
              async ask() {},
            },
          )

          const msgs = await Session.messages({ sessionID: result.metadata.sessionId })
          const child = msgs.find((item) => item.info.role === "user")
          if (!child || child.info.role !== "user") throw new Error("expected child user message")
          expect(child.info.agent).toBe("general")
          expect(child.info.fast).toBe(true)
        } finally {
          ;(SessionPrompt as any).prompt = original
        }

        await Session.remove(session.id)
      },
    })
  })
})
