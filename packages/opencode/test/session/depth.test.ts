import { describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session depth", () => {
  test("root session should have depth 0", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        expect(session.depth).toBe(0)

        await Session.remove(session.id)
      },
    })
  })

  test("child session should have depth = parent.depth + 1", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const parent = await Session.create({})
        expect(parent.depth).toBe(0)

        const child = await Session.create({ parentID: parent.id })
        expect(child.depth).toBe(1)

        const grandchild = await Session.create({ parentID: child.id })
        expect(grandchild.depth).toBe(2)

        await Session.remove(grandchild.id)
        await Session.remove(child.id)
        await Session.remove(parent.id)
      },
    })
  })

  test("depth should be persisted and retrieved correctly", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })

        // Retrieve session and verify depth is persisted
        const retrievedChild = await Session.get(child.id)
        expect(retrievedChild.depth).toBe(1)

        const retrievedParent = await Session.get(parent.id)
        expect(retrievedParent.depth).toBe(0)

        await Session.remove(child.id)
        await Session.remove(parent.id)
      },
    })
  })
})
