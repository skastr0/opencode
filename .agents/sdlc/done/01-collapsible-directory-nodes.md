# Add collapsible directory nodes to FileList with stable selection

## Context
Part of the /changes sidebar enhancement (changes-sidebar-collapsible-filter.md). This is the foundational work item that introduces the collapsible tree model. All subsequent items (filter, footer, verification) build on the row-model changes made here.

The current FileList renders flat directory headers with all children always visible. This work item adds expand/collapse state per directory within each stage section, rewires the selection model to operate over a derived `visibleRows` memo, and preserves the existing `FileSelection` contract with parent `Changes` route.

## Acceptance Criteria
- [x] Directory header rows render ▶ (collapsed) / ▼ (expanded) toggle indicators and are clickable to toggle
- [x] Space key on a directory-header row toggles its collapsed state
- [x] Collapsing a directory hides its child file rows from the derived `visibleRows`
- [x] Selection remaps to nearest visible file when current selection is hidden by a collapse action
- [x] Collapse state survives keyboard navigation and `refetch()`; keys are pruned when paths disappear after refresh
- [x] Stage grouping (staged/unstaged/untracked) is preserved — collapse is per-directory *within* each stage
- [x] `onSelect` payload shape (`FileSelection`) is unchanged — only file-leaf rows are selectable
- [x] `bun run typecheck` passes

## Technical Notes

### Row model
Introduce a discriminated union for visible rows:
- `{ type: "dir", stage, name, collapsed, fileCount }` — rendered as toggle header
- `{ type: "file", item: Item }` — rendered as current file row

The `visibleRows` memo iterates `groups()`, emitting dir rows followed by file rows only if `!collapsed`. Keyboard index and `positions` map operate over `visibleRows`.

### Collapse state
Use a `createSignal<Map<string, boolean>>` keyed by `"stage:dirName"`. Default all dirs to expanded. On `refetch()`, prune keys not in current tree. The session sidebar pattern (`createStore({ mcp: true, diff: true })`) is a reference, but a Map is better here because directory set is dynamic.

### Selection stability
After `visibleRows` recomputes, find current `selected()?.id` in new rows. If found, update index. If not (collapsed away), clamp to nearest file row and fire `onSelect`.

### Keyboard changes
- `move()` function must skip `type: "dir"` rows during up/down navigation — or alternatively, allow landing on dir rows but treat Enter differently (Enter on dir = toggle, Enter on file = select). Recommend: allow landing on dir rows, space = toggle, enter = no-op on dirs.
- Existing `dialog.stack.length > 0` guard remains unchanged.

### Rendering
Match session sidebar chevron pattern: single-char ▶/▼ at current 2-space indent level. Files remain at 4-space indent.

## Notes
2026-02-06: Created from commit plan. Depends on nothing. Foundation for items 02-04.
2026-02-06: Implemented collapsible directory nodes. Single file change: `file-list.tsx`.
2026-02-06: **Review PASS with suggestions.** Prune effect (line 139) should guard against active filter to avoid losing collapse state. See review-findings.json.
  - Row model: discriminated union `DirRow | FileRow` with `visibleRows` memo
  - Collapse state: `createSignal<Map<string, boolean>>` keyed by `"stage:dirName"`, defaults expanded
  - Keyboard: up/down lands on both dir+file rows; Enter on dir = toggle, Space on dir = toggle, Enter on file = select
  - Selection remap: two-pass effect — tries last known file id, falls back to nearest file row downward then upward
  - Prune effect: removes stale collapse keys when groups change after refetch
  - Rendering: ▶/▼ chevrons at 2-space indent (matching sidebar pattern), files at 4-space indent, dir rows show file count
  - `FileSelection`, `FileTotals`, props interface unchanged — parent `Changes` route untouched
  - `bun run typecheck` passes repo-wide (all 12 packages)
