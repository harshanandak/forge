# Skill Invocation Metadata Decisions

## Decision 1: Regenerate derived skill scorecards

- Gap: Task 3 changed the approved `ship`, `review`, and `rollback` descriptions, but the
  plan did not include their deterministic canonical and mirror `scorecard.json` artifacts.
- Score:
  1. Files beyond the current task: 2
  2. Function signature or public export: 0
  3. Shared module used by other tasks: 0
  4. Persistent data or schema: 0
  5. Unplanned user-visible behavior: 0
  6. Auth, permissions, or data exposure: 0
  7. Hard to reverse: 0
  Total: 2/14
- Mandatory override: affects a task already implemented and committed.
- Route: BLOCKED.
- Choice made: Accept the generated canonical and `.agents` scorecards because they are
  deterministic consequences of the approved skill descriptions.
- Status: RESOLVED.
- Approval: On 2026-07-30, the user replied `continue` to the surfaced
  `PENDING-DEVELOPER-INPUT` checkpoint.
- Recommendation: Approve retaining the deterministic scorecards produced by the existing
  `forge skill eval --static` generator and committed mirror generator. They contain no
  hand-edited data and do not change scorer behavior.
- Evidence: The focused freshness test reported only the three changed skills as stale in
  both canonical and mirror locations.
