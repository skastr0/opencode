import { Storage } from "../../storage/storage"
import { Log } from "../../util/log"

interface SDKSession {
  sdkSessionId: string
  createdAt: number
  lastUsedAt: number
  modelId: string
}

const log = Log.create({ service: "claude-sdk-session-store" })

function storageKey(openCodeSessionId: string): string[] {
  return ["sdk-session", openCodeSessionId]
}

export class ClaudeAgentSDKSessionStore {
  // In-memory cache to avoid disk reads on every call
  private cache = new Map<string, SDKSession>()

  async get(openCodeSessionId: string, modelId: string): Promise<string | undefined> {
    // Check cache first
    const cached = this.cache.get(openCodeSessionId)
    if (cached) {
      if (cached.modelId !== modelId) {
        await this.delete(openCodeSessionId)
        return undefined
      }
      return cached.sdkSessionId
    }

    // Try to load from storage
    const stored = await Storage.read<SDKSession>(storageKey(openCodeSessionId)).catch(() => undefined)
    if (!stored) return undefined

    // Validate model matches
    if (stored.modelId !== modelId) {
      log.info("model mismatch, deleting stored SDK session", {
        openCodeSessionId,
        storedModel: stored.modelId,
        requestedModel: modelId,
      })
      await this.delete(openCodeSessionId)
      return undefined
    }

    // Populate cache
    this.cache.set(openCodeSessionId, stored)
    log.info("restored SDK session from storage", {
      openCodeSessionId,
      sdkSessionId: stored.sdkSessionId,
      modelId: stored.modelId,
    })
    return stored.sdkSessionId
  }

  async set(openCodeSessionId: string, sdkSessionId: string, modelId: string): Promise<void> {
    const session: SDKSession = {
      sdkSessionId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      modelId,
    }
    this.cache.set(openCodeSessionId, session)
    await Storage.write(storageKey(openCodeSessionId), session)
    log.info("persisted SDK session", {
      openCodeSessionId,
      sdkSessionId,
      modelId,
    })
  }

  async touch(openCodeSessionId: string): Promise<void> {
    const cached = this.cache.get(openCodeSessionId)
    if (cached) {
      cached.lastUsedAt = Date.now()
      await Storage.write(storageKey(openCodeSessionId), cached).catch(() => {})
    }
  }

  async delete(openCodeSessionId: string): Promise<void> {
    this.cache.delete(openCodeSessionId)
    await Storage.remove(storageKey(openCodeSessionId)).catch(() => {})
    log.info("deleted SDK session", { openCodeSessionId })
  }
}
