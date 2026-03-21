import { describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session listing", () => {
  test("should list all sessions when limit is not provided", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const roots = await Promise.all(Array.from({ length: 110 }, () => Session.create({})))
        await Promise.all(Array.from({ length: 90 }, () => Session.create({ parentID: roots[0].id })))

        const sessions = [...Session.list()]
        const rootCount = sessions.filter((s) => !s.parentID).length

        expect(sessions.length).toBe(200)
        expect(rootCount).toBe(110)

        await Promise.all(roots.map((session) => Session.remove(session.id)))
      },
    })
  })
})
