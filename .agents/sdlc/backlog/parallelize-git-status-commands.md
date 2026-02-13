# Parallelize sequential git commands in File.status()

## Context
Review finding from git-review-ui work stream. `File.status()` in `packages/opencode/src/file/index.ts` runs 5 independent git commands sequentially. These can be parallelized with `Promise.all()` for latency improvement.

## Acceptance Criteria
- [ ] `git diff --cached --numstat`, `git diff --numstat`, `git ls-files --others`, `git diff --name-only --diff-filter=D --cached`, and `git diff --name-only --diff-filter=D` run in parallel
- [ ] Result aggregation logic unchanged
- [ ] `bun run typecheck` passes
- [ ] Existing behavior preserved (same output, just faster)

## Notes
2026-02-06: Created from git-review-ui learn retrospective. Source: review-findings code review.
