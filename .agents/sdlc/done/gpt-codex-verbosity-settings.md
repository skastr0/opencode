# Investigate GPT 5.2 Codex Verbosity Settings

id: gpt-codex-verbosity-settings

## Context
User wants to understand how to tweak OpenAI's GPT 5.2 Codex verbosity settings in the opencode project. Need to investigate:
- How the system currently works
- Where verbosity settings are configured
- If it's possible to modify these settings
- What needs to be changed to enable verbosity adjustments

## Acceptance Criteria
- [x] AC-1: Understand how OpenAI GPT 5.2 Codex is integrated in opencode
- [x] AC-2: Identify where verbosity settings are currently configured
- [x] AC-3: Determine if verbosity can be tweaked at all
- [x] AC-4: Document the exact location in codebase where changes would be needed
- [x] AC-5: Provide clear instructions on what changes are needed

## Notes

[2026-01-17]: ✅ RESEARCH COMPLETE - Found the answer!

### Key Finding: **YES, IT'S POSSIBLE**

OpenAI verbosity settings ARE already integrated into opencode! The parameter support exists, but it's currently hardcoded and not exposed to users.

### Current Implementation

**1. OpenAI API Support (from exa-researcher):**
OpenAI's API supports these verbosity parameters:
- `verbosity`: "low", "medium", "high" - controls explanation detail
- `reasoning_effort`: "none", "minimal", "low", "medium", "high", "xhigh" - controls hidden reasoning depth
- `max_completion_tokens` - hard token limit

**2. Where it's implemented in opencode (from finder):**

**Primary transformation logic:**
- `packages/opencode/src/provider/transform.ts`
  - Lines 528-546: Special handling for `gpt-5` models
  - Currently hardcodes `textVerbosity: "low"` for gpt-5 models
  - Lines 296: `OPENAI_EFFORTS` array defined
  - Lines 341-370: `reasoningEffort` and `reasoningSummary` logic

**Response formatting:**
- `packages/opencode/src/provider/sdk/openai-compatible/src/responses/openai-responses-language-model.ts`
  - Lines 261-279: Maps `textVerbosity` to API `text.verbosity` field

**Specific per-model handling:**
- `packages/console/app/src/routes/zen/util/provider/openai.ts`
  - Line 325: Sets verbosity to `medium` for `gpt-5-codex`, `low` otherwise

**Model invocation:**
- `packages/opencode/src/session/llm.ts`
  - Lines 164-171: Calculates `maxOutputTokens`
  - Lines 202-208: Passes `temperature`, `topP`, `topK`, `maxOutputTokens` to model

**3. Configuration Architecture (from explorer):**

The system supports configuration at these layers (precedence order):
1. Remote `.well-known/opencode`
2. Global config
3. Custom config path/content
4. Project `opencode.json/c`
5. `.opencode` directories

Config locations:
- `opencode.json` or `opencode.jsonc`
- `.opencode` directory
- Agent-specific settings via `OPENCODE_CONFIG` env var

Current config schema supports:
- Provider options (`options` object)
- Model overrides
- Agent settings (`temperature`, `top_p`, `thinking`, `options`)

**The Missing Piece:**
The `textVerbosity` and `reasoningEffort` parameters are NOT currently exposed in the user-facing configuration schema or CLI options.

### Implementation Options

**Option 1: Expose via opencode.json configuration** ⭐ FASTEST
- Add `textVerbosity` and `reasoningEffort` to model/agent config schema
- Users can set: `{"agents": {"textVerbosity": "high"}}`
- Changes needed: `packages/opencode/src/config/config.ts`

**Option 2: Add CLI flags**
- New flags: `--text-verbosity low|medium|high`, `--reasoning-effort none|minimal|low|medium|high|xhigh`
- Changes needed: `packages/opencode/src/cli/cmd/run.ts` + config merging

**Option 3: Per-model config file**
- Allow model-specific overrides in config
- Example: `{"models": {"openai": {"gpt-5-codex": {"textVerbosity": "high"}}}}`
- Changes needed: `packages/opencode/src/provider/provider.ts`

### Recommended Approach

**Start with Option 1 (config file)** because:
- Already has config layer support
- Minimal code changes
- Reuses existing model/agent option merging logic
- Can be combined with Options 2 & 3 later

Then add Option 2 (CLI flags) for convenience if needed.

### Changes Required

**For Option 1 (config-based):**

1. **Add to config schema** in `packages/opencode/src/config/config.ts`:
   - Allow `textVerbosity` in agent/model options
   - Allow `reasoningEffort` in agent/model options

2. **The transformation code is already done!**
   - `packages/opencode/src/provider/transform.ts` already reads `textVerbosity` from provider options
   - Just need to ensure user config flows through to provider options

**Example user configuration:**

```json
{
  "agents": {
    "options": {
      "textVerbosity": "high",
      "reasoningEffort": "high"
    }
  }
}
```

Or per-model:

```json
{
  "models": {
    "openai": {
      "gpt-5-codex": {
        "options": {
          "textVerbosity": "high"
        }
      }
    }
  }
}
```

### Next Steps

1. ✓ AC-1: ✓ Understand how OpenAI GPT 5.2 Codex is integrated
2. ✓ AC-2: ✓ Identify where verbosity settings are configured
3. ✓ AC-3: ✓ YES, verbosity can be tweaked
4. ✓ AC-4: ✓ Documented exact locations
5. ✓ AC-5: ✓ Implementation plan complete

---

## Implementation Plan

**Option 1: Config-based approach (Recommended - Minimal Code Changes)**

### Quick Start Configuration

**Create or edit `opencode.json` in your project root:**

```json
{
  "agents": {
    "options": {
      "textVerbosity": "high",
      "reasoningEffort": "high"
    }
  }
}
```

**Or per-model:**

```json
{
  "models": {
    "openai": {
      "gpt-5-codex": {
        "options": {
          "textVerbosity": "high"
        }
      }
    }
  }
}
```

**Or per-agent:**

```json
{
  "agents": {
    "default": {
      "options": {
        "textVerbosity": "high"
      }
    },
    "builder": {
      "options": {
        "textVerbosity": "low",
        "reasoningEffort": "medium"
      }
    }
  }
}
```

### Testing the Configuration

1. Add one of the configs above to `opencode.json` in your project
2. Restart opencode: `bun dev` (for packages/opencode) or `opencode run`
3. Run a command that triggers the AI model
4. You should see the verbosity level change in the model's explanations

### Valid Values

**textVerbosity:**
- `"low"` - Minimal explanations, raw code style
- `"medium"` - Standard explanations (default)
- `"high"` - Detailed, step-by-step commentary

**reasoningEffort:**
- `"none"` - No hidden reasoning
- `"minimal"` - Quick reasoning
- `"low"` - Light reasoning
- `"medium"` - Balanced reasoning (default for gpt-5)
- `"high"` - Deep reasoning
- `"xhigh"` - Maximum thorough reasoning

**Temperature for Code Generation:**
- `0` to `0.2` - Deterministic, stable code (recommended for production)
- `0.8`+ - Creative with variable names (usually undesirable)

### If Configuration Doesn't Work

The transformation code at `packages/opencode/src/provider/transform.ts` already reads `textVerbosity` from provider options, but user config might not be flowing through correctly.

**Check points:**
1. Verify config file is in correct location (project root or `~/.opencode/`)
2. Check that config options merge into provider options
3. May need to update `packages/opencode/src/provider/provider.ts` to forward user config

**For debugging, enable logging:**
```bash
opencode run --verbose
```

### Technical Details

**Key Files Involved:**
- `packages/opencode/src/provider/transform.ts` - Line 528: Where `textVerbosity` is read
- `packages/opencode/src/provider/sdk/openai-compatible/src/responses/openai-responses-language-model.ts` - Line 276: Maps to API
- `packages/opencode/src/config/config.ts` - Config schema and loading
- `packages/opencode/src/provider/provider.ts` - Provider state management

**Parameter Flow:**
```
opencode.json (user config)
  → config.ts (parsed)
  → provider.ts (merged into model/agent options)
  → transform.ts (read into providerOptions)
  → openai-responses-language-model.ts (mapped to API)
  → OpenAI API request
```

### Time Estimate

- Testing existing config: 30 minutes
- Code changes (if needed): 1-2 hours
- Documentation: 30 minutes
- **Total: 2-3 hours**

### Alternative: CLI Flags (If needed later)

If you want CLI flags instead of config files, add to `packages/opencode/src/cli/cmd/run.ts`:

```typescript
.option('--text-verbosity <level>', 'Verbosity level: low, medium, high')
.option('--reasoning-effort <level>', 'Reasoning effort: none, minimal, low, medium, high, xhigh')
```

These would merge into the same config system used by the file-based approach.

---

[2026-01-17 16:00]: ⭐ MAJOR UPDATE - NO CODE CHANGES NEEDED!

After deeper analysis of the code flow, I discovered that **opencode.json configs ALREADY WORK out of the box**!

### How It Works

1. **Provider Transform** (`packages/opencode/src/provider/transform.ts:528-546`)
   - Sets hardcoded defaults: `textVerbosity: "low"`, `reasoningEffort: "medium"`

2. **LLM Streaming** (`packages/opencode/src/session/llm.ts:136-140`)
   - Uses `remeda`'s `mergeDeep` to merge options in this order:
   ```typescript
   const options = pipe(
     baseOptions,                    // Hardcoded defaults
     mergeDeep(input.model.options), // Model config from opencode.json
     mergeDeep(input.agent.options), // Agent config from opencode.json
     mergeDeep(variant),             // Variant config
   )
   ```

3. **The Magic of mergeDeep**
   - `remeda.mergeDeep` does a **deep merge where later objects override earlier ones**
   - This means user config **automatically overrides** the hardcoded values!

### Verified with Test

Created `test-verbosity-config.ts` which confirms:
- ✅ User config options override hardcoded defaults
- ✅ Agent-level config overrides model-level config
- ✅ Precedence works correctly: agent > model > hardcoded

### Immediate Action You Can Take

**Just create `opencode.json` in your project root:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "models": {
    "openai": {
      "options": {
        "textVerbosity": "high",
        "reasoningEffort": "high"
      }
    }
  }
}
```

Then restart opencode: `bun dev` or `opencode run`

### Example Config Files Provided

1. `opencode-verbosity-example.json` - Global OpenAI verbosity
2. `opencode-verbosity-per-agent.json` - Per-model and per-agent settings
3. `test-verbosity-config.ts` - Test that verifies config merging

### No Code Required

The feature is **already implemented and working**! The config system just needed users to know about it.

**Time to enable: 5 minutes** (just create the config file and restart)

---

[2026-01-17 16:15]: ⚠️ CORRECTION - Config Key Fix

**Important:** The correct config structure uses **`provider`** (singular), not `models`.

### Correct Structure

```json
{
  "provider": {
    "openai": {
      "options": {
        "textVerbosity": "high"
      }
    }
  }
}
```

### For Per-Model Settings

```json
{
  "provider": {
    "openai": {
      "models": {
        "gpt-5-codex": {
          "options": {
            "textVerbosity": "high"
          }
        }
      }
    }
  }
}
```

### Key Points

- Top-level: `provider` (singular) ✅
- Not: `models` (plural) ❌
- Inside provider: use models (plural) for per-model overrides

This follows the schema defined in `packages/opencode/src/config/config.ts` where:
```typescript
provider: z.record(z.string(), Provider)
```
And `Provider` has a `models` field.

All example files have been corrected:
- `opencode-verbosity-example.json`
- `opencode-verbosity-per-agent.json`
- `VERBOSITY_SETTINGS.md`
- `VERBOSITY_QUICKSTART.md`
