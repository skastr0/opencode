# Claude Agent SDK Model Definitions

id: claude-agent-sdk-models

## Context

OpenCode's provider system requires model definitions with capabilities, costs, limits, etc. This work item adds model definitions for the Claude Agent SDK provider so models appear in the model selector.

Parent: claude-agent-sdk-provider

## Technical Design

### Provider Registration

The Claude Agent SDK provider needs to be registered in the provider system. There are two approaches:

#### Option A: models.dev Entry (Recommended)

Add to the models.dev database or local config:

```yaml
# In models.dev or opencode.json provider config
claude-agent-sdk:
  id: claude-agent-sdk
  name: Claude Agent SDK
  npm: "@anthropic-ai/claude-agent-sdk"
  api: null  # SDK doesn't use HTTP API directly
  env:
    - ANTHROPIC_API_KEY  # For API key auth
  models:
    claude-opus-4:
      id: claude-opus-4-20250514
      name: Claude Opus 4
      # ... full definition below
```

#### Option B: Hardcoded in Provider System

Add to `BUNDLED_PROVIDERS` or create custom loader:

```typescript
// In provider.ts
const CUSTOM_LOADERS: Record<string, CustomLoader> = {
  'claude-agent-sdk': async (input) => {
    // Check if SDK is available and auth is configured
    const hasAuth = await checkSDKAuth()
    
    return {
      autoload: hasAuth,
      options: {},
      async getModel(sdk: any, modelID: string) {
        return sdk.languageModel(modelID)
      }
    }
  }
}
```

### Model Definitions

```typescript
// packages/opencode/src/provider/sdk/claude-agent-sdk/models.ts

import type { Provider } from '../provider'

export const CLAUDE_AGENT_SDK_MODELS: Record<string, Provider.Model> = {
  'claude-opus-4': {
    id: 'claude-opus-4',
    providerID: 'claude-agent-sdk',
    name: 'Claude Opus 4',
    family: 'claude-4',
    api: {
      id: 'claude-opus-4-20250514',
      url: '',  // SDK handles connection
      npm: '@anthropic-ai/claude-agent-sdk'
    },
    status: 'active',
    capabilities: {
      temperature: true,
      reasoning: true,  // Extended thinking
      attachment: true, // Images, PDFs
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: true
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false
      },
      interleaved: true  // Interleaved thinking
    },
    cost: {
      // Costs depend on auth method (API key vs subscription)
      // Set to 0 for now - actual billing is per auth method
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0
      }
    },
    limit: {
      context: 200000,
      output: 32000
    },
    options: {},
    headers: {},
    release_date: '2025-05-14',
    variants: {
      'high': {
        thinking: {
          type: 'enabled',
          budgetTokens: 16000
        }
      },
      'max': {
        thinking: {
          type: 'enabled',
          budgetTokens: 31999
        }
      }
    }
  },
  
  'claude-sonnet-4': {
    id: 'claude-sonnet-4',
    providerID: 'claude-agent-sdk',
    name: 'Claude Sonnet 4',
    family: 'claude-4',
    api: {
      id: 'claude-sonnet-4-20250514',
      url: '',
      npm: '@anthropic-ai/claude-agent-sdk'
    },
    status: 'active',
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: true
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false
      },
      interleaved: true
    },
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 }
    },
    limit: {
      context: 200000,
      output: 64000
    },
    options: {},
    headers: {},
    release_date: '2025-05-14',
    variants: {
      'high': {
        thinking: {
          type: 'enabled',
          budgetTokens: 16000
        }
      },
      'max': {
        thinking: {
          type: 'enabled',
          budgetTokens: 31999
        }
      }
    }
  },
  
  'claude-haiku-4': {
    id: 'claude-haiku-4',
    providerID: 'claude-agent-sdk',
    name: 'Claude Haiku 4',
    family: 'claude-4',
    api: {
      id: 'claude-haiku-4-20250514',
      url: '',
      npm: '@anthropic-ai/claude-agent-sdk'
    },
    status: 'active',
    capabilities: {
      temperature: true,
      reasoning: false,  // Haiku doesn't support extended thinking
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: true
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false
      },
      interleaved: false
    },
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 }
    },
    limit: {
      context: 200000,
      output: 8192
    },
    options: {},
    headers: {},
    release_date: '2025-05-14',
    variants: {}
  }
}
```

### Provider Factory

```typescript
// packages/opencode/src/provider/sdk/claude-agent-sdk/index.ts

import { CLAUDE_AGENT_SDK_MODELS } from './models'
import { ClaudeAgentSDKLanguageModel } from './claude-agent-sdk-model'
import { ClaudeAgentSDKSessionStore } from './session-store'

interface ClaudeAgentSDKProviderSettings {
  sessionStore?: ClaudeAgentSDKSessionStore
}

export function createClaudeAgentSDK(settings: ClaudeAgentSDKProviderSettings = {}) {
  const sessionStore = settings.sessionStore ?? new ClaudeAgentSDKSessionStore()
  
  const provider = {
    languageModel(modelId: string) {
      const modelDef = CLAUDE_AGENT_SDK_MODELS[modelId]
      if (!modelDef) {
        throw new Error(`Unknown model: ${modelId}`)
      }
      return new ClaudeAgentSDKLanguageModel(modelDef, sessionStore)
    }
  }
  
  return provider
}

// Export models for provider registration
export { CLAUDE_AGENT_SDK_MODELS }
```

### Integration with OpenCode Config

Users can configure the provider in `opencode.json`:

```json
{
  "provider": {
    "claude-agent-sdk": {
      "name": "Claude Agent SDK",
      "models": {
        "claude-opus-4": {
          "name": "Claude Opus 4 (SDK)"
        },
        "claude-sonnet-4": {
          "name": "Claude Sonnet 4 (SDK)"
        },
        "claude-haiku-4": {
          "name": "Claude Haiku 4 (SDK)"
        }
      }
    }
  }
}
```

### Model ID Mapping

The SDK uses specific model identifiers. Map OpenCode IDs to SDK IDs:

```typescript
const MODEL_ID_MAP: Record<string, string> = {
  // OpenCode ID -> SDK model name
  'claude-opus-4': 'claude-opus-4-20250514',
  'claude-opus-4-20250514': 'claude-opus-4-20250514',
  'claude-sonnet-4': 'claude-sonnet-4-20250514',
  'claude-sonnet-4-20250514': 'claude-sonnet-4-20250514',
  'claude-haiku-4': 'claude-haiku-4-20250514',
  'claude-haiku-4-20250514': 'claude-haiku-4-20250514',
  
  // Also support short names
  'opus': 'claude-opus-4-20250514',
  'sonnet': 'claude-sonnet-4-20250514',
  'haiku': 'claude-haiku-4-20250514'
}

export function mapModelId(openCodeId: string): string {
  return MODEL_ID_MAP[openCodeId] ?? openCodeId
}
```

## Acceptance Criteria

- [ ] AC-1: `claude-agent-sdk` provider appears in provider list
- [ ] AC-2: Opus, Sonnet, Haiku models appear in model selector
- [ ] AC-3: Model capabilities (reasoning, attachment, etc.) are correct
- [ ] AC-4: Context limits are accurate (200k)
- [ ] AC-5: Extended thinking variants (high, max) work for Opus/Sonnet
- [ ] AC-6: Model ID mapping handles all common formats
- [ ] AC-7: Provider can be configured via opencode.json

## Files to Create/Modify

```
packages/opencode/src/provider/sdk/claude-agent-sdk/
├── models.ts       # Model definitions
└── index.ts        # Add model exports

packages/opencode/src/provider/
└── provider.ts     # Add CUSTOM_LOADERS entry
```

## Time Estimate

predicted_hours: 2-3
actual_hours: TBD

## Notes

2026-01-25: Costs are set to 0 because billing depends on authentication method:
- API key: Standard Anthropic API pricing
- CLI login (Max subscription): Included in subscription
- Bedrock/Vertex/Foundry: Provider-specific pricing

The provider doesn't know or care how authentication works - that's the user's choice.
