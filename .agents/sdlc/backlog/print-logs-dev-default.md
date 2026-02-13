# Print Logs to Terminal by Default in Dev Mode

## Context

When running `bun dev`, logs go to `~/.local/share/opencode/log/dev.log` but users expect to see errors in their terminal. This makes debugging frustrating because errors are silently written to a file nobody is watching.

The `--print-logs` flag exists but must be explicitly passed.

## Acceptance Criteria

- [ ] When `Installation.isLocal()` is true, logs should print to stderr by default
- [ ] The `dev.log` file should still be written (dual output)
- [ ] Add `--no-print-logs` flag to disable terminal output if needed
- [ ] Update `bun dev` script or index.ts to enable this behavior

## Technical Notes

Key files:
- `packages/opencode/src/util/log.ts` - Log initialization
- `packages/opencode/src/index.ts` - Entry point where log options are set

Current behavior (log.ts lines 53-56):
```typescript
let write = (msg: any) => {
  process.stderr.write(msg)
  return msg.length
}
```

But this is only used when `options.print` is true. Need to make it the default when `dev: true`.

## Notes

2026-01-26: Created from logging system review. Low-hanging fruit with high impact on DX.
