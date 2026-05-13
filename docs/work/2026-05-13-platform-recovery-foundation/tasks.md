# Tasks

## Task 1: Beads Bootstrap Metadata And Recovery Tests

Issue coverage: `forge-9ats`, `forge-epkw`.

TDD steps:
- RED: Add failing tests for metadata-derived Dolt database naming, external worktree main-root detection, and recovery hint messages.
- GREEN: Update `lib/beads-bootstrap.js` only as needed.
- REFACTOR: Keep recovery strategy helpers small and dependency-injected.

## Task 2: WSL Bash Helper And Entrypoint Sourcing

Issue coverage: `forge-u7go`, `forge-0g2m`.

TDD steps:
- RED: Add a script audit test that fails when a bash entrypoint uses `bd`, `jq`, or `gh` without sourcing `scripts/bootstrap-windows-tools.sh`.
- GREEN: Add the helper and source it from affected entrypoints.
- REFACTOR: Avoid duplicating command-resolution logic in each entrypoint.

## Task 3: Worktree Hook Surface Check

Issue coverage: overlapping setup surface of `forge-ujq.2`.

TDD steps:
- RED: Add or adjust a worktree command test proving `forge worktree create` runs package install in the created worktree.
- GREEN: Keep the existing install behavior intact and add clearer failure-safe messaging if needed.
- REFACTOR: Do not expand into global lefthook install or unrelated hook policy.

## Task 4: Workflow Documentation And Handoff

Issue coverage: all listed issues.

TDD steps:
- RED: N/A, documentation and PR body only.
- GREEN: Record decisions and validation evidence.
- REFACTOR: Keep non-scope explicit in the PR handoff.
