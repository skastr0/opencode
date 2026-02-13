# Scaffold the /changes route and command registration

## Context
The TUI routing system in `packages/opencode/src/cli/cmd/tui/context/route.tsx` currently only has `HomeRoute` and `SessionRoute`. The review UI needs a new `ChangesRoute` type. The `App` component in `app.tsx` uses a `<Switch>/<Match>` to render routes. A new `/changes` slash command needs to be registered in the command system so users can open the review UI.

This work item adds the route type, the `<Match>` case in `App`, the `/changes` command registration, and an empty placeholder `Changes` component that just renders a header and an escape-to-go-back handler.

## Acceptance Criteria
- [x] `Route` union in `route.tsx` includes `ChangesRoute` with `type: "changes"`
- [x] `App` component in `app.tsx` has a `<Match when={route.data.type === "changes"}>` that renders a `<Changes />` component
- [x] `/changes` slash command is registered in `app.tsx` command registrations (alongside existing commands like `/status`, `/sessions`, etc.)
- [x] Command palette includes a "View changes" action that navigates to the same route
- [x] The `/changes` command navigates to `{ type: "changes", returnTo: <current-route> }`
- [x] The `Changes` component is created at `packages/opencode/src/cli/cmd/tui/routes/changes/index.tsx`
- [x] The `Changes` component renders a minimal header ("Changes") and handles `Escape` to navigate back to the previous route (home or session)
- [x] `bun run typecheck` passes

## Technical Notes
- Add `ChangesRoute` to `packages/opencode/src/cli/cmd/tui/context/route.tsx`: `export type ChangesRoute = { type: "changes"; returnTo?: HomeRoute | SessionRoute }`
- The `returnTo` field stores where to navigate back on Escape
- In `app.tsx`, add import and `<Match>` case alongside existing `"home"` and `"session"` matches
- Register the `/changes` command in the `command.register()` block in `app.tsx` (around line 287)
- Create `packages/opencode/src/cli/cmd/tui/routes/changes/index.tsx` with a minimal component
- Follow existing patterns: use `useRoute()`, `useTheme()`, `useTerminalDimensions()`, `useKeyboard()`
- Keep the component minimal — just structure, no data fetching yet

## Notes
2026-02-06: Created from commit plan. Dependency: none (can run in parallel with WI-01).
2026-02-06: Implemented `/changes` route scaffold with return navigation. Added route type, app route match, command registration/palette action, and minimal `Changes` placeholder screen. Validation: `bun run typecheck` passed.
Files changed: `packages/opencode/src/cli/cmd/tui/context/route.tsx`, `packages/opencode/src/cli/cmd/tui/app.tsx`, `packages/opencode/src/cli/cmd/tui/routes/changes/index.tsx`.
