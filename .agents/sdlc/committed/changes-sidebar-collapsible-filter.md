# Enhance /changes sidebar navigation with collapsible tree and fuzzy filter

id: enhance-changes-sidebar-navigation

## Context
The `/changes` review UI is implemented and working end-to-end, but the sidebar still uses flat directory headers rather than true collapsible directory nodes, and there is no fuzzy filename filter for quickly narrowing large change sets.

This work explores and then implements a sidebar enhancement that keeps stage grouping (`staged`, `unstaged`, `untracked`) while adding high-signal navigation controls.

## Acceptance Criteria
- [ ] AC-1: Sidebar renders true collapsible directory nodes (expand/collapse) under each stage section.
- [ ] AC-2: Collapse state is stable during list navigation and refreshes unless the underlying tree path disappears.
- [ ] AC-3: Sidebar includes a fuzzy filename filter input that matches filename/path substrings with tolerant ordering.
- [ ] AC-4: Filtering preserves stage grouping and directory context (parents remain visible when descendants match).
- [ ] AC-5: Keyboard navigation (`up/down`, selection) works correctly with collapsed and filtered views.
- [ ] AC-6: Existing click selection and diff auto-show behavior continue to work with no regressions.
- [ ] AC-7: Comment-reset behavior is verified manually: reopening `/changes` after submit does not re-submit prior comments.
- [ ] AC-8: `bun run typecheck` passes.

## Technical Notes
- Primary implementation target is `packages/opencode/src/cli/cmd/tui/routes/changes/file-list.tsx` with parent integration in `routes/changes/index.tsx` if needed.
- Keep hotkey isolation behavior for active modals/search input.
- Maintain compatibility with duplicate file entries across stages.

## Notes
2026-02-06: Created in exploring phase to evaluate implementation options and risk before commitment.
2026-02-06: Committed to Option 1 (single-file row-model refactor). Plan and 4 work items generated: 01-collapsible-directory-nodes, 02-fuzzy-filter-input, 03-footer-hints-update, 04-runtime-verification-checklist. Total estimated effort: ~4 hours.
