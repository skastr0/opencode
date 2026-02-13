# Claude Agent SDK End-to-End Testing

id: claude-agent-sdk-testing

## Context

After implementation, we need comprehensive testing to ensure the Claude Agent SDK provider works correctly across all OpenCode features. This includes unit tests for message translation and integration tests for the full tool execution flow.

Parent: claude-agent-sdk-provider
Depends on: All other claude-agent-sdk-* work items

## Test Categories

### 1. Unit Tests: Message Translation

```typescript
// packages/opencode/test/provider/claude-agent-sdk/translate-prompt.test.ts

describe('translatePromptToSDK', () => {
  it('translates simple user message to string prompt', () => {
    const prompt: LanguageModelV2Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
    ]
    const result = translatePromptToSDK(prompt, false)
    expect(result).toBe('Hello')
  })
  
  it('creates async generator for tool results', async () => {
    const prompt: LanguageModelV2Prompt = [
      { role: 'tool', content: [{ 
        type: 'tool-result', 
        toolCallId: 'tool_123', 
        result: 'file contents' 
      }]}
    ]
    const result = translatePromptToSDK(prompt, true)
    
    // Should be async iterable
    expect(Symbol.asyncIterator in result).toBe(true)
    
    const messages = []
    for await (const msg of result) {
      messages.push(msg)
    }
    
    expect(messages[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tool_123',
      content: 'file contents'
    })
  })
  
  it('handles multimodal content (images)', () => {
    // Test image translation
  })
})
```

### 2. Unit Tests: Stream Translation

```typescript
// packages/opencode/test/provider/claude-agent-sdk/translate-stream.test.ts

describe('createSDKStreamTransformer', () => {
  it('emits text events from assistant messages', async () => {
    const mockStream = createMockSDKStream([
      { type: 'system', subtype: 'init', session_id: 'sess_123' },
      { type: 'assistant', message: { 
        content: [{ type: 'text', text: 'Hello!' }],
        usage: { input_tokens: 10, output_tokens: 5 }
      }}
    ])
    
    const events = await collectStreamEvents(
      createSDKStreamTransformer(mockStream, { onSessionId: () => {}, onUsage: () => {} })
    )
    
    expect(events).toContainEqual({ type: 'text', text: 'Hello!' })
  })
  
  it('emits tool-call events (NOT executing them)', async () => {
    const mockStream = createMockSDKStream([
      { type: 'assistant', message: {
        content: [{
          type: 'tool_use',
          id: 'tool_456',
          name: 'Read',
          input: { path: '/src/index.ts' }
        }]
      }}
    ])
    
    const events = await collectStreamEvents(
      createSDKStreamTransformer(mockStream, { onSessionId: () => {}, onUsage: () => {} })
    )
    
    expect(events).toContainEqual({
      type: 'tool-call',
      toolCallId: 'tool_456',
      toolName: 'Read',
      args: { path: '/src/index.ts' }
    })
  })
  
  it('captures session ID from init message', async () => {
    let capturedSessionId: string | undefined
    
    const mockStream = createMockSDKStream([
      { type: 'system', subtype: 'init', session_id: 'sess_789' }
    ])
    
    await collectStreamEvents(
      createSDKStreamTransformer(mockStream, { 
        onSessionId: (id) => { capturedSessionId = id },
        onUsage: () => {}
      })
    )
    
    expect(capturedSessionId).toBe('sess_789')
  })
  
  it('emits reasoning events from thinking blocks', async () => {
    // Test extended thinking translation
  })
  
  it('includes cache metrics in usage', async () => {
    let capturedUsage: any
    
    const mockStream = createMockSDKStream([
      { type: 'assistant', message: {
        content: [{ type: 'text', text: 'Hi' }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 80,
          cache_read_input_tokens: 0
        }
      }}
    ])
    
    await collectStreamEvents(
      createSDKStreamTransformer(mockStream, {
        onSessionId: () => {},
        onUsage: (u) => { capturedUsage = u }
      })
    )
    
    expect(capturedUsage.cacheCreationInputTokens).toBe(80)
  })
})
```

### 3. Unit Tests: Session Management

```typescript
// packages/opencode/test/provider/claude-agent-sdk/session-store.test.ts

describe('ClaudeAgentSDKSessionStore', () => {
  it('stores and retrieves session IDs', () => {
    const store = new ClaudeAgentSDKSessionStore()
    
    store.set('opencode_sess_1', 'sdk_sess_abc', 'claude-sonnet-4')
    
    expect(store.get('opencode_sess_1', 'claude-sonnet-4')).toBe('sdk_sess_abc')
  })
  
  it('invalidates session when model changes', () => {
    const store = new ClaudeAgentSDKSessionStore()
    
    store.set('opencode_sess_1', 'sdk_sess_abc', 'claude-sonnet-4')
    
    // Different model - should not return session
    expect(store.get('opencode_sess_1', 'claude-opus-4')).toBeUndefined()
  })
  
  it('tracks cache stats correctly', () => {
    const store = new ClaudeAgentSDKSessionStore()
    
    store.set('sess_1', 'sdk_1', 'model')
    store.set('sess_2', 'sdk_2', 'model')
    
    const stats = store.getStats()
    expect(stats.total).toBe(2)
    expect(stats.active).toBe(2)  // Both recently created
  })
})
```

### 4. Integration Tests: Tool Execution Flow

```typescript
// packages/opencode/test/provider/claude-agent-sdk/integration.test.ts

describe('Claude Agent SDK Integration', () => {
  it('executes Read tool via OpenCode (not SDK)', async () => {
    // This test verifies the critical requirement:
    // Tool execution happens in OpenCode's Bun runtime
    
    const provider = createClaudeAgentSDK()
    const model = provider.languageModel('claude-sonnet-4')
    
    // Mock the SDK query to return a tool_use
    vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
      query: vi.fn().mockImplementation(async function*() {
        yield { type: 'system', subtype: 'init', session_id: 'test_sess' }
        yield { type: 'assistant', message: {
          content: [{
            type: 'tool_use',
            id: 'tool_read_1',
            name: 'Read',
            input: { path: '/test/file.ts' }
          }],
          usage: { input_tokens: 50, output_tokens: 20 }
        }}
      })
    }))
    
    const result = await model.doStream({
      prompt: [{ role: 'user', content: 'Read the test file' }]
    })
    
    const events = await collectStreamEvents(result.stream)
    
    // Should emit tool-call, NOT execute the tool
    const toolCall = events.find(e => e.type === 'tool-call')
    expect(toolCall).toBeDefined()
    expect(toolCall.toolName).toBe('Read')
    
    // Verify SDK query was called with allowedTools: []
    expect(require('@anthropic-ai/claude-agent-sdk').query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          allowedTools: []
        })
      })
    )
  })
  
  it('maintains session for subsequent messages', async () => {
    // Test that session ID is reused via resume
  })
  
  it('sends tool results in resumed session', async () => {
    // Test tool result flow
  })
})
```

### 5. Manual Test Scenarios

```markdown
## Manual Testing Checklist

### Basic Chat
- [ ] Select claude-agent-sdk/claude-sonnet-4 as model
- [ ] Send a simple message
- [ ] Verify streaming response appears
- [ ] Check session ID is captured (debug logs)

### Tool Execution
- [ ] Ask Claude to read a file ("Read packages/opencode/src/index.ts")
- [ ] Verify Read tool is executed by OpenCode (not SDK)
- [ ] Verify file contents appear in response
- [ ] Ask follow-up question about the file (tests session continuity)

### Multi-Tool Conversation
- [ ] Ask Claude to search and edit a file
- [ ] Verify Grep → Read → Edit flow works
- [ ] Verify all tools execute in Bun runtime

### Extended Thinking
- [ ] Select claude-sonnet-4:high variant
- [ ] Ask complex reasoning question
- [ ] Verify thinking content appears
- [ ] Check token usage includes thinking tokens

### Session Caching
- [ ] Start conversation, note cache_creation_input_tokens
- [ ] Send follow-up within 5 minutes
- [ ] Verify cache_read_input_tokens > 0 (cache hit)
- [ ] Wait 5+ minutes, send another message
- [ ] Verify cache_creation_input_tokens > 0 (cache miss/rebuild)

### Error Handling
- [ ] Test with invalid API key (if using API auth)
- [ ] Test network disconnection mid-stream
- [ ] Test abort (Ctrl+C) during response
```

## Acceptance Criteria

- [ ] AC-1: Unit tests for prompt translation pass
- [ ] AC-2: Unit tests for stream translation pass
- [ ] AC-3: Unit tests for session management pass
- [ ] AC-4: Integration test verifies tool execution in OpenCode
- [ ] AC-5: Integration test verifies session continuity
- [ ] AC-6: Manual test: basic chat works
- [ ] AC-7: Manual test: tool execution works
- [ ] AC-8: Manual test: extended thinking works
- [ ] AC-9: Manual test: caching works (observable in usage stats)

## Test Files to Create

```
packages/opencode/test/provider/claude-agent-sdk/
├── translate-prompt.test.ts
├── translate-stream.test.ts
├── session-store.test.ts
├── integration.test.ts
└── helpers.ts              # Mock SDK stream helpers
```

## Time Estimate

predicted_hours: 4-6
actual_hours: TBD

## Notes

2026-01-25: Key test to prioritize: verifying that `allowedTools: []` is always passed to SDK. This is the critical safety check that ensures OpenCode executes tools, not the SDK.

Cache testing may require real SDK calls to verify - consider having both mocked unit tests and optional live integration tests.
