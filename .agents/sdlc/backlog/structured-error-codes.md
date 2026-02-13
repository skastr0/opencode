# Add Structured Error Codes

## Context

Currently, error handling relies on string matching and instance checks:

```typescript
// cli/error.ts
if (ClaudeAgentSDK.AuthError.isInstance(input)) {...}
if (ClaudeAgentSDK.RateLimitError.isInstance(input)) {...}
// etc.
```

This is fragile and makes programmatic error handling difficult. Users and monitoring systems can't easily categorize errors.

## Acceptance Criteria

- [ ] Define error code enum: `ErrorCode.AUTH_FAILED`, `ErrorCode.RATE_LIMITED`, etc.
- [ ] Add `code` property to all custom errors
- [ ] Include error code in log output
- [ ] Include error code in user-facing error messages
- [ ] Document all error codes and their meanings
- [ ] Add `--json` output mode that includes structured error info

## Technical Notes

Example structure:
```typescript
// util/error.ts
export enum ErrorCode {
  // Auth (1xxx)
  AUTH_REQUIRED = 1001,
  AUTH_EXPIRED = 1002,
  AUTH_INVALID = 1003,

  // Network (2xxx)
  NETWORK_TIMEOUT = 2001,
  NETWORK_UNREACHABLE = 2002,

  // Provider (3xxx)
  RATE_LIMITED = 3001,
  QUOTA_EXCEEDED = 3002,
  MODEL_NOT_FOUND = 3003,

  // SDK (4xxx)
  SDK_CRASH = 4001,
  SDK_SUBPROCESS_FAILED = 4002,

  // Config (5xxx)
  CONFIG_INVALID = 5001,
  CONFIG_NOT_FOUND = 5002,
}

export class OpenCodeError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public cause?: Error
  ) {
    super(message)
  }
}
```

## Notes

2026-01-26: Medium priority. Would significantly improve debugging and monitoring.
