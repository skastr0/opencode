/**
 * Registry for tool metadata correlation between MCP execution and stream processing.
 *
 * Problem: When Claude SDK executes MCP tools, the tool_use_id is not passed to the handler.
 * This means ctx.metadata() calls fail and rich metadata (like sessionId) is lost.
 *
 * Solution: Store metadata during MCP execution keyed by (toolName, input).
 * Later, when translate-stream processes tool_use_summary, retrieve and merge the metadata.
 */

import { Log } from "../../util/log"

const log = Log.create({ service: "tool-metadata-registry" })

type StoredMetadata = {
  title?: string
  metadata: Record<string, unknown>
}

type PendingEntry = {
  data: StoredMetadata
  created: number
}

const pending = new Map<string, PendingEntry[]>()
const TTL = 60_000 // 1 minute

function key(tool: string, input: unknown): string {
  const json = typeof input === "string" ? input : JSON.stringify(input)
  return `${tool}::${json}`
}

function prune(entries: PendingEntry[]): PendingEntry[] {
  const now = Date.now()
  return entries.filter((e) => now - e.created < TTL)
}

/**
 * Store tool metadata for later retrieval.
 * Uses a queue to handle multiple calls to same tool with same input.
 */
export function store(tool: string, input: unknown, data: StoredMetadata) {
  const k = key(tool, input)
  log.info("store", { tool, key: k, metaKeys: Object.keys(data.metadata ?? {}) })
  const existing = pending.get(k) ?? []
  const pruned = prune(existing)
  pruned.push({ data, created: Date.now() })
  pending.set(k, pruned)
}

/**
 * Retrieve and consume stored metadata.
 * Returns the oldest matching entry (FIFO order).
 */
export function retrieve(tool: string, input: unknown): StoredMetadata | undefined {
  const k = key(tool, input)
  const entries = pending.get(k)
  log.info("retrieve", { tool, key: k, found: !!entries, pendingKeys: Array.from(pending.keys()) })
  if (!entries || entries.length === 0) return undefined

  const pruned = prune(entries)
  if (pruned.length === 0) {
    pending.delete(k)
    return undefined
  }

  const first = pruned.shift()
  if (pruned.length === 0) {
    pending.delete(k)
  } else {
    pending.set(k, pruned)
  }

  return first?.data
}

/**
 * Clear all pending entries (for testing).
 */
export function clear() {
  pending.clear()
}
