# Add size cap before reading untracked files for line counting

## Context
Review finding from git-review-ui work stream. `File.status()` reads full untracked file content via `Bun.file().text()` to count lines. No size limit means a multi-GB untracked file could cause unbounded memory usage.

## Acceptance Criteria
- [ ] Files above a configurable size threshold (e.g., 1MB) report `additions: 0` or `additions: -1` instead of reading content
- [ ] Binary files detected and skipped
- [ ] `bun run typecheck` passes

## Notes
2026-02-06: Created from git-review-ui learn retrospective. Source: review-findings code + security review.
