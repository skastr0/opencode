# Add fuzzy filename filter with keyboard isolation

## Context
Part of the /changes sidebar enhancement (changes-sidebar-collapsible-filter.md). Depends on 01-collapsible-directory-nodes.md being complete because the filter operates on the same `visibleRows` pipeline — when filter is active, collapse state is bypassed.

This work item adds an inline `<input>` for fuzzy file path matching using the existing `fuzzysort` dependency (v3.1.0, already in package.json). The critical challenge is keyboard isolation: while the filter input is focused, file-list navigation hotkeys (j/k/up/down/r) must be suppressed, but route-level hotkeys (S, Esc) must continue working.

## Acceptance Criteria
- [x] `'/'` hotkey activates an inline filter `<input>` at the top of the file list (below the "Files" / "Refresh" header)
- [x] Typing in the filter input scores files by `path` using `fuzzysort.go()` and hides non-matching files
- [x] Parent directory headers remain visible when any descendant file matches the filter
- [x] When filter is active (non-empty), collapse state is ignored — all matching files are visible regardless of collapse
- [x] Escape in filter mode: clears filter text, exits editing mode, returns focus to list navigation
- [x] While filter input is focused, `j`/`k`/`r`/`up`/`down` hotkeys are suppressed in the file-list `useKeyboard` handler
- [x] Route-level hotkeys (`S` submit, `Esc` close) still function when filter is NOT focused (existing `dialog.stack` guard suffices)
- [x] When filter is cleared, previous selection is restored if the file still exists in the list
- [x] `bun run typecheck` passes

## Technical Notes

### Filter state
Add `const [filter, setFilter] = createSignal("")` and `const [editing, setEditing] = createSignal(false)`.

### fuzzysort integration
Reference: `dialog-select.tsx:85` for existing pattern.
```
const filtered = createMemo(() => {
  const needle = filter()
  if (!needle) return files()  // all files from status()
  return fuzzysort.go(needle, files(), { key: "path" }).map(r => r.obj)
})
```
Feed `filtered()` into the existing `groups()` memo instead of the raw `status()` list.

### Collapse bypass
In `visibleRows` computation: `if (filter().length > 0) → emit all files from groups, skip collapse check`.

### Keyboard isolation
At the top of the file-list `useKeyboard`:
```
if (editing()) {
  if (evt.name === "escape") { setEditing(false); setFilter(""); }
  return  // suppress all other keys
}
```
Add `'/'` key handler: `setEditing(true)` and focus the input ref.

### Input element
Use `<input>` with `ref` like `dialog-select.tsx:242`. Show conditionally with `<Show when={editing()}>`. On blur, exit editing mode.

### Selection restoration
Before setting filter, snapshot `selected()?.id`. When filter clears, attempt to find that id in new visibleRows and restore index.

### Prior art
- `dialog-select.tsx` — full fuzzysort + input + keyboard pattern
- `autocomplete.tsx` — fuzzysort with debounced search signal

## Notes
2026-02-06: Created from commit plan. Depends on 01-collapsible-directory-nodes.md.
2026-02-06: Implemented. Single file changed: `file-list.tsx`. Added `fuzzysort` import, `filter`/`editing` signals, `filtered` memo feeding into `groups`, collapse bypass when filtering, keyboard isolation (`editing()` early-return suppresses j/k/r/up/down), `/` hotkey with selection snapshot, `<input>` element with ref+focus, and selection restoration effect. Typecheck passes (0 new errors).
2026-02-06: **Review PASS with suggestions.** Minor: add isDestroyed guard to setTimeout in keyboard handler (line 358). See review-findings.json.
