# Strip control characters from comment text before prompt injection

## Context
Review finding from git-review-ui work stream. Comment text from the line-commenting dialog is inserted into the prompt without stripping ANSI escape sequences or control characters.

## Acceptance Criteria
- [ ] `format-comments.ts` strips ANSI escape sequences and control characters from comment text
- [ ] Unit test added for control character stripping
- [ ] `bun run typecheck` passes

## Notes
2026-02-06: Created from git-review-ui learn retrospective. Source: review-findings security review.
