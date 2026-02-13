# Manual runtime verification: keyboard, comment reset, duplicate submit

## Context
Part of the /changes sidebar enhancement (changes-sidebar-collapsible-filter.md). This is the final work item — a manual verification pass that validates all acceptance criteria from the parent work item, with special attention to keyboard behavior, comment reset correctness, and duplicate-submit prevention.

This item does NOT produce code. It produces a verified checklist confirming runtime behavior.

## Acceptance Criteria
- [ ] **Navigation**: up/down/j/k navigate through file rows, skipping collapsed directory children
- [ ] **Dir toggle**: space on a directory row toggles collapse; ▶/▼ indicator updates
- [ ] **Selection stability**: collapsing the directory containing the selected file remaps selection to nearest visible file; DiffPane updates
- [ ] **Filter activation**: '/' opens the inline filter input; cursor is in the input
- [ ] **Filter typing**: typing filters the file list by fuzzy path match; directory headers of matching files remain visible
- [ ] **Filter escape**: Escape clears the filter and returns to normal navigation mode
- [ ] **Hotkey isolation**: while filter is focused, j/k/r do NOT trigger file-list actions (navigate or refresh)
- [ ] **Comment hotkey**: 'c' opens the comment prompt when filter is NOT focused and dialog stack is empty
- [ ] **Submit flow**: Shift+S submits comments; `setComments(() => [])` clears the store before navigation
- [ ] **Comment reset**: after submit → navigate to session → navigate back to /changes, the comments list is empty (no stale comments)
- [ ] **Duplicate submit prevention**: pressing Shift+S twice rapidly shows "No comments to submit" toast on second press (comments.length === 0 guard)
- [ ] **Filter + collapse combined**: filtering while some dirs are collapsed shows all matching files (collapse bypassed); clearing filter restores collapse state
- [ ] **Refetch after collapse**: pressing 'r' to refresh preserves collapse state for dirs that still exist; new dirs appear expanded
- [ ] **Mouse interaction**: clicking a file row selects it; clicking a directory header toggles collapse
- [ ] **Empty state**: when filter matches nothing, "No changes" or appropriate empty text is shown
- [x] **Typecheck**: `bun run typecheck` passes with zero errors

## Technical Notes

### How to run
1. Make file changes in a git repo (stage some, leave some unstaged, add an untracked file)
2. Launch `bun run --conditions=browser ./src/index.ts`
3. Navigate to /changes
4. Walk through each criterion above, checking the box

### Comment reset verification (AC-7)
1. Select a file, press 'c', add a comment with line number and text
2. Press Shift+S to submit
3. Confirm navigation to home/session
4. Navigate back to /changes
5. Verify: no comments badge, no comments in the diff pane, footer shows "0 comments"

### Duplicate submit verification
1. Add a comment
2. Press Shift+S
3. Immediately press Shift+S again (before navigation completes)
4. Verify: toast "No comments to submit" appears, no double navigation

## Notes
2026-02-06: Created from commit plan. Depends on all three prior work items (01, 02, 03).

2026-02-06: Verification pass (partial, environment-limited).

- Automated checks run:
  - `bun run typecheck` (repo root): PASS
  - `bun run typecheck` (`packages/opencode`): PASS
  - `bun test test/cli/tui/changes-format-comments.test.ts` (`packages/opencode`): PASS (3 tests)
  - `bun run lint` (`packages/opencode`): NOT PASS in this environment (timeouts + unrelated failing tests, including `test/normalization.test.ts`, `test/memory/abort-leak.test.ts`, `test/provider/amazon-bedrock.test.ts`, `test/tool/registry.test.ts`)

- Runtime verification attempt for `/changes`:
  - Attempted scripted TUI interaction via pseudo-TTY (`expect`) and transcript capture.
  - TUI launched, but deterministic keyboard/mouse interaction could not be reliably established in this non-interactive automation environment.
  - Could not complete full runtime checklist verification (navigation/filter/collapse/mouse flows).

- Specific `setComments(() => [])` path evidence (code-path verification):
  - `packages/opencode/src/cli/cmd/tui/routes/changes/index.tsx` contains:
    - guard: `if (comments.length === 0) toast.show({ variant: "warning", message: "No comments to submit" })`
    - reset before navigation: `setComments(() => [])` immediately before `navigate(...)`
  - This supports intended comment-reset and duplicate-submit guard behavior, but full runtime confirmation remains pending manual TUI execution.

## Blockers
- 2026-02-06: Full manual runtime verification requires direct interactive TUI control (live keyboard + mouse in a real terminal). Current environment supports process launch but not reliable end-to-end manual interaction for all acceptance criteria.
