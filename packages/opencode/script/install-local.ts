#!/usr/bin/env bun
/**
 * Install Local Fork Script
 *
 * Builds the local opencode fork and installs it to ~/.opencode/bin/opencode
 * Backs up the official binary first (if it exists) to allow restoration later.
 *
 * Usage:
 *   bun run script/install-local.ts
 *   bun run install-local
 */

import { $ } from "bun"
import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")
const monorepoRoot = path.resolve(dir, "../..")

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

async function getGitInfo(): Promise<{ hash: string; branch: string; dirty: boolean }> {
  const hash = (await $`git rev-parse --short HEAD`.text()).trim()
  const branch = (await $`git branch --show-current`.text()).trim()
  const status = (await $`git status --porcelain`.text()).trim()
  return { hash, branch, dirty: status.length > 0 }
}

function getPlatformTarget(): string {
  const os = process.platform === "win32" ? "windows" : process.platform
  const arch = process.arch
  return `opencode-${os}-${arch}`
}

async function main() {
  log("")
  log(`${MUTED}====================================${NC}`)
  log(`  Installing Local OpenCode Fork`)
  log(`${MUTED}====================================${NC}`)
  log("")

  // Get git info for version string
  const git = await getGitInfo()
  const version = `local-${git.hash}${git.dirty ? "-dirty" : ""}`
  info(`Git branch: ${git.branch}`)
  info(`Git commit: ${git.hash}${git.dirty ? " (dirty)" : ""}`)
  info(`Version:    ${version}`)
  log("")

  // Ensure install directory exists
  await $`mkdir -p ${INSTALL_DIR}`

  // Check for existing binary and backup if needed
  if (fs.existsSync(BINARY_PATH)) {
    // Check if it's already a local build
    const currentVersion = (await $`${BINARY_PATH} --version`.quiet().nothrow().text()).trim()

    if (currentVersion.startsWith("local-")) {
      info(`Current installation is already local: ${currentVersion}`)
      info("Replacing with new local build...")
    } else if (!fs.existsSync(BACKUP_PATH)) {
      // It's an official build and we don't have a backup yet
      info(`Backing up official binary (v${currentVersion}) to opencode.official.bak`)
      await $`cp ${BINARY_PATH} ${BACKUP_PATH}`
      success("Backup created successfully")
    } else {
      info("Official backup already exists, skipping backup")
    }
  }
  log("")

  // Run bun install from monorepo root to ensure dependencies are up to date
  info("Running bun install from monorepo root...")
  await $`bun install`.cwd(monorepoRoot)

  // Ensure local node_modules has required symlinks for build.ts imports
  // The build script uses relative imports from ../node_modules/
  const localNodeModules = path.join(dir, "node_modules")
  const rootNodeModules = path.join(monorepoRoot, "node_modules")
  await $`mkdir -p ${localNodeModules}/@opentui`
  const opentuiModules = ["solid", "core"]
  for (const mod of opentuiModules) {
    const src = path.join(rootNodeModules, "@opentui", mod)
    const dst = path.join(localNodeModules, "@opentui", mod)
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      info(`Symlinking @opentui/${mod}...`)
      await $`ln -sf ${src} ${dst}`
    }
  }
  log("")

  // Build with local channel (run from packages/opencode)
  info("Building local binary...")
  const target = getPlatformTarget()
  const buildEnv = {
    ...process.env,
    OPENCODE_VERSION: version,
    OPENCODE_CHANNEL: "local",
  }

  const result = await $`bun run ./script/build.ts --single --skip-install`.cwd(dir).env(buildEnv).nothrow()

  // Copy binary to install location
  const builtBinary = path.join(dir, "dist", target, "bin", "opencode")
  if (!fs.existsSync(builtBinary)) {
    if (result.exitCode !== 0) {
      error(`Build failed with exit code ${result.exitCode}`)
    }
    error(`Built binary not found at: ${builtBinary}`)
    error("Available targets:")
    const distDir = path.join(dir, "dist")
    if (fs.existsSync(distDir)) {
      for (const entry of fs.readdirSync(distDir)) {
        error(`  - ${entry}`)
      }
    }
    process.exit(1)
  }
  log("")

  info(`Installing to ${BINARY_PATH}`)
  await $`cp ${builtBinary} ${BINARY_PATH}`.nothrow()
  await $`chmod 755 ${BINARY_PATH}`.nothrow()

  // Re-sign binary on macOS (Bun compile can invalidate signatures)
  if (process.platform === "darwin") {
    info("Re-signing binary for macOS...")
    await $`codesign --sign - --force ${BINARY_PATH}`.nothrow()
  }

  // Verify installation
  const versionResult = await $`${BINARY_PATH} --version`.nothrow()
  const installedVersion = versionResult.stdout.toString().trim() || "unknown"
  log("")
  success("Installation complete!")
  log("")
  info(`Installed version: ${installedVersion}`)
  info(`Binary location:   ${BINARY_PATH}`)
  if (fs.existsSync(BACKUP_PATH)) {
    info(`Official backup:   ${BACKUP_PATH}`)
  }
  log("")
  info("To restore the official version, run:")
  log("  bun run uninstall-local")
  log("")
}

main().catch((err) => {
  error(`Error: ${err.message}`)
  process.exit(1)
})
