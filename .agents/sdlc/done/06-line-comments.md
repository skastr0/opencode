# Add line commenting and submit-to-prompt

## Context
The review UI's key value-add is letting users attach comments to specific diff lines, then batch-submit all comments as a chat prompt. Comments are buffered locally (no persistence needed) and formatted as a structured message when submitted.

This is the most complex work item and the one that delivers the core user value of the review UI.

## Acceptance Criteria
- [x] User can start a comment for a specific line anchor while viewing a diff (`file + stage + line`)
- [x] A text input appears (inline or as a small dialog) for entering the comment text
- [x] Comments are stored in a local signal/store as `{ file: string, stage: "staged" | "unstaged" | "untracked", line: number, text: string }[]`
- [x] If direct line click is unavailable in current `<diff>`, provide a deterministic keyboard path for selecting line anchor (no hunk-only fallback)
- [x] Commented lines/anchors are visibly indicated in the review UI
- [x] The comment count is shown in the footer (e.g., "3 comments")
- [x] User can press `S` (shift+s) to submit all comments
- [x] On submit, comments are formatted into a structured text block and injected into the chat prompt:
  ```
  Review comments on current changes:
  
  **src/foo.ts:42** - Variable naming is unclear
  **src/bar.ts:10** - This should handle the error case
  ```
- [x] Submit appends to prompt input (does not auto-send), then returns focus to normal prompt editing flow
- [x] If no comments exist when submitting, show a toast "No comments to submit"
- [x] `bun run typecheck` passes

## Technical Notes
- Store comments in a `createStore` at the Changes route level, passed down to DiffPane and Footer
- For line targeting: prefer line click if available. If not available, use explicit line selection input based on rendered line numbers; keep anchors truly line-specific.
- Format comments using a template function in `routes/changes/format-comments.ts`
- To inject into prompt, use `tui.appendPrompt` (or equivalent `initialPrompt` flow) so the text is appended and editable before sending
- For the text input, consider using a minimal inline input or reuse the dialog pattern with a text field
- Keep comment persistence in-memory only (lost on route change) — this is intentional for MVP

## Notes
2026-02-06: Created from commit plan. Dependency: WI-04 (needs diff pane). This is the highest-risk item.
2026-02-06: Orchestrator note: submit must append to prompt, not dispatch a session prompt automatically.
2026-02-06: Implemented buffered line comments with deterministic line selection dialog (`c`), anchor extraction from rendered patch hunks, and in-memory comment store in Changes route.
2026-02-06: Added review indicators in diff pane (`L<line>` markers), per-file sidebar badges (`Nc`), footer comment totals, and `Shift+S` submit flow that appends formatted comments into prompt prefill (no auto-send) before returning to home/session.
Files changed: `packages/opencode/src/cli/cmd/tui/routes/changes/index.tsx`, `packages/opencode/src/cli/cmd/tui/routes/changes/diff-pane.tsx`, `packages/opencode/src/cli/cmd/tui/routes/changes/file-list.tsx`, `packages/opencode/src/cli/cmd/tui/routes/changes/footer.tsx`, `packages/opencode/src/cli/cmd/tui/routes/changes/format-comments.ts`, `packages/opencode/test/cli/tui/changes-format-comments.test.ts`.
Validation: `bun test test/cli/tui/changes-format-comments.test.ts` passed (run in `packages/opencode`), `bun run typecheck` passed (run at repo root).
