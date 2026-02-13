# Make Log Retention Configurable

## Context

The logging system aggressively deletes old log files, keeping only 5-10 files. This means by the time a user reports an issue, the relevant logs are often already deleted.

Current behavior (log.ts lines 76-88):
```typescript
async function cleanup(dir: string) {
  const glob = new Bun.Glob("????-??-??T??????.log")
  const files = await Array.fromAsync(glob.scan({ cwd: dir, absolute: true }))
  if (files.length <= 5) return

  const filesToDelete = files.slice(0, -10)  // Keep last 10
  await Promise.all(filesToDelete.map((file) => fs.unlink(file).catch(() => {})))
}
```

## Acceptance Criteria

- [ ] Add config option: `logging.retentionDays` (default: 7)
- [ ] Add config option: `logging.maxFiles` (default: 20)
- [ ] Add config option: `logging.maxSizeMB` (default: 100)
- [ ] Rotation should consider age AND count AND size
- [ ] Document the new config options
- [ ] Consider adding `opencode logs` command to view/manage logs

## Technical Notes

Config would go in `opencode.json`:
```json
{
  "logging": {
    "retentionDays": 14,
    "maxFiles": 50,
    "maxSizeMB": 200
  }
}
```

Files to modify:
- `packages/opencode/src/util/log.ts` - Cleanup logic
- `packages/opencode/src/config/config.ts` - Add schema
- `packages/opencode/docs/LOGGING.md` - Document options

## Notes

2026-01-26: Low priority but would help with debugging historical issues.
