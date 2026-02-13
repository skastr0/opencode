# Investigate Fork/Dev Mode Detection Issues

## Context

When running opencode via a fork with `bun dev`, the detection of "local" mode may not work correctly. The user reported issues even when running from a local build.

Current detection (installation/index.ts):
```typescript
export const CHANNEL = typeof OPENCODE_CHANNEL === "string"
  ? OPENCODE_CHANNEL
  : "local"  // Defaults to "local" when not set

export function isLocal() {
  return CHANNEL === "local"
}
```

When running `bun dev`, `OPENCODE_CHANNEL` is not defined via build-time constants, so it SHOULD default to "local". But there may be edge cases where this fails.

## Acceptance Criteria

- [ ] Verify `Installation.isLocal()` returns true during `bun dev`
- [ ] Add debug logging at startup to show detected mode
- [ ] Consider adding explicit `--dev` flag as override
- [ ] Document the detection logic in LOGGING.md
- [ ] Add startup banner showing: version, channel, log location

## Technical Notes

Add to startup in `src/index.ts`:
```typescript
if (Installation.isLocal()) {
  console.error(`[dev mode] Logs: ${Log.file()}`)
  console.error(`[dev mode] Channel: ${Installation.CHANNEL}`)
}
```

This would immediately tell users:
1. They're in dev mode
2. Where logs are going

Key files:
- `packages/opencode/src/installation/index.ts`
- `packages/opencode/src/index.ts`
- `packages/opencode/src/util/log.ts`

Test the detection:
```bash
cd packages/opencode
bun run --conditions=browser -e "
  import { Installation } from './src/installation/index.ts'
  console.log('isLocal:', Installation.isLocal())
  console.log('CHANNEL:', Installation.CHANNEL)
"
```

## Notes

2026-01-26: User running fork via `bun dev` still can't debug easily. Need to verify dev detection works and make it more visible.
