# Add missing test cases for format-comments lineAnchors

## Context
Review finding from git-review-ui work stream. The `changes-format-comments.test.ts` file is missing a test case for `lineAnchors` with `status='added'` files.

## Acceptance Criteria
- [ ] Test case added for `lineAnchors` extraction from added-file hunks
- [ ] Test case added for `lineAnchors` with deleted-file hunks
- [ ] All tests pass: `bun test test/cli/tui/changes-format-comments.test.ts`

## Notes
2026-02-06: Created from git-review-ui learn retrospective. Source: review-findings testing.
