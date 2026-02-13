# Extract file-list directory grouping to pure transformer function

## Context
Review finding from git-review-ui work stream. The `FileList` component contains directory-tree transformation logic inside a `createMemo`. Extracting it to a pure function improves testability and separates representation from rendering.

## Acceptance Criteria
- [ ] Directory grouping logic extracted to a pure function (e.g., `group-files.ts`)
- [ ] Unit tests for grouping edge cases (empty, single file, nested dirs, mixed stages)
- [ ] `FileList` component calls the extracted function
- [ ] `bun run typecheck` passes

## Notes
2026-02-06: Created from git-review-ui learn retrospective. Source: review-findings simplicity review.
