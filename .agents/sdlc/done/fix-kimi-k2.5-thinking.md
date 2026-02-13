# Fix kimi-k2.5 thinking option error

## Context
When using `opencode/kimi-k2.5` model with the "thinking" option enabled, users get an error. The issue is that:

1. `opencode/kimi-k2.5` comes from live models.dev data with `reasoning: true`
2. When `capabilities.reasoning = true`, the `variants()` function generates reasoning variants
3. For `@ai-sdk/openai-compatible` (opencode's provider), variants map to `reasoningEffort` (OpenAI-style)
4. But kimi models don't use `reasoningEffort` - they use `chat_template_args.enable_thinking`
5. The `options()` function only adds `chat_template_args.enable_thinking` for `kimi-k2-thinking`, not `kimi-k2.5`

This mismatch causes the error when thinking is enabled for k2.5.

## Acceptance Criteria
- [x] `opencode/kimi-k2.5` should not generate `reasoningEffort` variants (it's not an OpenAI-style reasoning model)
- [x] `opencode/kimi-k2.5` should use `chat_template_args.enable_thinking` when thinking is enabled
- [x] The fix should be consistent with how `kimi-k2-thinking` is handled

## Notes
- File modified: `packages/opencode/src/provider/transform.ts`
- Line 322: Added `|| id.includes("kimi")` to exclude kimi models from `reasoningEffort` variants
- Line 560: Added `"kimi-k2.5"` to the list of models that get `chat_template_args.enable_thinking`

## Changes Made
1. **transform.ts:322** - Added `kimi` to the exclusion list in `variants()` function so kimi models don't get OpenAI-style `reasoningEffort` variants
2. **transform.ts:560** - Added `kimi-k2.5` to the `options()` function so it receives `chat_template_args.enable_thinking` when thinking is enabled

## Result
The `opencode/kimi-k2.5` model will now properly use the kimi-specific `chat_template_args.enable_thinking` mechanism instead of the incompatible `reasoningEffort` option.
