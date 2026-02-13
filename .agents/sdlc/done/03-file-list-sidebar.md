# Build the file list sidebar for the Changes route

## Context
The Changes route needs a left sidebar tree/list showing changed files grouped by directory and stage (staged / unstaged / untracked). The existing session sidebar in `routes/session/sidebar.tsx` already renders modified files with +/- counts; this work expands that pattern into a primary navigator.

This work item builds a `FileList` component inside `routes/changes/` that fetches file status from the SDK, groups files by stage, and allows keyboard/mouse selection to pick which file's diff to show.

## Acceptance Criteria
- [x] `FileList` component created at `packages/opencode/src/cli/cmd/tui/routes/changes/file-list.tsx`
- [x] Component calls `sdk.client.file.status()` to fetch file data on mount (and provides a refresh mechanism)
- [x] Files are grouped by section headers: "Staged", "Unstaged", "Untracked"
- [x] Within each stage section, files are displayed in directory-grouped tree/list form (directory headers + child files)
- [x] Each file row shows: relative file path (truncated if needed), `+N` in green, `-N` in red
- [x] Arrow keys (up/down) navigate between files; Enter or click selects a file
- [x] The currently selected file is visually highlighted (background color change)
- [x] Empty state: when no files are changed, show "No changes" message
- [x] The `Changes` index component integrates `FileList` in a left panel (fixed width ~35-40 chars)
- [x] Selected file ID/path is lifted to parent via a signal/callback so the diff pane can react
- [x] If a file exists in both staged and unstaged sets, both entries are visible and distinguishable in the sidebar
- [x] `bun run typecheck` passes

## Technical Notes
- Use `useSDK()` to access `sdk.client.file.status()` — the SDK should have the updated schema from WI-01
- If WI-01 isn't complete yet, gracefully handle missing `stage` field by treating all files as "unstaged"
- Use `createResource` or `createSignal` + `onMount` for the fetch
- For keyboard nav, use `useKeyboard()` and track `selectedIndex` as a signal
- Layout: the Changes component should be `flexDirection="row"` with FileList on the left and a diff pane on the right
- Reference the sidebar patterns in `routes/session/sidebar.tsx` for styling (theme colors, text truncation)
- Use `scrollbox` for the file list if it exceeds available height

## Notes
2026-02-06: Created from commit plan. Dependency: WI-01 (soft — works without stage field, better with it). WI-02 (hard — needs the route).
2026-02-06: Orchestrator note: directory grouping is in-scope (user requested tree view), not deferred.
2026-02-06: Implemented `FileList` with stage sections, directory grouping, +/- counters, keyboard/mouse selection, and refresh affordance. Added parent selection wiring in `routes/changes/index.tsx`.
2026-02-06: Validation: `bun run typecheck` (from `packages/opencode`) passed.
2026-02-06: Files changed: `packages/opencode/src/cli/cmd/tui/routes/changes/file-list.tsx`, `packages/opencode/src/cli/cmd/tui/routes/changes/index.tsx`.
