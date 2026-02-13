# Build the diff viewing pane for the selected file

## Context
When a user selects a file in the sidebar, the right pane needs to show the file's diff. The TUI already has a `<diff>` opentui element used extensively in `routes/session/index.tsx` (lines 1973-1991, 2031-2049) with split/unified view support, syntax highlighting, and themed colors. This work item reuses that exact pattern to render diffs for the selected file.

The diff content needs to be fetched — either via the existing `sdk.client.file.read()` endpoint (which returns `patch` and `diff` fields for files with git changes) or by calling a git diff command on the server. The existing `File.read()` already generates diffs using the `diff` npm package.

## Acceptance Criteria
- [x] `DiffPane` component created at `packages/opencode/src/cli/cmd/tui/routes/changes/diff-pane.tsx`
- [x] When a file is selected in the FileList, DiffPane fetches and renders its diff
- [x] Uses the existing `<diff>` opentui element with proper theme colors (matching session route's diff rendering)
- [x] View mode is auto-detected: split when width > 120, unified otherwise (matching existing `diff_style` logic)
- [x] Respects the user's `diff_style` config from `sync.data.config.tui?.diff_style`
- [x] Shows file path as a header above the diff
- [x] Stage selection is available when relevant (`staged` / `unstaged`), and selected stage controls fetched diff content
- [x] Handles "added" files (no old content — full green diff)
- [x] Handles "deleted" files (full red diff)
- [x] Handles binary files (shows "Binary file" message instead of diff)
- [x] Diff pane is scrollable via `scrollbox` for large diffs
- [x] Empty state when no file is selected: "Select a file to view changes"
- [x] `bun run typecheck` passes

## Technical Notes
- Fetch diff via `sdk.client.file.read({ path: selectedFile })` — this returns `Content` with `diff` and `patch` fields
- Add support for stage-aware diff fetch. Preferred path: extend `/file/content` with optional `stage` query (`staged | unstaged`) and use `git diff --cached <file>` when `stage=staged`.
- Copy the diff rendering pattern from `routes/session/index.tsx` Edit component (lines 1973-1991):
  ```tsx
  <diff diff={...} view={view()} filetype={ft()} syntaxStyle={syntax()} ... />
  ```
- Use `createMemo` for view mode, matching the pattern at line 1930-1933
- Use `filetype()` helper from existing code for syntax detection
- Wrap in `<scrollbox>` with keyboard scroll support

## Notes
2026-02-06: Created from commit plan. Dependency: WI-02, WI-03 (needs route + file selection signal).
2026-02-06: Orchestrator note: stage-aware diff selection is required for feature completeness.
2026-02-06: Implemented `DiffPane` and wired it into `routes/changes/index.tsx` so selecting a file renders themed diffs with adaptive split/unified mode and scroll support.
2026-02-06: Added stage-aware selection in diff pane by detecting staged/unstaged availability per file and passing optional `stage` to `sdk.client.file.read()`.
2026-02-06: Extended `/file/content` query with optional `stage` and updated `File.read(file, stage?)` to return accurate staged/unstaged git diff output, including untracked fallback diff generation.
2026-02-06: Regenerated SDK via `./packages/sdk/js/script/build.ts` due `/file/content` query schema change and ran `bun run typecheck` successfully.
2026-02-06: Files changed: `packages/opencode/src/cli/cmd/tui/routes/changes/diff-pane.tsx`, `packages/opencode/src/cli/cmd/tui/routes/changes/index.tsx`, `packages/opencode/src/cli/cmd/tui/routes/changes/file-list.tsx`, `packages/opencode/src/server/routes/file.ts`, `packages/opencode/src/file/index.ts`, `packages/sdk/js/src/v2/gen/sdk.gen.ts`, `packages/sdk/js/src/v2/gen/types.gen.ts`, `packages/sdk/openapi.json`.
