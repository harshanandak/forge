## Description
Fresh Forge adoption does not consistently teach or scaffold the current work-folder planning structure. New projects should guide agents toward `docs/work/<date>-<slug>/plan.md`, `tasks.md`, `decisions.md`, and evidence/validation artifacts instead of legacy or ad hoc layouts.

Reference: `docs/work/2026-06-06-kernel-backlog-memory-roadmap/workflow-friction-amendments.md#2-new-project-setup-does-not-enforce-the-current-work-folder-planning-structure`

## Scope
- Update setup templates, generated agent instructions, skills, and command prompts to use `docs/work/<date>-<slug>/`.
- Teach `plan.md` as the default work-item planning document.
- Teach `tasks.md`, `decisions.md`, and validation/evidence files as sibling artifacts.
- Teach the minimum evidence artifact fields: issue/work item id, stage/task id, command/run id, command string or tool name, exit code/verdict, timestamp, actor/session, stdout/stderr or log path, source file refs, commit SHA/revision/hash, redaction state, provenance/source type, and links back to task/decision entries.
- Keep `design.md` as a durable architecture/product design artifact or backward-compatible legacy input.
- Cover existing-project update/repair, not just greenfield setup: `forge update`, `forge setup --repair`, generated harness preview/apply flows, and stale instruction migration.
- Include concrete renderer/template surfaces: `AGENTS.md`/`CLAUDE.md` projections, `.claude/commands/**`, `.claude/rules/**`, cross-agent skills/templates, `docs/reference/AGENT_SKILL_PARITY.md`, `lib/harness-capability-matrix.js`, and packages/skills templates.
- Add fresh-project fixtures for all supported agent harnesses.

## Acceptance Criteria
- A fresh `forge setup` project includes guidance for the preferred work-folder structure.
- An existing Forge project can preview and apply the updated artifact contract without surprise dirty generated files.
- `/plan`, `/dev`, `/validate`, `/ship`, `forge plan`, and generated skills agree on artifact names and locations.
- Fresh and existing-project guidance explains how validation evidence links to `tasks.md` and `decisions.md` so future `forge recap` can cite proof instead of loose notes.
- Tests prove new projects do not regress to legacy `design.md` as the default work-item plan.
- Documentation explains when `design.md` is still appropriate.
