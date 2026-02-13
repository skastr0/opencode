# Claude Max Provider Integration - SDLC Tracker

## Overview

Integrating `@anthropic-ai/claude-agent-sdk` as a first-class provider in OpenCode, enabling Claude Max subscribers to use their subscription directly.

## Work Items

### Phase 1: Research (exploring → committed)

| ID | Title | Status | Est |
|----|-------|--------|-----|
| claude-max-sdk-research | Research SDK API surface | 🟡 committed | 2h |

### Phase 2: Core Implementation (committed → building)

| ID | Title | Status | Est | Depends On |
|----|-------|--------|-----|------------|
| claude-max-ai-sdk-provider | AI SDK LanguageModelV2 wrapper | 🟡 committed | 6-8h | sdk-research |
| claude-max-auth-plugin | Auth flow integration | 🟡 committed | 4h | sdk-research |
| claude-max-model-definitions | Model definitions | 🟡 committed | 1h | - |

### Phase 3: Polish (committed → building)

| ID | Title | Status | Est | Depends On |
|----|-------|--------|-----|------------|
| claude-max-streaming-support | Streaming/tools/thinking | 🟡 committed | 3-4h | ai-sdk-provider |
| claude-max-testing | E2E testing | ⚪ backlog | 2-3h | streaming-support |

## Implementation Order

```
1. claude-max-sdk-research      ← START HERE
   │
   ├──→ 2a. claude-max-ai-sdk-provider
   │         │
   │         └──→ 4. claude-max-streaming-support
   │                   │
   │                   └──→ 5. claude-max-testing
   │
   └──→ 2b. claude-max-auth-plugin
   
3. claude-max-model-definitions  (parallel with 2a/2b)
```

## Key Files to Modify

```
packages/opencode/
├── src/provider/
│   ├── provider.ts      # Add to BUNDLED_PROVIDERS or CUSTOM_LOADERS
│   ├── models.ts        # Model definitions (or via config)
│   └── sdk/
│       └── claude-max/  # NEW: Claude Max SDK wrapper
│           ├── index.ts
│           ├── provider.ts
│           └── auth.ts
├── package.json         # Add @anthropic-ai/claude-agent-sdk dependency
└── test/
    └── claude-max.test.ts
```

## Reference

- [opencode-claude-max-proxy](https://github.com/rynfar/opencode-claude-max-proxy) - Working proxy implementation to reference
- [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) - Official Anthropic SDK

## Legend

- 🔵 exploring
- 🟡 committed
- 🟢 building
- 🟣 reviewing
- ✅ done
- ⚪ backlog
- ❌ abandoned
