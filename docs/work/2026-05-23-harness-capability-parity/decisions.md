# Harness Capability Parity Decisions

Feature: harness-capability-parity
Issue: forge-wj36

## Decision 1

Date: 2026-05-23
Task: Capability matrix contract
Gap: Cursor now has a skills surface, while the W0 fixture used Cursor rules because `forge-2si5` requested `.cursor/rules/*.mdc`.
Score: 2/14
Route: PROCEED
Choice made: Model `.cursor/skills` as the on-demand workflow target and `.cursor/rules/*.mdc` as the always-on/scoped policy target. Keep the W0 fixture boundary documented instead of pretending rules are the final skill surface.
Status: RESOLVED

## Decision 2

Date: 2026-05-23
Task: Skills-first stage graph
Gap: Current Forge stage docs still use Claude commands as the source surface.
Score: 3/14
Route: PROCEED
Choice made: Record the target architecture as skills-first and keep Claude commands as shim-only in the contract. Do not migrate command files in this PR because that is broad renderer work.
Status: RESOLVED

## Decision 3

Date: 2026-05-23
Task: Renderer evidence contract
Gap: Some surfaces are unverified or unsupported in at least one harness.
Score: 2/14
Route: PROCEED
Choice made: Store unsupported/unproven states in the matrix with `knownIssue` fields. This keeps the renderer contract honest and blocks silent parity claims.
Status: RESOLVED

## Decision 4

Date: 2026-05-23
Task: Beads context
Gap: The isolated worktree could not open the Beads Dolt database.
Score: 1/14
Route: PROCEED
Choice made: Keep implementation in the isolated git worktree and document the local Beads limitation in validation notes. The primary checkout can still read the issue.
Status: RESOLVED
