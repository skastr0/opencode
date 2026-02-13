# Update ChangesFooter with collapse and filter hotkey hints

## Context
Part of the /changes sidebar enhancement (changes-sidebar-collapsible-filter.md). Small follow-up to 01-collapsible-directory-nodes.md that updates the footer bar to document the new hotkeys. Can be built in parallel with 02-fuzzy-filter-input.md.

## Acceptance Criteria
- [x] Footer shows `/ filter` hint text (always visible, matching the muted text style of existing hints)
- [x] Footer shows `space toggle` hint when a directory row is currently highlighted (requires a new prop or signal)
- [x] Existing hints (`esc close`, `↑↓ navigate`, `c comment`, `S submit`) are preserved unchanged
- [x] `bun run typecheck` passes

## Technical Notes

### Props change
Add optional `dirSelected?: boolean` prop to `ChangesFooter`. The parent `Changes` component passes this based on whether FileList's current highlighted row is a directory-type row. Alternatively, `FileList` can expose this via a new callback prop.

Simplest path: add `onDirHighlight?: (isDir: boolean) => void` to FileList props, wire to a signal in Changes, pass to footer.

### Footer rendering
Insert between existing hints:
```tsx
<text fg={theme.textMuted}>/ filter</text>
<Show when={props.dirSelected}>
  <text fg={theme.textMuted}>space toggle</text>
</Show>
```

### File: `packages/opencode/src/cli/cmd/tui/routes/changes/footer.tsx`
Currently 38 lines. Change is ~10 lines added.

### File: `packages/opencode/src/cli/cmd/tui/routes/changes/index.tsx`
Wire the new `dirSelected` signal between FileList callback and Footer prop.

## Notes
2026-02-06: Created from commit plan. Depends on 01-collapsible-directory-nodes.md for the directory row concept.
2026-02-06: Implemented. Added `onDirHighlight` callback to FileList, wired through `dirSelected` signal in Changes, passed to footer. Footer renders `/ filter` (always) and `space toggle` (conditional on dir row highlight). All existing hints preserved. Typecheck clean.
Files changed: footer.tsx, file-list.tsx, index.tsx.
2026-02-06: **Review PASS.** No issues found. Clean implementation.
