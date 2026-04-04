#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import path from "path"

const install = path.join(process.env.HOME!, ".opencode", "bin")
const bin = path.join(install, "opencode")
const bak = path.join(install, "opencode.official.bak")

const MUTED = "\x1b[2m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const NC = "\x1b[0m"

function log(msg: string) {
  console.log(msg)
}

function info(msg: string) {
  log(`${MUTED}${msg}${NC}`)
}

function success(msg: string) {
  log(`${GREEN}${msg}${NC}`)
}

function warn(msg: string) {
  log(`${YELLOW}${msg}${NC}`)
}

function error(msg: string) {
  log(`${RED}${msg}${NC}`)
}

async function main() {
  log("")
  log(`${MUTED}====================================${NC}`)
  log(`  Uninstalling Local OpenCode Fork`)
  log(`${MUTED}====================================${NC}`)
  log("")

  if (!fs.existsSync(bin)) {
    warn("No opencode binary found at ~/.opencode/bin/opencode")
    warn("Nothing to uninstall.")
    process.exit(0)
  }

  const current = (await $`${bin} --version`.quiet().nothrow().text()).trim()
  info(`Current version: ${current}`)

  if (!current.startsWith("local-")) {
    warn("Current installation is not a local build.")
    warn(`Version: ${current}`)
    warn("Nothing to do.")
    process.exit(0)
  }

  if (!fs.existsSync(bak)) {
    warn("No official backup found at ~/.opencode/bin/opencode.official.bak")
    log("")
    info("Options:")
    info("  1. Remove local build:  rm ~/.opencode/bin/opencode")
    info("  2. Reinstall official:  curl -fsSL https://opencode.ai/install | bash")
    log("")
    process.exit(1)
  }

  info("Restoring official binary from backup...")
  await $`mv ${bak} ${bin}`
  await $`chmod 755 ${bin}`

  const restored = (await $`${bin} --version`.text()).trim()
  log("")
  success("Official binary restored!")
  log("")
  info(`Restored version: ${restored}`)
  info(`Binary location:  ${bin}`)
  log("")
}

main().catch((err) => {
  error(`Error: ${err.message}`)
  process.exit(1)
})
