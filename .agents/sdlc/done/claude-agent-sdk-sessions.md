# Claude Agent SDK Session Management and Caching

id: claude-agent-sdk-sessions

## Context

The Claude Agent SDK provides session-based conversation management with built-in caching. This work item ensures we properly leverage these features to avoid consumption bloat and maintain conversation continuity.

**Key SDK Caching Features:**
- Ephemeral prompt cache with 5-minute TTL (default) or 1-hour (optional)
- Session-based context management via `resume`
- Automatic thinking block caching
- Cache metrics: `cache_creation_input_tokens`, `cache_read_input_tokens`

Parent: claude-agent-sdk-provider

## Technical Design

### Session Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SESSION LIFECYCLE                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. FIRST MESSAGE                                                           │
│     ┌─────────────┐         ┌─────────────┐         ┌─────────────┐        │
│     │  OpenCode   │────────▶│  SDK query  │────────▶│   Claude    │        │
│     │  Session    │         │  (no resume)│         │             │        │
│     └─────────────┘         └─────────────┘         └─────────────┘        │
│           │                       │                       │                 │
│           │                       │◀──────────────────────┘                 │
│           │                       │  system.init { session_id: "abc123" }   │
│           │                       │                                         │
│           │◀──────────────────────┘                                         │
│           │  Store: opencode_session_id → sdk_session_id                    │
│           ▼                                                                 │
│     ┌─────────────┐                                                         │
│     │  Session    │  { "sess_xyz": "abc123" }                              │
│     │  Store      │                                                         │
│     └─────────────┘                                                         │
│                                                                             │
│  2. SUBSEQUENT MESSAGES (within 5min cache window)                          │
│     ┌─────────────┐         ┌─────────────┐         ┌─────────────┐        │
│     │  OpenCode   │────────▶│  SDK query  │────────▶│   Claude    │        │
│     │  Session    │         │  resume:    │         │   (cached)  │        │
│     │             │         │  "abc123"   │         │             │        │
│     └─────────────┘         └─────────────┘         └─────────────┘        │
│           │                       │                       │                 │
│           │                       │  Usage: cache_read_input_tokens: 5000  │
│           │                       │  (context loaded from cache!)           │
│           │◀──────────────────────┘                                         │
│                                                                             │
│  3. CACHE EXPIRED (after 5min idle)                                         │
│     ┌─────────────┐         ┌─────────────┐         ┌─────────────┐        │
│     │  OpenCode   │────────▶│  SDK query  │────────▶│   Claude    │        │
│     │  Session    │         │  resume:    │         │  (rebuild)  │        │
│     │             │         │  "abc123"   │         │             │        │
│     └─────────────┘         └─────────────┘         └─────────────┘        │
│           │                       │                       │                 │
│           │                       │  Usage: cache_creation_input_tokens: 5000│
│           │                       │  (context rebuilt, new cache created)   │
│           │◀──────────────────────┘                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Session Store Implementation

```typescript
// packages/opencode/src/provider/sdk/claude-agent-sdk/session-store.ts

import { Storage } from '@/storage'

interface SDKSession {
  sdkSessionId: string
  createdAt: number
  lastUsedAt: number
  modelId: string
}

export class ClaudeAgentSDKSessionStore {
  private static CACHE_TTL = 5 * 60 * 1000  // 5 minutes (SDK default)
  
  // Map OpenCode session ID → SDK session ID
  private sessions = new Map<string, SDKSession>()
  
  /**
   * Get SDK session ID for an OpenCode session
   * Returns undefined if no session or session expired
   */
  get(openCodeSessionId: string, modelId: string): string | undefined {
    const session = this.sessions.get(openCodeSessionId)
    
    if (!session) return undefined
    
    // Check if model matches (can't resume with different model)
    if (session.modelId !== modelId) {
      this.delete(openCodeSessionId)
      return undefined
    }
    
    // Session exists - SDK will handle cache expiry internally
    // We just need to track the mapping
    return session.sdkSessionId
  }
  
  /**
   * Store SDK session ID for an OpenCode session
   */
  set(openCodeSessionId: string, sdkSessionId: string, modelId: string): void {
    this.sessions.set(openCodeSessionId, {
      sdkSessionId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      modelId
    })
  }
  
  /**
   * Update last used time (for cache tracking)
   */
  touch(openCodeSessionId: string): void {
    const session = this.sessions.get(openCodeSessionId)
    if (session) {
      session.lastUsedAt = Date.now()
    }
  }
  
  /**
   * Delete session mapping
   */
  delete(openCodeSessionId: string): void {
    this.sessions.delete(openCodeSessionId)
  }
  
  /**
   * Fork session (for branching conversations)
   */
  fork(sourceSessionId: string, newSessionId: string): void {
    const source = this.sessions.get(sourceSessionId)
    if (source) {
      // Note: SDK forkSession creates new session_id automatically
      // We'll update this when we get the new ID from SDK
      this.sessions.set(newSessionId, { ...source, createdAt: Date.now() })
    }
  }
  
  /**
   * Get cache stats for debugging/monitoring
   */
  getStats(): { total: number, active: number } {
    const now = Date.now()
    let active = 0
    
    for (const session of this.sessions.values()) {
      if (now - session.lastUsedAt < ClaudeAgentSDKSessionStore.CACHE_TTL) {
        active++
      }
    }
    
    return {
      total: this.sessions.size,
      active
    }
  }
}
```

### Integration with OpenCode Sessions

```typescript
// In OpenCode's session management

import { ClaudeAgentSDKSessionStore } from './provider/sdk/claude-agent-sdk/session-store'

// Singleton store - shared across all SDK provider instances
const sdkSessionStore = new ClaudeAgentSDKSessionStore()

// When creating SDK provider
const provider = createClaudeAgentSDK({
  sessionStore: sdkSessionStore
})

// In LanguageModelV2 wrapper
async doStream(options: LanguageModelV2CallOptions) {
  const openCodeSessionId = options.providerOptions?.sessionId
  
  // Get existing SDK session if available
  const sdkSessionId = this.sessionStore.get(openCodeSessionId, this.modelId)
  
  const response = query({
    prompt: translatedPrompt,
    options: {
      model: this.modelId,
      allowedTools: [],
      // Resume existing session for caching benefit
      ...(sdkSessionId && { resume: sdkSessionId })
    }
  })
  
  // Capture new session ID from response
  for await (const msg of response) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.sessionStore.set(openCodeSessionId, msg.session_id, this.modelId)
    }
    // ... handle other message types
  }
}
```

### Handling Tool Results in Sessions

When OpenCode executes a tool and sends the result back, we need to maintain session continuity:

```typescript
async function* sendToolResultAndContinue(
  toolResults: ToolResult[],
  sessionId: string
): AsyncIterable<SDKUserMessage> {
  // Send tool results as part of the resumed session
  for (const result of toolResults) {
    yield {
      type: 'tool_result',
      tool_use_id: result.toolCallId,
      content: typeof result.result === 'string' 
        ? result.result 
        : JSON.stringify(result.result)
    }
  }
}

// Usage in doStream
if (hasToolResults(prompt)) {
  const toolResults = extractToolResults(prompt)
  const promptGenerator = sendToolResultAndContinue(toolResults, sdkSessionId)
  
  const response = query({
    prompt: promptGenerator,  // Async generator with tool results
    options: {
      resume: sdkSessionId,  // Continue same session
      model: this.modelId,
      allowedTools: []
    }
  })
}
```

### Cache Efficiency Monitoring

```typescript
// Track cache efficiency in usage stats
interface CacheStats {
  cacheHits: number       // cache_read_input_tokens > 0
  cacheMisses: number     // cache_creation_input_tokens > 0
  totalCacheReads: number
  totalCacheWrites: number
}

function trackCacheUsage(usage: SDKUsage, stats: CacheStats): void {
  if (usage.cache_read_input_tokens > 0) {
    stats.cacheHits++
    stats.totalCacheReads += usage.cache_read_input_tokens
  }
  if (usage.cache_creation_input_tokens > 0) {
    stats.cacheMisses++
    stats.totalCacheWrites += usage.cache_creation_input_tokens
  }
}

// Log cache efficiency periodically
function logCacheEfficiency(stats: CacheStats): void {
  const hitRate = stats.cacheHits / (stats.cacheHits + stats.cacheMisses) * 100
  console.log(`SDK Cache: ${hitRate.toFixed(1)}% hit rate, ${stats.totalCacheReads} tokens read from cache`)
}
```

## Acceptance Criteria

- [ ] AC-1: SDK session IDs are captured from `system.init` messages
- [ ] AC-2: Sessions are stored mapping OpenCode session ID → SDK session ID
- [ ] AC-3: Subsequent messages use `resume` with stored session ID
- [ ] AC-4: Cache metrics are tracked and exposed in usage stats
- [ ] AC-5: Tool results are sent within the same session context
- [ ] AC-6: Model changes invalidate session (can't resume with different model)
- [ ] AC-7: Session forking is supported for conversation branching
- [ ] AC-8: Cache hit rate is measurable for monitoring

## Cache Optimization Guidelines

1. **Keep sessions alive** - Use the same OpenCode session for related conversations
2. **Batch tool results** - Send all tool results in one prompt generator
3. **Monitor cache stats** - Watch for unexpected cache misses
4. **Model consistency** - Don't switch models mid-conversation

## Time Estimate

predicted_hours: 4-5
actual_hours: TBD

## Notes

2026-01-25: SDK's caching is automatic when using `resume`. Key is to:
1. Always capture session_id from init message
2. Always use `resume` for subsequent messages
3. Send tool results within session context (not as new sessions)

Cache invalidation happens when:
- 5 minutes idle (default TTL)
- Non-tool-result user content added (strips thinking blocks)
- Model changed
