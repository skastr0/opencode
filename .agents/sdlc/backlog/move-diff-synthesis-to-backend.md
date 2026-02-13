# Move diff synthesis from diff-pane.tsx to File.read() backend

## Context
Review finding from git-review-ui work stream. The `DiffPane` component contains `makeDiff()` logic that synthesizes unified diff patches client-side for added/untracked files. This is a what/how braid — the UI should receive diffs from the backend, not generate them.

## Acceptance Criteria
- [ ] `File.read()` returns valid diff/patch for added and untracked files (no client-side fallback needed)
- [ ] `diff-pane.tsx` is a pure renderer — no diff synthesis logic
- [ ] `bun run typecheck` passes
- [ ] Existing diff rendering unchanged visually

## Notes
2026-02-06: Created from git-review-ui learn retrospective. Source: review-findings simplicity review.
