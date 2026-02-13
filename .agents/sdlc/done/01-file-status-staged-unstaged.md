# Enrich File.status() to separate staged vs unstaged changes

## Context
The existing `File.status()` in `packages/opencode/src/file/index.ts` runs `git diff --numstat HEAD` which merges staged and unstaged changes into one flat list. The review UI needs explicit staged/unstaged/untracked state so users can review what is committed vs still in the working tree. The `/file/status` server route at `packages/opencode/src/server/routes/file.ts:176` currently returns `File.Info[]` without this separation.

This work item enriches the data layer without changing existing consumers — the existing `File.Info` schema gets an additional optional `stage` field, and `File.status()` runs the two git commands separately (`git diff --cached --numstat` for staged, `git diff --numstat` for unstaged).

## Acceptance Criteria
- [x] `File.Info` Zod schema has a new field `stage: z.enum(["staged", "unstaged", "untracked"]).optional()` — optional so existing callers are unaffected
- [x] `File.status()` runs `git diff --cached --numstat` and `git diff --numstat` separately (instead of `git diff --numstat HEAD`)
- [x] Files that appear in both staged and unstaged output appear as two separate entries with distinct `stage` values
- [x] Untracked files get `stage: "untracked"`
- [x] Deleted files get `stage: "staged"` or `stage: "unstaged"` as appropriate
- [x] The `/file/status` endpoint continues to work; response now includes `stage` on each entry
- [x] SDK is regenerated (`./script/generate.ts`) after schema change so TUI can access the new field
- [x] `bun run typecheck` passes
- [x] Existing consumers that ignore `stage` continue to behave the same

## Technical Notes
- Modify `File.status()` in `packages/opencode/src/file/index.ts` lines 353-425
- The current approach uses `git diff --numstat HEAD` — split into two calls: `git diff --cached --numstat` (staged) and `git diff --numstat` (unstaged working tree)
- Keep deleted file detection for both staged and unstaged: `git diff --name-only --diff-filter=D --cached` and `git diff --name-only --diff-filter=D`
- `File.Info` schema at line 19 — add the optional `stage` field
- After changing the schema, run `./script/generate.ts` to regenerate the SDK
- No TUI changes in this work item

## Notes
2026-02-06: Created from commit plan. Dependency: none (first in sequence).
2026-02-06: Orchestrator note: keep this data model additive and backwards compatible; no route contract break.
2026-02-06: Implemented staged/unstaged/untracked metadata in `packages/opencode/src/file/index.ts` with separate git status collection and stage-aware deleted handling.
2026-02-06: Regenerated SDK via `./script/generate.ts` and validated with `bun run typecheck` (pass).
2026-02-06: Files changed: `packages/opencode/src/file/index.ts`, `packages/sdk/openapi.json`, `packages/sdk/js/src/v2/gen/types.gen.ts`.
