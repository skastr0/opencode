#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const file = fileURLToPath(import.meta.url)
const dir = path.resolve(path.dirname(file), "..")
const root = path.resolve(dir, "../..")

const install = path.join(process.env.HOME!, ".opencode", "bin")
const bin = path.join(install, "opencode")
const bak = path.join(install, "opencode.official.bak")

const MUTED = "\x1b[2m"
const GREEN = "\x1b[32m"
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

function error(msg: string) {
  log(`${RED}${msg}${NC}`)
}

async function git() {
  const hash = (await $`git rev-parse --short HEAD`.text()).trim()
  const branch = (await $`git branch --show-current`.text()).trim()
  const status = (await $`git status --porcelain`.text()).trim()
  return { hash, branch, dirty: status.length > 0 }
}

function target() {
  const os = process.platform === "win32" ? "windows" : process.platform
  return `opencode-${os}-${process.arch}`
}

async function main() {
  log("")
  log(`${MUTED}====================================${NC}`)
  log(`  Installing Local OpenCode Fork`)
  log(`${MUTED}====================================${NC}`)
  log("")

  const meta = await git()
  const version = `local-${meta.hash}${meta.dirty ? "-dirty" : ""}`
  info(`Git branch: ${meta.branch}`)
  info(`Git commit: ${meta.hash}${meta.dirty ? " (dirty)" : ""}`)
  info(`Version:    ${version}`)
  log("")

  await $`mkdir -p ${install}`

  if (fs.existsSync(bin)) {
    const current = (await $`${bin} --version`.quiet().nothrow().text()).trim()

    if (current.startsWith("local-")) {
      info(`Current installation is already local: ${current}`)
      info("Replacing with new local build...")
    } else if (!fs.existsSync(bak)) {
      info(`Backing up official binary (v${current}) to opencode.official.bak`)
      await $`cp ${bin} ${bak}`
      success("Backup created successfully")
    } else {
      info("Official backup already exists, skipping backup")
    }
  }
  log("")

  info("Running bun install from monorepo root...")
  await $`bun install`.cwd(root)

  const local = path.join(dir, "node_modules")
  const modules = path.join(root, "node_modules")
  await $`mkdir -p ${local}/@opentui`

  for (const mod of ["solid", "core"]) {
    const src = path.join(modules, "@opentui", mod)
    const dst = path.join(local, "@opentui", mod)
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue
    info(`Symlinking @opentui/${mod}...`)
    await $`ln -sf ${src} ${dst}`
  }
  log("")

  info("Building local binary...")
  const env = {
    ...process.env,
    OPENCODE_VERSION: version,
    OPENCODE_CHANNEL: "local",
  }

  const result = await $`bun run ./script/build.ts --single --skip-install`.cwd(dir).env(env).nothrow()
  const built = path.join(dir, "dist", target(), "bin", "opencode")

  if (!fs.existsSync(built)) {
    if (result.exitCode !== 0) error(`Build failed with exit code ${result.exitCode}`)
    error(`Built binary not found at: ${built}`)
    error("Available targets:")
    const dist = path.join(dir, "dist")
    if (fs.existsSync(dist)) {
      for (const entry of fs.readdirSync(dist)) error(`  - ${entry}`)
    }
    process.exit(1)
  }
  log("")

  info(`Installing to ${bin}`)
  await $`cp ${built} ${bin}`.nothrow()
  await $`chmod 755 ${bin}`.nothrow()

  if (process.platform === "darwin") {
    info("Re-signing binary for macOS...")
    await $`codesign --sign - --force ${bin}`.nothrow()
  }

  const resultVersion = await $`${bin} --version`.nothrow()
  const installed = resultVersion.stdout.toString().trim() || "unknown"
  log("")
  success("Installation complete!")
  log("")
  info(`Installed version: ${installed}`)
  info(`Binary location:   ${bin}`)
  if (fs.existsSync(bak)) info(`Official backup:   ${bak}`)
  log("")
  info("To restore the official version, run:")
  log("  bun run uninstall-local")
  log("")
}

main().catch((err) => {
  error(`Error: ${err.message}`)
  process.exit(1)
})
