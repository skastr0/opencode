# Implement LanguageModelV2 Wrapper for Claude Agent SDK

id: claude-agent-sdk-language-model

## Context

OpenCode uses Vercel AI SDK's `LanguageModelV2` interface for all LLM providers. This work item implements a provider that wraps the Claude Agent SDK's `query()` function and exposes it as a standard AI SDK provider.

**Critical**: This wrapper must ensure that:
1. Tools are NOT executed by the SDK (OpenCode handles them)
2. Sessions are properly managed for caching
3. Message translation is bidirectional and complete

Parent: claude-agent-sdk-provider

## Technical Design

### Provider Structure

```typescript
// packages/opencode/src/provider/sdk/claude-agent-sdk/index.ts

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { LanguageModelV2 } from '@ai-sdk/provider'

interface ClaudeAgentSDKProviderOptions {
  // Session management
  sessionStore?: SessionStore  // For resume functionality
}

export function createClaudeAgentSDK(options: ClaudeAgentSDKProviderOptions = {}) {
  const sessionStore = options.sessionStore ?? new InMemorySessionStore()
  
  return {
    languageModel(modelId: string): LanguageModelV2 {
      return new ClaudeAgentSDKLanguageModel(modelId, sessionStore)
    }
  }
}
```

### LanguageModelV2 Implementation

```typescript
class ClaudeAgentSDKLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2'
  readonly modelId: string
  private sessionStore: SessionStore
  
  constructor(modelId: string, sessionStore: SessionStore) {
    this.modelId = modelId
    this.sessionStore = sessionStore
  }
  
  get provider(): string {
    return 'claude-agent-sdk'
  }
  
  // Non-streaming generation
  async doGenerate(options: LanguageModelV2CallOptions): Promise<LanguageModelV2GenerateResult> {
    const result = await this.doStream(options)
    // Collect stream into single result
    return collectStreamResult(result.stream)
  }
  
  // Streaming generation - the main implementation
  async doStream(options: LanguageModelV2CallOptions): Promise<LanguageModelV2StreamResult> {
    const {
      prompt,
      providerOptions,
      abortSignal
    } = options
    
    // Get or create session for this conversation
    const sessionKey = providerOptions?.sessionId ?? 'default'
    const existingSessionId = this.sessionStore.get(sessionKey)
    
    // Translate AI SDK messages to SDK prompt format
    const sdkPrompt = translateToSDKPrompt(prompt)
    
    // Configure SDK options - CRITICAL: no tools allowed
    const sdkOptions = {
      model: this.mapModelId(this.modelId),
      allowedTools: [],  // OpenCode executes tools, not SDK
      
      // Session management for caching
      ...(existingSessionId && { resume: existingSessionId }),
      
      // Extended thinking support
      ...(providerOptions?.thinking && {
        maxThinkingTokens: providerOptions.thinking.budgetTokens
      })
    }
    
    // Call the SDK
    const response = query({
      prompt: sdkPrompt,
      options: sdkOptions
    })
    
    // Create transform stream for SDK -> AI SDK translation
    const stream = createSDKToAISDKStream(response, {
      onSessionId: (id) => this.sessionStore.set(sessionKey, id),
      abortSignal
    })
    
    return {
      stream,
      rawCall: { rawPrompt: sdkPrompt, rawSettings: sdkOptions }
    }
  }
  
  private mapModelId(modelId: string): string {
    // Map OpenCode model IDs to SDK model names
    const mapping: Record<string, string> = {
      'claude-opus-4': 'claude-opus-4-20250514',
      'claude-sonnet-4': 'claude-sonnet-4-20250514',
      'claude-haiku-4': 'claude-haiku-4-20250514',
      // Add variants as needed
    }
    return mapping[modelId] ?? modelId
  }
}
```

### Message Translation: AI SDK → SDK Prompt

```typescript
function translateToSDKPrompt(
  prompt: LanguageModelV2Prompt
): string | AsyncIterable<SDKUserMessage> {
  // For simple prompts, extract the user message
  const lastUserMessage = prompt.filter(m => m.role === 'user').pop()
  
  if (!lastUserMessage) {
    throw new Error('No user message in prompt')
  }
  
  // If we have tool results to send, use async generator
  const toolResults = extractToolResults(prompt)
  if (toolResults.length > 0) {
    return createPromptGenerator(lastUserMessage, toolResults)
  }
  
  // Simple case: just the user message text
  return extractTextContent(lastUserMessage)
}

async function* createPromptGenerator(
  userMessage: ModelMessage,
  toolResults: ToolResult[]
): AsyncIterable<SDKUserMessage> {
  // First, send any tool results from previous turn
  for (const result of toolResults) {
    yield {
      type: 'tool_result',
      tool_use_id: result.toolCallId,
      content: result.result
    }
  }
  
  // Then send the user message
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: formatContent(userMessage.content)
    }
  }
}
```

### Stream Translation: SDK → AI SDK

```typescript
function createSDKToAISDKStream(
  sdkResponse: AsyncGenerator<SDKMessage>,
  options: {
    onSessionId: (id: string) => void
    abortSignal?: AbortSignal
  }
): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const message of sdkResponse) {
          if (options.abortSignal?.aborted) {
            controller.close()
            return
          }
          
          // Handle different SDK message types
          switch (message.type) {
            case 'system':
              if (message.subtype === 'init') {
                // Capture session ID for future resume
                options.onSessionId(message.session_id)
              }
              break
              
            case 'assistant':
              // Full assistant message - extract content blocks
              for (const block of message.message.content) {
                if (block.type === 'text') {
                  controller.enqueue({
                    type: 'text',
                    text: block.text
                  })
                } else if (block.type === 'tool_use') {
                  // Tool call - OpenCode will execute this
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallId: block.id,
                    toolName: block.name,
                    args: block.input
                  })
                }
              }
              
              // Usage stats
              if (message.message.usage) {
                controller.enqueue({
                  type: 'usage',
                  usage: {
                    inputTokens: message.message.usage.input_tokens,
                    outputTokens: message.message.usage.output_tokens,
                    // Cache stats if available
                    ...(message.message.usage.cache_creation_input_tokens && {
                      cacheCreationInputTokens: message.message.usage.cache_creation_input_tokens
                    }),
                    ...(message.message.usage.cache_read_input_tokens && {
                      cacheReadInputTokens: message.message.usage.cache_read_input_tokens
                    })
                  }
                })
              }
              break
              
            case 'partial':
              // Streaming delta - text chunk
              controller.enqueue({
                type: 'text-delta',
                textDelta: message.delta
              })
              break
              
            case 'error':
              controller.error(new Error(message.error.message))
              return
          }
        }
        
        // Stream finished
        controller.enqueue({ type: 'finish', finishReason: 'stop' })
        controller.close()
        
      } catch (error) {
        controller.error(error)
      }
    }
  })
}
```

### Session Store Interface

```typescript
interface SessionStore {
  get(key: string): string | undefined
  set(key: string, sessionId: string): void
  delete(key: string): void
}

class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, string>()
  
  get(key: string) { return this.sessions.get(key) }
  set(key: string, id: string) { this.sessions.set(key, id) }
  delete(key: string) { this.sessions.delete(key) }
}
```

## Integration with OpenCode Provider System

```typescript
// In provider.ts CUSTOM_LOADERS

const CUSTOM_LOADERS: Record<string, CustomLoader> = {
  // ... existing loaders
  
  'claude-agent-sdk': async (input) => {
    return {
      autoload: true,  // Always available if SDK is installed
      options: {},
      async getModel(sdk: any, modelID: string) {
        return sdk.languageModel(modelID)
      }
    }
  }
}
```

## Acceptance Criteria

- [ ] AC-1: `ClaudeAgentSDKLanguageModel` implements full `LanguageModelV2` interface
- [ ] AC-2: `doStream()` correctly calls SDK `query()` with `allowedTools: []`
- [ ] AC-3: Session IDs are captured and stored for `resume` functionality
- [ ] AC-4: AI SDK messages translate correctly to SDK prompt format
- [ ] AC-5: SDK responses translate correctly to AI SDK stream events
- [ ] AC-6: Tool calls from Claude are emitted as `tool-call` events (not executed)
- [ ] AC-7: Extended thinking option maps to `maxThinkingTokens`
- [ ] AC-8: Usage stats including cache metrics are passed through
- [ ] AC-9: Abort signal properly terminates SDK stream

## Files to Create/Modify

```
packages/opencode/src/provider/sdk/claude-agent-sdk/
├── index.ts                    # Provider factory
├── claude-agent-sdk-model.ts   # LanguageModelV2 implementation
├── translate-prompt.ts         # AI SDK → SDK message translation
├── translate-stream.ts         # SDK → AI SDK stream translation
└── session-store.ts            # Session management for resume
```

## Time Estimate

predicted_hours: 8-10
actual_hours: TBD

## Dependencies

- `@anthropic-ai/claude-agent-sdk` npm package
- Understanding of SDK message types (from research)

## Notes

2026-01-25: Key insight from research - SDK's `query()` returns async generator of `SDKMessage` types. These include `system` (with session_id), `assistant` (with content blocks), `partial` (streaming deltas), and `error`. We map these to AI SDK stream events.

Tool execution flow: Claude outputs `tool_use` blocks → We emit `tool-call` events → OpenCode executes → We send `tool_result` in next prompt via async generator.
