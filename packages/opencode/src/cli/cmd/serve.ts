import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Workspace } from "../../control-plane/workspace"
import { Project } from "../../project/project"
import { Installation } from "../../installation"
import { Instance } from "../../project/instance"

function waitForShutdownSignal() {
  return new Promise<void>((resolve) => {
    const done = () => {
      process.off("SIGINT", done)
      process.off("SIGTERM", done)
      resolve()
    }
    process.on("SIGINT", done)
    process.on("SIGTERM", done)
  })
}

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    let workspaceSync: Array<ReturnType<typeof Workspace.startSyncing>> = []
    // Only available in development right now
    if (Installation.isLocal()) {
      workspaceSync = Project.list().map((project) => Workspace.startSyncing(project))
    }

    try {
      await waitForShutdownSignal()
    } finally {
      await Promise.all(workspaceSync.map((item) => item.stop()))
      await Instance.disposeAll()
      await server.stop(true)
    }
  },
})
