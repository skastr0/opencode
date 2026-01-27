# OpenCode Logging System

## Overview

OpenCode uses a file-based logging system that writes logs to disk by default, not to the terminal.

## Log Locations

```bash
# All logs are stored here:
~/.local/share/opencode/log/

# When running in dev mode (bun dev):
~/.local/share/opencode/log/dev.log

# Production builds create timestamped files:
~/.local/share/opencode/log/2025-01-26T191316.log
```

You can also find your log directory programmatically:

```bash
opencode debug paths
# Look for the "log" entry
```

## Log Levels

| Level | Description |
|-------|-------------|
| DEBUG | Verbose debugging information (only enabled in local dev by default) |
| INFO | General operational messages |
| WARN | Warning conditions |
| ERROR | Error conditions |

### Default Behavior

- **Production builds**: Log level is `INFO`, logs go to timestamped files
- **Local dev builds** (`bun dev`): Log level is `DEBUG`, logs go to `dev.log`
- **Both cases**: Logs write to **files**, not terminal

## Viewing Logs

### Option 1: Print Logs to Terminal

```bash
opencode --print-logs
```

### Option 2: Increase Log Verbosity

```bash
opencode --log-level DEBUG --print-logs
```

### Option 3: Watch Log Files

```bash
# For production:
tail -f ~/.local/share/opencode/log/*.log

# For dev mode:
tail -f ~/.local/share/opencode/log/dev.log
```

### Option 4: Filter for Errors

```bash
# Find all errors across log files:
grep "^ERROR" ~/.local/share/opencode/log/*.log

# Find errors with context:
grep -B 5 "^ERROR" ~/.local/share/opencode/log/dev.log
```

## How Dev Mode Detection Works

OpenCode determines if it's running in dev mode via the `OPENCODE_CHANNEL` compile-time constant:

```typescript
// In installation/index.ts
export const CHANNEL = typeof OPENCODE_CHANNEL === "string"
  ? OPENCODE_CHANNEL
  : "local"  // Defaults to "local" when not set

export function isLocal() {
  return CHANNEL === "local"
}
```

When running `bun dev`, `OPENCODE_CHANNEL` is not defined, so it defaults to `"local"`, enabling:
- DEBUG log level by default
- Logs written to `dev.log` instead of timestamped files

## Log File Rotation

The logging system automatically cleans up old log files:
- Keeps the last 5-10 timestamped log files
- Deletes older files automatically
- `dev.log` is NOT rotated (grows indefinitely)

**Warning**: If you need to investigate an old issue, the logs may already be deleted.

## Debugging Subprocess Errors

When you see errors like "Claude Code exited with code 1", the underlying cause is often not captured because:

1. The Claude Agent SDK runs as a subprocess
2. OpenCode cannot capture that subprocess's stderr/stdout
3. Only the exit code is surfaced

### Troubleshooting Steps

1. **Check the log file for preceding errors:**
   ```bash
   grep -B 20 "exited with code" ~/.local/share/opencode/log/dev.log
   ```

2. **Look for authentication issues:**
   ```bash
   grep -i "authentication\|api.key\|unauthorized" ~/.local/share/opencode/log/*.log
   ```

3. **Check the Claude CLI directly:**
   ```bash
   which claude
   claude login
   claude "test query"
   ```

4. **Look for network issues:**
   ```bash
   grep -i "ECONNREFUSED\|ECONNRESET\|timeout" ~/.local/share/opencode/log/*.log
   ```

## Creating Logs in Code

```typescript
import { Log } from "@/util/log"

// Create a logger with a service name
const log = Log.create({ service: "my-feature" })

// Log at different levels
log.debug("Detailed info", { data: someData })
log.info("Operation completed", { result })
log.warn("Something concerning", { issue })
log.error("Something failed", { error, stack: error.stack })
```

## Known Issues

1. **Logs default to files**: Must use `--print-logs` to see in terminal
2. **Silent error swallowing**: Many `.catch(() => {})` hide errors
3. **Subprocess stderr not captured**: Claude SDK errors are opaque
4. **Aggressive rotation**: Old logs may be deleted before investigation
5. **No structured error codes**: Errors are string-matched, not typed

See `.agents/sdlc/backlog/` for work items addressing these issues.
