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
- Mandatory overrides: none.
- Route: PROCEED.
- Decision: Run the existing deterministic `forge skill eval --static` generator, then
  regenerate the committed `.agents/skills` mirror. Do not hand-edit scorecards or change
  scorer behavior.
- Evidence: The focused freshness test reported only the three changed skills as stale in
  both canonical and mirror locations.
