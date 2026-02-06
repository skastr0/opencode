import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { formatPatch, parsePatch, structuredPatch } from "diff"
import path from "path"
import fs from "fs"
import ignore from "ignore"
import { Log } from "../util/log"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Ripgrep } from "./ripgrep"
import fuzzysort from "fuzzysort"
import { Global } from "../global"
import { git } from "@/util/git"
import { Protected } from "./protected"
import { InstanceContext } from "@/effect/instance-context"
import { Effect, Layer, ServiceMap } from "effect"
import { runPromiseInstance } from "@/effect/runtime"

const log = Log.create({ service: "file" })

const binaryExtensions = new Set([
  "exe",
  "dll",
  "pdb",
  "bin",
  "so",
  "dylib",
  "o",
  "a",
  "lib",
  "wav",
  "mp3",
  "ogg",
  "oga",
  "ogv",
  "ogx",
  "flac",
  "aac",
  "wma",
  "m4a",
  "weba",
  "mp4",
  "avi",
  "mov",
  "wmv",
  "flv",
  "webm",
  "mkv",
  "zip",
  "tar",
  "gz",
  "gzip",
  "bz",
  "bz2",
  "bzip",
  "bzip2",
  "7z",
  "rar",
  "xz",
  "lz",
  "z",
  "pdf",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "xls",
  "xlsx",
  "dmg",
  "iso",
  "img",
  "vmdk",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  "sqlite",
  "db",
  "mdb",
  "apk",
  "ipa",
  "aab",
  "xapk",
  "app",
  "pkg",
  "deb",
  "rpm",
  "snap",
  "flatpak",
  "appimage",
  "msi",
  "msp",
  "jar",
  "war",
  "ear",
  "class",
  "kotlin_module",
  "dex",
  "vdex",
  "odex",
  "oat",
  "art",
  "wasm",
  "wat",
  "bc",
  "ll",
  "s",
  "ko",
  "sys",
  "drv",
  "efi",
  "rom",
  "com",
  "cmd",
  "ps1",
  "sh",
  "bash",
  "zsh",
  "fish",
])

const imageExtensions = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "webp",
  "ico",
  "tif",
  "tiff",
  "svg",
  "svgz",
  "avif",
  "apng",
  "jxl",
  "heic",
  "heif",
  "raw",
  "cr2",
  "nef",
  "arw",
  "dng",
  "orf",
  "raf",
  "pef",
  "x3f",
])

const textExtensions = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "mtsx",
  "ctsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "psm1",
  "cmd",
  "bat",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "md",
  "mdx",
  "txt",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "graphql",
  "gql",
  "sql",
  "ini",
  "cfg",
  "conf",
  "env",
])

const textNames = new Set([
  "dockerfile",
  "makefile",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".npmrc",
  ".nvmrc",
  ".prettierrc",
  ".eslintrc",
])

function isImageByExtension(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase().slice(1)
  return imageExtensions.has(ext)
}

function isTextByExtension(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase().slice(1)
  return textExtensions.has(ext)
}

function isTextByName(filepath: string): boolean {
  const name = path.basename(filepath).toLowerCase()
  return textNames.has(name)
}

function getImageMimeType(filepath: string): string {
  const ext = path.extname(filepath).toLowerCase().slice(1)
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    webp: "image/webp",
    ico: "image/x-icon",
    tif: "image/tiff",
    tiff: "image/tiff",
    svg: "image/svg+xml",
    svgz: "image/svg+xml",
    avif: "image/avif",
    apng: "image/apng",
    jxl: "image/jxl",
    heic: "image/heic",
    heif: "image/heif",
  }
  return mimeTypes[ext] || "image/" + ext
}

function isBinaryByExtension(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase().slice(1)
  return binaryExtensions.has(ext)
}

function isImage(mimeType: string): boolean {
  return mimeType.startsWith("image/")
}

function shouldEncode(mimeType: string): boolean {
  const type = mimeType.toLowerCase()
  log.info("shouldEncode", { type })
  if (!type) return false

  if (type.startsWith("text/")) return false
  if (type.includes("charset=")) return false

  const parts = type.split("/", 2)
  const top = parts[0]

  const tops = ["image", "audio", "video", "font", "model", "multipart"]
  if (tops.includes(top)) return true

  return false
}

export namespace File {
  export const Info = z
    .object({
      path: z.string(),
      added: z.number().int(),
      removed: z.number().int(),
      status: z.enum(["added", "deleted", "modified"]),
      stage: z.enum(["staged", "unstaged", "untracked"]).optional(),
    })
    .meta({
      ref: "File",
    })

  export type Info = z.infer<typeof Info>

  export const Node = z
    .object({
      name: z.string(),
      path: z.string(),
      absolute: z.string(),
      type: z.enum(["file", "directory"]),
      ignored: z.boolean(),
    })
    .meta({
      ref: "FileNode",
    })
  export type Node = z.infer<typeof Node>

  export const Content = z
    .object({
      type: z.enum(["text", "binary"]),
      content: z.string(),
      diff: z.string().optional(),
      patch: z
        .object({
          oldFileName: z.string(),
          newFileName: z.string(),
          oldHeader: z.string().optional(),
          newHeader: z.string().optional(),
          hunks: z.array(
            z.object({
              oldStart: z.number(),
              oldLines: z.number(),
              newStart: z.number(),
              newLines: z.number(),
              lines: z.array(z.string()),
            }),
          ),
          index: z.string().optional(),
        })
        .optional(),
      encoding: z.literal("base64").optional(),
      mimeType: z.string().optional(),
    })
    .meta({
      ref: "FileContent",
    })
  export type Content = z.infer<typeof Content>

  export const Event = {
    Edited: BusEvent.define(
      "file.edited",
      z.object({
        file: z.string(),
      }),
    ),
  }

  export function init() {
    return runPromiseInstance(FileService.use((s) => s.init()))
  }

  export async function status() {
    return runPromiseInstance(FileService.use((s) => s.status()))
  }

  export async function read(file: string, stage?: "staged" | "unstaged"): Promise<Content> {
    return runPromiseInstance(FileService.use((s) => s.read(file, stage)))
  }

  export async function list(dir?: string) {
    return runPromiseInstance(FileService.use((s) => s.list(dir)))
  }

  export async function search(input: { query: string; limit?: number; dirs?: boolean; type?: "file" | "directory" }) {
    return runPromiseInstance(FileService.use((s) => s.search(input)))
  }
}

export namespace FileService {
  export interface Service {
    readonly init: () => Effect.Effect<void>
    readonly status: () => Effect.Effect<File.Info[]>
    readonly read: (file: string, stage?: "staged" | "unstaged") => Effect.Effect<File.Content>
    readonly list: (dir?: string) => Effect.Effect<File.Node[]>
    readonly search: (input: {
      query: string
      limit?: number
      dirs?: boolean
      type?: "file" | "directory"
    }) => Effect.Effect<string[]>
  }
}

export class FileService extends ServiceMap.Service<FileService, FileService.Service>()("@opencode/File") {
  static readonly layer = Layer.effect(
    FileService,
    Effect.gen(function* () {
      const instance = yield* InstanceContext

      // File cache state
      type Entry = { files: string[]; dirs: string[] }
      let cache: Entry = { files: [], dirs: [] }
      let task: Promise<void> | undefined

      const isGlobalHome = instance.directory === Global.Path.home && instance.project.id === "global"

      function kick() {
        if (task) return task
        task = (async () => {
          // Disable scanning if in root of file system
          if (instance.directory === path.parse(instance.directory).root) return
          const next: Entry = { files: [], dirs: [] }
          try {
            if (isGlobalHome) {
              const dirs = new Set<string>()
              const protectedNames = Protected.names()

              const ignoreNested = new Set(["node_modules", "dist", "build", "target", "vendor"])
              const shouldIgnoreName = (name: string) => name.startsWith(".") || protectedNames.has(name)
              const shouldIgnoreNested = (name: string) => name.startsWith(".") || ignoreNested.has(name)

              const top = await fs.promises
                .readdir(instance.directory, { withFileTypes: true })
                .catch(() => [] as fs.Dirent[])

              for (const entry of top) {
                if (!entry.isDirectory()) continue
                if (shouldIgnoreName(entry.name)) continue
                dirs.add(entry.name + "/")

                const base = path.join(instance.directory, entry.name)
                const children = await fs.promises.readdir(base, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
                for (const child of children) {
                  if (!child.isDirectory()) continue
                  if (shouldIgnoreNested(child.name)) continue
                  dirs.add(entry.name + "/" + child.name + "/")
                }
              }

              next.dirs = Array.from(dirs).toSorted()
            } else {
              const set = new Set<string>()
              for await (const file of Ripgrep.files({ cwd: instance.directory })) {
                next.files.push(file)
                let current = file
                while (true) {
                  const dir = path.dirname(current)
                  if (dir === ".") break
                  if (dir === current) break
                  current = dir
                  if (set.has(dir)) continue
                  set.add(dir)
                  next.dirs.push(dir + "/")
                }
              }
            }
            cache = next
          } finally {
            task = undefined
          }
        })()
        return task
      }

      const getFiles = async () => {
        void kick()
        return cache
      }

      const init = Effect.fn("FileService.init")(function* () {
        yield* Effect.promise(() => kick())
      })

      const status = Effect.fn("FileService.status")(function* () {
        if (instance.project.vcs !== "git") return []

        return yield* Effect.promise(async () => {
          const staged = (
            await git(
              [
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.quotepath=false",
                "diff",
                "--cached",
                "--numstat",
                "--relative",
              ],
              { cwd: instance.directory },
            )
          ).text()

          const unstaged = (
            await git(["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "diff", "--numstat", "--relative"], {
              cwd: instance.directory,
            })
          ).text()

          const stagedDeleted = new Set(
            (
              await git(
                [
                  "-c",
                  "core.fsmonitor=false",
                  "-c",
                  "core.quotepath=false",
                  "diff",
                  "--name-only",
                  "--diff-filter=D",
                  "--cached",
                  "--relative",
                ],
                { cwd: instance.directory },
              )
            )
              .text()
              .trim()
              .split("\n")
              .filter(Boolean),
          )

          const unstagedDeleted = new Set(
            (
              await git(
                [
                  "-c",
                  "core.fsmonitor=false",
                  "-c",
                  "core.quotepath=false",
                  "diff",
                  "--name-only",
                  "--diff-filter=D",
                  "--relative",
                ],
                { cwd: instance.directory },
              )
            )
              .text()
              .trim()
              .split("\n")
              .filter(Boolean),
          )

          const changed: File.Info[] = []

          const parse = (output: string, stage: "staged" | "unstaged", deleted: Set<string>) => {
            if (!output.trim()) return
            for (const line of output.trim().split("\n")) {
              const [added, removed, file] = line.split("\t")
              if (!file) continue
              const status = deleted.has(file) ? "deleted" : "modified"
              if (status === "deleted") deleted.delete(file)
              changed.push({
                path: file,
                added: added === "-" ? 0 : parseInt(added, 10),
                removed: removed === "-" ? 0 : parseInt(removed, 10),
                status,
                stage,
              })
            }
          }

          parse(staged, "staged", stagedDeleted)
          parse(unstaged, "unstaged", unstagedDeleted)

          for (const file of stagedDeleted) {
            changed.push({ path: file, added: 0, removed: 0, status: "deleted", stage: "staged" })
          }

          for (const file of unstagedDeleted) {
            changed.push({ path: file, added: 0, removed: 0, status: "deleted", stage: "unstaged" })
          }

          const untracked = (
            await git(
              [
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.quotepath=false",
                "ls-files",
                "--others",
                "--exclude-standard",
              ],
              { cwd: instance.directory },
            )
          ).text()

          if (untracked.trim()) {
            for (const file of untracked.trim().split("\n")) {
              try {
                const content = await Filesystem.readText(path.join(instance.directory, file))
                changed.push({
                  path: file,
                  added: content.split("\n").length,
                  removed: 0,
                  status: "added",
                  stage: "untracked",
                })
              } catch {
                continue
              }
            }
          }

          return changed
        })
      })

      const read = Effect.fn("FileService.read")(function* (file: string, stage?: "staged" | "unstaged") {
        return yield* Effect.promise(async (): Promise<File.Content> => {
          using _ = log.time("read", { file, stage })
          const full = path.join(instance.directory, file)

          if (!Instance.containsPath(full)) {
            throw new Error(`Access denied: path escapes project directory`)
          }

          // Fast path: check extension before any filesystem operations
          if (isImageByExtension(file)) {
            if (await Filesystem.exists(full)) {
              const buffer = await Filesystem.readBytes(full).catch(() => Buffer.from([]))
              const content = buffer.toString("base64")
              const mimeType = getImageMimeType(file)
              return { type: "text", content, mimeType, encoding: "base64" }
            }
            return { type: "text", content: "" }
          }

          const text = isTextByExtension(file) || isTextByName(file)

          if (isBinaryByExtension(file) && !text) {
            return { type: "binary", content: "" }
          }

          if (!(await Filesystem.exists(full))) {
            return { type: "text", content: "" }
          }

          const mimeType = Filesystem.mimeType(full)
          const encode = text ? false : shouldEncode(mimeType)

          if (encode && !isImage(mimeType)) {
            return { type: "binary", content: "", mimeType }
          }

          if (encode) {
            const buffer = await Filesystem.readBytes(full).catch(() => Buffer.from([]))
            const content = buffer.toString("base64")
            return { type: "text", content, mimeType, encoding: "base64" }
          }

          const content = (await Filesystem.readText(full).catch(() => "")).trim()

          if (instance.project.vcs === "git") {
            const staged = (
              await git(["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "diff", "--cached", "--", file], {
                cwd: instance.directory,
              })
            ).text()

            const unstaged = (
              await git(["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "diff", "--", file], {
                cwd: instance.directory,
              })
            ).text()

            const diff =
              stage === "staged" ? staged : stage === "unstaged" ? unstaged : unstaged.trim() ? unstaged : staged

            if (diff.trim()) {
              const patch = parsePatch(diff)[0]
              if (!patch) return { type: "text", content, diff }
              return { type: "text", content, diff, patch }
            }

            const untracked = (
              await git(
                ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "status", "--porcelain", "--", file],
                { cwd: instance.directory },
              )
            ).text()

            if ((stage === undefined || stage === "unstaged") && untracked.trim().startsWith("?? ")) {
              const patch = structuredPatch(file, file, "", content, "old", "new", {
                context: Infinity,
                ignoreWhitespace: true,
              })
              return { type: "text", content, patch, diff: formatPatch(patch) }
            }
          }
          return { type: "text", content }
        })
      })

      const list = Effect.fn("FileService.list")(function* (dir?: string) {
        return yield* Effect.promise(async () => {
          const exclude = [".git", ".DS_Store"]
          let ignored = (_: string) => false
          if (instance.project.vcs === "git") {
            const ig = ignore()
            const gitignorePath = path.join(instance.project.worktree, ".gitignore")
            if (await Filesystem.exists(gitignorePath)) {
              ig.add(await Filesystem.readText(gitignorePath))
            }
            const ignorePath = path.join(instance.project.worktree, ".ignore")
            if (await Filesystem.exists(ignorePath)) {
              ig.add(await Filesystem.readText(ignorePath))
            }
            ignored = ig.ignores.bind(ig)
          }
          const resolved = dir ? path.join(instance.directory, dir) : instance.directory

          if (!Instance.containsPath(resolved)) {
            throw new Error(`Access denied: path escapes project directory`)
          }

          const nodes: File.Node[] = []
          for (const entry of await fs.promises
            .readdir(resolved, {
              withFileTypes: true,
            })
            .catch(() => [])) {
            if (exclude.includes(entry.name)) continue
            const fullPath = path.join(resolved, entry.name)
            const relativePath = path.relative(instance.directory, fullPath)
            const type = entry.isDirectory() ? "directory" : "file"
            nodes.push({
              name: entry.name,
              path: relativePath,
              absolute: fullPath,
              type,
              ignored: ignored(type === "directory" ? relativePath + "/" : relativePath),
            })
          }
          return nodes.sort((a, b) => {
            if (a.type !== b.type) {
              return a.type === "directory" ? -1 : 1
            }
            return a.name.localeCompare(b.name)
          })
        })
      })

      const search = Effect.fn("FileService.search")(function* (input: {
        query: string
        limit?: number
        dirs?: boolean
        type?: "file" | "directory"
      }) {
        return yield* Effect.promise(async () => {
          const query = input.query.trim()
          const limit = input.limit ?? 100
          const kind = input.type ?? (input.dirs === false ? "file" : "all")
          log.info("search", { query, kind })

          const result = await getFiles()

          const hidden = (item: string) => {
            const normalized = item.replaceAll("\\", "/").replace(/\/+$/, "")
            return normalized.split("/").some((p) => p.startsWith(".") && p.length > 1)
          }
          const preferHidden = query.startsWith(".") || query.includes("/.")
          const sortHiddenLast = (items: string[]) => {
            if (preferHidden) return items
            const visible: string[] = []
            const hiddenItems: string[] = []
            for (const item of items) {
              const isHidden = hidden(item)
              if (isHidden) hiddenItems.push(item)
              if (!isHidden) visible.push(item)
            }
            return [...visible, ...hiddenItems]
          }
          if (!query) {
            if (kind === "file") return result.files.slice(0, limit)
            return sortHiddenLast(result.dirs.toSorted()).slice(0, limit)
          }

          const items =
            kind === "file" ? result.files : kind === "directory" ? result.dirs : [...result.files, ...result.dirs]

          const searchLimit = kind === "directory" && !preferHidden ? limit * 20 : limit
          const sorted = fuzzysort.go(query, items, { limit: searchLimit }).map((r) => r.target)
          const output = kind === "directory" ? sortHiddenLast(sorted).slice(0, limit) : sorted

          log.info("search", { query, kind, results: output.length })
          return output
        })
      })

      log.info("init")

      return FileService.of({ init, status, read, list, search })
    }),
  )
}
