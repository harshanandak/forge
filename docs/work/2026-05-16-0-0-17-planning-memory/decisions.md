# 0.0.17 Planning And Memory Loop Decisions

Score uses the `/dev` decision-gate rubric: numerator is the summed risk score, denominator is the 14-point maximum.

## Decision 1

Date: 2026-05-16
Task: Task 1 - Planning Template Runtime Graph
Gap: `forge-besw.24` is closed as docs-only in Beads, but this PR needs runnable/configurable behavior.
Score: 2/14
Route: PROCEED
Choice made: Implement the runnable/configurable slice in `lib/core/runtime-graph.js`, using the existing `.forge/config.yaml` resolver.
Status: RESOLVED

## Decision 2

Date: 2026-05-16
Task: Task 2 - Beads-Backed Project Memory
Gap: Existing public imports may require `lib/project-memory.js`; deleting it outright risks a compatibility break.
Score: 3/14
Route: PROCEED
Choice made: Preserve the module as a compatibility adapter, but remove local JSONL persistence and route to Beads commands.
Status: RESOLVED
