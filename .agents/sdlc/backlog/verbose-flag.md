# Add --verbose/-v Flag for Progressive Verbosity

## Context

Currently logging is all-or-nothing:
- `--log-level DEBUG` shows everything
- `--log-level INFO` hides all debug info

Users need a middle ground: more info than INFO but not the firehose of DEBUG.

## Acceptance Criteria

- [ ] Add `-v` flag (can be stacked: `-v`, `-vv`, `-vvv`)
- [ ] Verbosity levels:
  - No flag: INFO level, errors only to terminal
  - `-v`: INFO + show which tools are running, timing
  - `-vv`: DEBUG level, but filtered to actionable info
  - `-vvv`: Full DEBUG (same as `--log-level DEBUG --print-logs`)
- [ ] Each `-v` adds more categories of info
- [ ] Document what each verbosity level shows

## Technical Notes

Implementation approach:
```typescript
// Parse -v flags
const verbosity = args.v ? (Array.isArray(args.v) ? args.v.length : 1) : 0

// Map to log behavior
const logConfig = {
  0: { level: "INFO", print: false },
  1: { level: "INFO", print: true, categories: ["tools", "timing"] },
  2: { level: "DEBUG", print: true, categories: ["tools", "timing", "provider"] },
  3: { level: "DEBUG", print: true, categories: ["all"] },
}
```

This requires categorizing log messages. Could use the `service` field:
```typescript
log.info("running", { tool: "bash" })  // service: "tools"
```

## Notes

2026-01-26: Nice-to-have. Improves UX for power users without overwhelming newcomers.
