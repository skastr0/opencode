# Git Review UI for Project-Scoped Changes

id: git-review-ui

## Context
Build a pragmatic, feature-complete review UI for viewing live git state (staged + unstaged changes) in the OpenCode TUI. Inspired by upstream PR anomalyco/opencode#12188, but without depending on anomalyco/opentui#621. The UI must read project-scoped git changes (not `session_diff`) and support line-anchored comments that are buffered and appended to the prompt.

## Acceptance Criteria
- [ ] `/changes` is reachable via slash command and command palette in TUI
- [ ] Review UI reads live project git changes (staged + unstaged + untracked) for current folder/project, independent of `session_diff`
- [ ] Left sidebar shows a directory-grouped tree/list with per-file +/- counts and stage visibility
- [ ] Diff pane adapts to terminal width (split on wide terminals, unified on narrow terminals), respecting existing `diff_style` behavior
- [ ] Users can create line-anchored comments (mouse or keyboard line targeting), buffered locally until submit
- [ ] Submit appends formatted comments to prompt input (does not auto-send message)
- [ ] Escape returns to the prior route context

## Notes
2026-02-06: Created in exploring phase for feasibility assessment.
2026-02-06: Promoted to committed. Plan created with 6 work items. See commit-plan and commit-work-items packets.
2026-02-06: Orchestrator review updated scope to align with explorer packets and upstream PR analysis.
