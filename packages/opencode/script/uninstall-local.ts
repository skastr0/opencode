#!/usr/bin/env bun
/**
 * Uninstall Local Fork Script
 *
 * Restores the official opencode binary from backup.
 *
 * Usage:
 *   bun run script/uninstall-local.ts
 *   bun run uninstall-local
 */

import { $ } from "bun"
import path from "path"
import fs from "fs"

const INSTALL_DIR = path.join(process.env.HOME!, ".opencode", "bin")
const BINARY_PATH = path.join(INSTALL_DIR, "opencode")
const BACKUP_PATH = path.join(INSTALL_DIR, "opencode.official.bak")

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

  // Check current installation
  if (!fs.existsSync(BINARY_PATH)) {
    warn("No opencode binary found at ~/.opencode/bin/opencode")
    warn("Nothing to uninstall.")
    process.exit(0)
  }

  const currentVersion = (await $`${BINARY_PATH} --version`.quiet().nothrow().text()).trim()
  info(`Current version: ${currentVersion}`)

  if (!currentVersion.startsWith("local-")) {
    warn("Current installation is not a local build.")
    warn(`Version: ${currentVersion}`)
    warn("Nothing to do.")
    process.exit(0)
  }

  // Check for backup
  if (!fs.existsSync(BACKUP_PATH)) {
    warn("No official backup found at ~/.opencode/bin/opencode.official.bak")
    log("")
    info("Options:")
    info("  1. Remove local build:  rm ~/.opencode/bin/opencode")
    info("  2. Reinstall official:  curl -fsSL https://opencode.ai/install | bash")
    log("")
    process.exit(1)
  }

  // Restore backup
  info("Restoring official binary from backup...")
  await $`mv ${BACKUP_PATH} ${BINARY_PATH}`
  await $`chmod 755 ${BINARY_PATH}`

  // Verify restoration
  const restoredVersion = (await $`${BINARY_PATH} --version`.text()).trim()
  log("")
  success("Official binary restored!")
  log("")
  info(`Restored version: ${restoredVersion}`)
  info(`Binary location:  ${BINARY_PATH}`)
  log("")
}

main().catch((err) => {
  error(`Error: ${err.message}`)
  process.exit(1)
})
