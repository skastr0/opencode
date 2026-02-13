# Research Rust-first DAP debugger plugin for OpenCode

id: rust-dap-debugger-plugin-research

## Context
User requested a serious IDE-like debugger direction, prioritized on Rust first, with dispatched researchers focused on existing DAP implementations and OpenCode SDK/plugin integration points.

## Acceptance Criteria
- [x] AC-1: Produce a ranked survey of existing Rust-capable DAP adapters and integration options we can embed.
- [x] AC-2: Map OpenCode plugin/SDK/runtime extension points needed for a stateful debugger session lifecycle.
- [x] AC-3: Propose a Rust-first MVP architecture (tools, control flow, process model, permissions, dependencies).
- [x] AC-4: Identify major risks (security, platform compatibility, adapter packaging, UX complexity) with mitigations.

## Technical Notes
Prioritize Rust debugging quality over broad language coverage. Keep JavaScript support as a secondary optional phase.

Scope decision (2026-02-13): lock MVP to codelldb only. Defer lldb-dap and all other fallbacks until post-MVP to reduce architecture and delivery risk.

## Notes
2026-02-13: Created in exploring phase by orchestrator-engineer to dispatch parallel research agents.
2026-02-13: User requested tighter scope; selected codelldb-only MVP with no multi-adapter abstraction.
2026-02-13: Explore outputs crystallized into commit plan and work items in `.agents/messages/2026-02-13T17-00-00Z-commit-plan.json` and `.agents/messages/2026-02-13T17-01-00Z-commit-work-items.json`.
