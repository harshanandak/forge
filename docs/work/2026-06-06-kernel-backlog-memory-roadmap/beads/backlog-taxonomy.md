## Description
Define Kernel issue/backlog taxonomy for UI and agent-friendly planning.

> Amended 2026-06-11: taxonomy collapsed per accepted decision D18 (see `decisions.md`). Eight types and stored blocked/ready statuses were the first-pass shape; evaluation confirmed they create misfiling noise for agents and double bookkeeping against derived readiness.

## Scope
- Issue types: `epic`, `task`, `bug`, `decision`. Richer categories (`feature`, `story`, `chore`, `spike`) are labels, not types — a type must change Kernel behavior (routing, gates, board grouping) to earn existence.
- Stored statuses: `open`, `in_progress`, `review`, `done`, `cancelled`.
- `ready` and `blocked` are derived read-model facts computed from dependencies, explicit blockers, claims, gates, and quarantine — never stored status values (aligns with multi-evaluator-review finding that readiness is a derived read model).
- Single numeric rank is authoritative for ordering; P0–P4 is a display label projection only.
- Separate parent/child hierarchy, sprint/release bucket, claim lease, and workflow stage.
- Preserve projections for external assignee/labels without making them claim authority.

## Acceptance Criteria
- Docs describe backlog vs sprint vs task vs stage.
- Kernel schema plan identifies fields/read models needed.
- Schema enforces the 4-type enum and 5-status enum; `ready`/`blocked` appear only in read-model/query responses.
- UI/API implications are clear enough for future frontend work.
