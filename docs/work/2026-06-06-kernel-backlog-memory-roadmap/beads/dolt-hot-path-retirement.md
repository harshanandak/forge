## Description
Dolt/Beads remains a recurring source of setup, sync, push, and worktree friction. Forge should prioritize a TypeScript API-friendly Kernel authority path and keep Dolt/Beads as projection/import-export compatibility rather than core runtime state.

Reference: `docs/work/2026-06-06-kernel-backlog-memory-roadmap/workflow-friction-amendments.md#7-dolt-remains-a-recurring-operational-pain-point`

## Scope
- Identify current command paths that still require Dolt for normal Forge workflow operations.
- Define the TS API-friendly local Kernel interface needed to replace Dolt in the hot path.
- Cover ready/show/list/claim/update/comment/close/stage/run/projection-status command surfaces.
- Preserve Beads/Dolt import/export/projection fidelity until migration gates pass.
- Add release gates that distinguish Dolt compatibility from Dolt authority.

## Acceptance Criteria
- A documented command/path inventory separates hot-path Dolt usage from compatibility/projection usage.
- Kernel local authority API requirements are ready for implementation PRs.
- Normal Forge workflow commands do not shell out to `bd`, read `.beads/issues.jsonl`, treat Beads/Dolt sync as authority, or require Dolt installation except inside import/export/projection adapters.
- Migration tests prove no issue/state/projection data is silently lost.
- Gates include unsupported Beads field preservation, real Dolt-backed ready-queue parity fixtures, import/export dry-run reports, rollback docs, echo-loop prevention, projection quarantine, and proof projection failures never override Kernel authority.
- Release notes cannot claim Dolt is retired until parity, rollback, and projection gates pass.
