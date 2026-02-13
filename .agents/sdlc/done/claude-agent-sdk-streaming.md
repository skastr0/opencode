# Claude Agent SDK Streaming and Message Translation

id: claude-agent-sdk-streaming

## Context

This work item handles the bidirectional translation between OpenCode's AI SDK message format and the Claude Agent SDK's message format. Correct translation is critical for:

1. Tool calls flowing to OpenCode for execution
2. Tool results flowing back to the SDK
3. Streaming text deltas rendering correctly
4. Extended thinking content being preserved
5. Usage stats being accurate

Parent: claude-agent-sdk-provider
Depends on: claude-agent-sdk-language-model

## Technical Design

### SDK Message Types

The Claude Agent SDK emits these message types:

```typescript
type SDKMessage = 
  | SDKSystemMessage      // Init with session_id, completion status
  | SDKAssistantMessage   // Full response with content blocks
  | SDKPartialMessage     // Streaming text delta (with includePartialMessages)
  | SDKResultMessage      // Tool execution result (from SDK - we don't use)
  | SDKErrorMessage       // Error from SDK

// Content block types in SDKAssistantMessage
type ContentBlock =
  | { type: 'text', text: string }
  | { type: 'tool_use', id: string, name: string, input: object }
  | { type: 'thinking', thinking: string }  // Extended thinking
```

### AI SDK Stream Event Types

OpenCode expects these stream events:

```typescript
type LanguageModelV2StreamPart =
  | { type: 'text', text: string }
  | { type: 'text-delta', textDelta: string }
  | { type: 'tool-call', toolCallId: string, toolName: string, args: object }
  | { type: 'tool-call-delta', toolCallId: string, argsTextDelta: string }
  | { type: 'reasoning', text: string }
  | { type: 'reasoning-delta', textDelta: string }
  | { type: 'finish', finishReason: FinishReason }
  | { type: 'error', error: Error }
  | { type: 'response-metadata', ... }
```

### Stream Transformer Implementation

```typescript
// packages/opencode/src/provider/sdk/claude-agent-sdk/translate-stream.ts

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { LanguageModelV2StreamPart, LanguageModelV2Usage } from '@ai-sdk/provider'

interface StreamTransformOptions {
  onSessionId: (sessionId: string) => void
  onUsage: (usage: LanguageModelV2Usage) => void
  includePartialMessages?: boolean
  abortSignal?: AbortSignal
}

export function createSDKStreamTransformer(
  sdkStream: AsyncGenerator<SDKMessage>,
  options: StreamTransformOptions
): ReadableStream<LanguageModelV2StreamPart> {
  const { onSessionId, onUsage, abortSignal } = options
  
  // Track tool calls for delta streaming
  const toolCallState = new Map<string, { name: string, argsSoFar: string }>()
  
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const message of sdkStream) {
          // Check abort
          if (abortSignal?.aborted) {
            controller.enqueue({ type: 'finish', finishReason: 'abort' })
            controller.close()
            return
          }
          
          const events = translateSDKMessage(message, {
            onSessionId,
            onUsage,
            toolCallState
          })
          
          for (const event of events) {
            controller.enqueue(event)
          }
        }
        
        // Stream complete
        controller.enqueue({ type: 'finish', finishReason: 'stop' })
        controller.close()
        
      } catch (error) {
        controller.enqueue({ 
          type: 'error', 
          error: error instanceof Error ? error : new Error(String(error))
        })
        controller.close()
      }
    },
    
    cancel() {
      // Handle stream cancellation
      // SDK stream will be garbage collected
    }
  })
}

function translateSDKMessage(
  message: SDKMessage,
  ctx: {
    onSessionId: (id: string) => void
    onUsage: (usage: LanguageModelV2Usage) => void
    toolCallState: Map<string, { name: string, argsSoFar: string }>
  }
): LanguageModelV2StreamPart[] {
  const events: LanguageModelV2StreamPart[] = []
  
  switch (message.type) {
    case 'system':
      if (message.subtype === 'init') {
        // Capture session ID for resume
        ctx.onSessionId(message.session_id)
        
        // Emit metadata
        events.push({
          type: 'response-metadata',
          id: message.session_id,
          timestamp: new Date()
        })
      }
      break
      
    case 'assistant':
      // Full message with content blocks
      events.push(...translateAssistantMessage(message, ctx))
      break
      
    case 'partial':
      // Streaming text delta
      if (message.delta) {
        events.push({
          type: 'text-delta',
          textDelta: message.delta
        })
      }
      break
      
    case 'error':
      events.push({
        type: 'error',
        error: new Error(message.error?.message ?? 'Unknown SDK error')
      })
      break
  }
  
  return events
}

function translateAssistantMessage(
  message: SDKAssistantMessage,
  ctx: {
    onUsage: (usage: LanguageModelV2Usage) => void
    toolCallState: Map<string, { name: string, argsSoFar: string }>
  }
): LanguageModelV2StreamPart[] {
  const events: LanguageModelV2StreamPart[] = []
  
  // Process content blocks
  for (const block of message.message.content) {
    switch (block.type) {
      case 'text':
        events.push({
          type: 'text',
          text: block.text
        })
        break
        
      case 'tool_use':
        // CRITICAL: This is a tool call for OpenCode to execute
        // We emit it as tool-call, NOT execute it ourselves
        events.push({
          type: 'tool-call',
          toolCallId: block.id,
          toolName: block.name,
          args: block.input
        })
        break
        
      case 'thinking':
        // Extended thinking content
        events.push({
          type: 'reasoning',
          text: block.thinking
        })
        break
    }
  }
  
  // Process usage stats
  if (message.message.usage) {
    const usage = message.message.usage
    ctx.onUsage({
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      // Cache metrics - important for monitoring efficiency
      ...(usage.cache_creation_input_tokens !== undefined && {
        cacheCreationInputTokens: usage.cache_creation_input_tokens
      }),
      ...(usage.cache_read_input_tokens !== undefined && {
        cacheReadInputTokens: usage.cache_read_input_tokens
      })
    })
  }
  
  return events
}
```

### Prompt Translation: AI SDK → SDK

```typescript
// packages/opencode/src/provider/sdk/claude-agent-sdk/translate-prompt.ts

import type { LanguageModelV2Prompt, ModelMessage } from '@ai-sdk/provider'

type SDKPrompt = string | AsyncIterable<SDKInputMessage>

interface SDKInputMessage {
  type: 'user' | 'tool_result'
  message?: { role: 'user', content: string | ContentPart[] }
  tool_use_id?: string
  content?: string
}

export function translatePromptToSDK(
  prompt: LanguageModelV2Prompt,
  existingSession: boolean
): SDKPrompt {
  // Extract the latest user message and any tool results
  const toolResults = extractToolResults(prompt)
  const userMessage = extractLastUserMessage(prompt)
  
  // If we have tool results, we need to use async generator
  // to send them before the user message
  if (toolResults.length > 0) {
    return createPromptGenerator(toolResults, userMessage)
  }
  
  // If resuming session with just user message, send as string
  if (existingSession && !toolResults.length) {
    return extractTextFromMessage(userMessage)
  }
  
  // First message or no session - send full context
  return createInitialPromptGenerator(prompt)
}

function extractToolResults(prompt: LanguageModelV2Prompt): ToolResultInfo[] {
  const results: ToolResultInfo[] = []
  
  for (const message of prompt) {
    if (message.role !== 'tool') continue
    
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'tool-result') {
          results.push({
            toolCallId: part.toolCallId,
            result: part.result
          })
        }
      }
    }
  }
  
  return results
}

async function* createPromptGenerator(
  toolResults: ToolResultInfo[],
  userMessage: ModelMessage | undefined
): AsyncIterable<SDKInputMessage> {
  // First, send all tool results
  for (const result of toolResults) {
    yield {
      type: 'tool_result',
      tool_use_id: result.toolCallId,
      content: typeof result.result === 'string' 
        ? result.result 
        : JSON.stringify(result.result)
    }
  }
  
  // Then send user message if present
  if (userMessage) {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: formatMessageContent(userMessage.content)
      }
    }
  }
}

function formatMessageContent(
  content: string | ContentPart[]
): string | ContentPart[] {
  if (typeof content === 'string') {
    return content
  }
  
  // Handle multimodal content (images, files, etc.)
  return content.map(part => {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text }
      case 'image':
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.mediaType,
            data: part.image
          }
        }
      case 'file':
        // Handle file attachments
        return {
          type: 'document',
          source: {
            type: 'base64',
            media_type: part.mediaType,
            data: part.data
          }
        }
      default:
        return part
    }
  })
}
```

### Tool Call Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TOOL EXECUTION FLOW                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. Claude requests tool use                                                │
│     ┌─────────────┐                                                         │
│     │   Claude    │  SDKAssistantMessage {                                 │
│     │             │    content: [{                                         │
│     │             │      type: 'tool_use',                                 │
│     │             │      id: 'tool_123',                                   │
│     │             │      name: 'Read',                                     │
│     │             │      input: { path: '/src/index.ts' }                  │
│     │             │    }]                                                  │
│     └─────────────┘  }                                                     │
│           │                                                                 │
│           ▼                                                                 │
│  2. Stream transformer emits tool-call event                                │
│     ┌─────────────┐                                                         │
│     │  Translate  │  {                                                      │
│     │   Stream    │    type: 'tool-call',                                  │
│     │             │    toolCallId: 'tool_123',                             │
│     │             │    toolName: 'Read',                                   │
│     │             │    args: { path: '/src/index.ts' }                     │
│     └─────────────┘  }                                                     │
│           │                                                                 │
│           ▼                                                                 │
│  3. OpenCode receives and executes (in Bun runtime)                         │
│     ┌─────────────┐                                                         │
│     │  OpenCode   │  const result = await ReadTool.execute({               │
│     │   Tool      │    path: '/src/index.ts'                               │
│     │  Executor   │  })  // Runs in Bun!                                   │
│     └─────────────┘                                                         │
│           │                                                                 │
│           ▼                                                                 │
│  4. Tool result added to next prompt                                        │
│     ┌─────────────┐                                                         │
│     │  OpenCode   │  messages.push({                                       │
│     │   Session   │    role: 'tool',                                       │
│     │             │    content: [{                                         │
│     │             │      type: 'tool-result',                              │
│     │             │      toolCallId: 'tool_123',                           │
│     │             │      result: '// file contents...'                     │
│     │             │    }]                                                  │
│     └─────────────┘  })                                                    │
│           │                                                                 │
│           ▼                                                                 │
│  5. Next query sends tool result via prompt generator                       │
│     ┌─────────────┐                                                         │
│     │  Translate  │  yield {                                               │
│     │   Prompt    │    type: 'tool_result',                                │
│     │             │    tool_use_id: 'tool_123',                            │
│     │             │    content: '// file contents...'                      │
│     └─────────────┘  }                                                     │
│           │                                                                 │
│           ▼                                                                 │
│  6. SDK sends to Claude with session resume                                 │
│     ┌─────────────┐                                                         │
│     │  SDK query  │  query({                                               │
│     │             │    prompt: toolResultGenerator,                        │
│     │             │    options: { resume: 'session_abc' }                  │
│     └─────────────┘  })                                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Acceptance Criteria

- [ ] AC-1: SDK `system.init` messages correctly capture session_id
- [ ] AC-2: SDK `assistant` messages with `text` blocks emit `text` events
- [ ] AC-3: SDK `assistant` messages with `tool_use` blocks emit `tool-call` events
- [ ] AC-4: SDK `assistant` messages with `thinking` blocks emit `reasoning` events
- [ ] AC-5: SDK `partial` messages emit `text-delta` events for streaming
- [ ] AC-6: SDK `error` messages emit `error` events
- [ ] AC-7: Usage stats including cache metrics are passed through
- [ ] AC-8: Tool results from OpenCode translate to SDK `tool_result` format
- [ ] AC-9: Multimodal content (images, files) translates correctly
- [ ] AC-10: Abort signal properly terminates stream

## Edge Cases to Handle

1. **Empty content blocks** - Filter out, don't emit events
2. **Multiple tool calls in one response** - Emit multiple `tool-call` events
3. **Interleaved thinking and text** - Preserve order
4. **Large tool results** - May need truncation
5. **Binary file content** - Base64 encode

## Time Estimate

predicted_hours: 5-6
actual_hours: TBD

## Notes

2026-01-25: Key insight - tool execution MUST happen in OpenCode (Bun runtime) because many tools depend on Bun APIs. The SDK's job is just to relay Claude's tool requests and accept results.

Stream transformer is stateless except for toolCallState (needed for delta streaming of tool args).
