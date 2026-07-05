## Description
The migration from `design.md` to `plan.md` is incomplete across docs, skills, command templates, tests, and generated agent guidance. This creates inconsistent instructions and weakens Project Knowledge indexing.

Reference: `docs/work/2026-06-06-kernel-backlog-memory-roadmap/workflow-friction-amendments.md#3-designmd-to-planmd-migration-is-incomplete`

## Scope
- Audit repository references to `design.md`, `plan.md`, work-item planning, design docs, and command contracts.
- Seed the audit with known stale/default-work-item surfaces: `AGENTS.md`, `.claude/commands/plan.md`, `.claude/commands/dev.md`, `.claude/rules/workflow.md`, `lib/core/runtime-graph.js`, and `test/structural/command-contracts.test.js`.
- Replace default work-item planning references with `plan.md`.
- Preserve `design.md` support for true durable architecture/product designs and legacy reads.
- Update drift guards and tests to prevent the old default from returning.
- Ensure KnowledgeStore and orient/recap source classification distinguish `work_plan`, `legacy_work_design`, `architecture_design`, `task_list`, `decision_log`, `evidence`, `issue_body`, `comment`, `stage_run`, `generated_harness`, `runtime_projection`, `derived_summary`, and `proposal`.
- Define proof artifact classification for `evidence.md`, `validation.md`, `validation-notes.md`, stage-run logs, and command evidence.
- Define the minimum evidence artifact contract for Project Knowledge ingestion: issue/work item id, stage/task id, command/run id, command string or tool name, exit code/verdict, timestamp, actor/session, stdout/stderr or log path, source file refs, commit SHA/revision/hash, redaction state, provenance/source type, and links back to the relevant `tasks.md` and `decisions.md` entries.

## Acceptance Criteria
- Search results show no command/template/skill teaching `design.md` as the default work-item planning output.
- Legacy `design.md` inputs are still read where backward compatibility is required.
- `forge orient` and `forge recap` prefer `plan.md`, label legacy `design.md` correctly, surface missing `tasks.md`/`decisions.md`/evidence, and expose JSON source types.
- Evidence artifacts missing the minimum contract are surfaced as incomplete evidence/proposals rather than accepted proof.
- Tests cover command contract alignment, KnowledgeStore source classification, and stale reference regression fixtures.
- Docs clearly state `plan.md` is for per-work-item intent/research/approach while `design.md` is reserved for durable design.
