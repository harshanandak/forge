## Description
Pre-merge behavior should not become a universal standalone workflow stage. It should be an embedded gate/checkpoint inside existing task-type-specific processes.

Reference: `docs/work/2026-06-06-kernel-backlog-memory-roadmap/workflow-friction-amendments.md#6-pre-merge-should-not-become-a-universal-standalone-stage`

## Scope
- Audit workflow taxonomy, command templates, generated prompts, and tests for pre-merge stage assumptions.
- Define pre-merge as a gate/checkpoint owned by task classification, not a top-level mandatory stage.
- Update docs and command contracts so docs-only, feature, hotfix, refactor, and architecture tasks can require different gates.
- Preserve branch protection and CI checks as merge requirements without creating stage drift.

## Acceptance Criteria
- Workflow stage model does not add universal `premerge` as a required stage for every task.
- Task-type profiles can embed pre-merge checks where appropriate.
- Generated instructions and tests use consistent terminology: stages vs gates/checkpoints.
- Existing workflow commands remain backward compatible where possible.
