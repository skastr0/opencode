# Replace Silent .catch(() => {}) with Logged Errors

## Context

Throughout the codebase, errors are silently swallowed with `.catch(() => {})` or `.catch(() => [])`. This makes debugging impossible because failures produce no trace.

Examples found:
```typescript
// session/system.ts
return Filesystem.globUp(instruction, Instance.directory, Instance.worktree).catch(() => [])

// session/summary.ts
return Storage.read<Snapshot.FileDiff[]>(["session_diff", input.sessionID]).catch(() => [])

// session/index.ts
await unshare(sessionID).catch(() => {})
```

## Acceptance Criteria

- [ ] Audit all `.catch(() => {})` and `.catch(() => [])` patterns
- [ ] Replace with `.catch((e) => { log.debug("contextual message", { error: e }); return fallback })`
- [ ] Keep the same return value behavior (empty array, undefined, etc.)
- [ ] Use DEBUG level so it doesn't spam production, but leaves a trace
- [ ] Create helper: `catchAndLog(fallback, context)` for consistent pattern

## Technical Notes

Search pattern to find all instances:
```bash
grep -r "\.catch\s*(\s*(\(\s*\)|_\s*=>|e\s*=>)\s*{?\s*}\s*)" packages/opencode/src/
```

Proposed helper in `@/util/error.ts`:
```typescript
export function catchAndLog<T>(fallback: T, context: string) {
  return (error: unknown) => {
    log.debug(context, { error })
    return fallback
  }
}

// Usage:
.catch(catchAndLog([], "failed to glob files"))
```

## Notes

2026-01-26: This is a significant audit task. Consider doing incrementally per-module.
