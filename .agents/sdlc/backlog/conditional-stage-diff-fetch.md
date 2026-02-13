# Conditionally fetch only requested stage diff in File.read()

## Context
Review finding from git-review-ui work stream. `File.read()` fetches both staged and unstaged diffs regardless of the `stage` parameter, then selects one. This wastes a subprocess call on every request.

## Acceptance Criteria
- [ ] When `stage=staged`, only `git diff --cached` is executed
- [ ] When `stage=unstaged`, only `git diff` is executed
- [ ] When no stage specified, existing fallback behavior preserved
- [ ] `bun run typecheck` passes

## Notes
2026-02-06: Created from git-review-ui learn retrospective. Source: review-findings code review.
