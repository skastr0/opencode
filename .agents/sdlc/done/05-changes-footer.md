# Add footer with keybind hints and summary stats

## Context
The Changes route needs a footer bar showing summary stats (N files changed, +X/-Y total) and keybind hints (Escape to close, Enter to select, c to comment, S to submit). The existing session `Footer` component in `routes/session/footer.tsx` provides a pattern reference for the layout.

## Acceptance Criteria
- [x] `ChangesFooter` component created at `packages/opencode/src/cli/cmd/tui/routes/changes/footer.tsx`
- [x] Shows summary: "N files changed" with total additions/deletions
- [x] Shows keybind hints: `esc` close, `↑↓` navigate, `enter` select, `c` comment (if commenting is implemented), `S` submit
- [x] Integrated into the Changes route layout at the bottom
- [x] Updates reactively as file list data changes
- [x] Shows buffered comment count and submit enabled/disabled state
- [x] `bun run typecheck` passes

## Technical Notes
- Simple `<box flexDirection="row" justifyContent="space-between">` layout matching `routes/session/footer.tsx`
- Receive file data via props or context from parent
- Use `theme.textMuted` for hints, `theme.text` for values
- Keybind hints can be static text for now (no dynamic keybind resolution needed)

## Notes
2026-02-06: Created from commit plan. Dependency: WI-03 (needs file list data).
2026-02-06: Implemented `ChangesFooter` and wired it into the bottom of the Changes layout.
Files changed: `packages/opencode/src/cli/cmd/tui/routes/changes/footer.tsx`, `packages/opencode/src/cli/cmd/tui/routes/changes/index.tsx`, `packages/opencode/src/cli/cmd/tui/routes/changes/file-list.tsx`.
Validation: `bun run typecheck` passed.
