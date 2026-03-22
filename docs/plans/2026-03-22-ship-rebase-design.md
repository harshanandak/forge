# Design: Ship Rebase + PR Template Improvement

- **Feature**: ship-rebase
- **Date**: 2026-03-22
- **Status**: Draft
- **Beads**: forge-ebls
- **Follow-up**: forge-s0c3 (workflow consolidation: premerge absorption, doc move, 7->6 stages)

## Purpose

/ship pushes the branch and creates a PR without checking if the branch is up-to-date with master. If master advanced while the worktree was in /dev, the PR shows as "out of date" and may have merge conflicts. Additionally, the PR template focuses on implementation details rather than the "why" behind the change.

## Success Criteria

1. /validate rebases onto origin/master before running checks; aborts cleanly on conflicts
2. /ship checks freshness before push as a safety net
3. PR template leads with Problem/Root Cause/Fix/Value; implementation details in expandable section
4. All agent directories stay in sync via sync-commands.js

## Out of Scope

- Runtime code changes (bin/forge.js, lib/) -- this is command-file-only
- Changing /plan, /dev, /review, /premerge, or /verify commands
- Changing the Lefthook hooks or CI/CD workflows
- Automating conflict resolution (always abort + alert user)
- Workflow consolidation (7->6 stages) -- see forge-s0c3

## Approach Selected

Command-file-only changes to `.claude/commands/{validate,ship}.md`:
- Modify /validate to add rebase step at entry gate
- Modify /ship to add freshness check and improved PR template
- Run sync-commands.js to propagate to all 7 agent directories

## Constraints

- Command files are markdown instruction files, not executable code
- sync-commands.js must be run after every command file edit

## Edge Cases

1. **Rebase conflicts in /validate**: Abort rebase, show conflicting files, tell user to resolve manually and re-run /validate. Do NOT proceed to checks. This is the most likely failure mode when multiple PRs are in flight.
2. **Master advances between /validate and /ship**: /ship's safety check catches this -- re-fetch and rebase if needed. If conflicts, abort. This handles the gap where time passes between validation and shipping (e.g., user takes a break, reviews design doc, etc.).
3. **PR with no Beads issue**: Template should handle missing Beads gracefully (skip "Closes" line). This can happen for hotfixes or external contributions that don't use the full /plan workflow.
4. **Already up-to-date**: If the branch is already current with master (no new commits on master since branch creation), the rebase step should be a no-op that completes silently without slowing down the workflow.
5. **Detached HEAD or missing remote**: If `git fetch origin` fails (no network, no remote configured), abort with a clear error. Do not silently skip the freshness check.

## Ambiguity Policy

Use 7-dimension rubric scoring. >= 80% confidence: proceed and document. < 80%: stop and ask user.

## PR Template Structure (New)

Visible section (always shown):
```markdown
## Problem
[What was broken / what need existed]

## Root Cause
[Why it happened / why it was missing]

## Fix
[What this PR does to solve it]

## Value
[Impact: who benefits, what improves, what risk is removed]

## Beads
Closes: <issue-id>

<details>
<summary>Implementation Details</summary>

### Test Coverage
- Unit tests: [count] tests
- All tests passing

### Security Review
- OWASP analysis: [summary]

### Design Doc
See: docs/plans/YYYY-MM-DD-<slug>-design.md

### Key Decisions
[From design doc]

### Documentation Updated
[List of docs updated in this PR]
</details>
```

## Changes Summary

This PR modifies 2 command files:

1. **validate.md** — Add rebase onto origin/master as the first step in the entry HARD-GATE. The rebase ensures all validation checks (typecheck, lint, tests, security) run against code that includes the latest master changes, catching integration issues before the PR is created rather than after.

2. **ship.md** — Two changes:
   a. Add a freshness safety check before `git push`. Even though /validate already rebased, time may have passed. This is a lightweight `git fetch + behind check` (not a full rebase) that alerts if master advanced again.
   b. Replace the current PR template (implementation-focused) with a narrative template: Problem -> Root Cause -> Fix -> Value (always visible), with test coverage, security review, and design doc links in a collapsible `<details>` section. This makes PRs scannable for reviewers who care about "why" and keeps implementation details available but not in the way.

Both files are synced to all 7 agent directories via `node scripts/sync-commands.js`.

## Technical Research

### DRY Check
- `/premerge.md` (lines 29-41) already has a "warn if behind master" step, but it only warns and tells the user to rebase manually. Our approach is stronger: /validate actually performs the rebase automatically, and /ship has a lightweight safety check. No duplication — we're improving the existing pattern and placing it earlier in the workflow.
- No other command files contain rebase logic.

### OWASP Top 10 Analysis
This change modifies markdown instruction files only — no runtime code, no user input handling, no API calls, no data storage. All 10 OWASP categories are not applicable. The only security-adjacent aspect is the `git rebase origin/master` command, which uses no user-supplied strings and has no injection risk.

### TDD Test Scenarios
Command files are agent instructions (markdown), not executable code. Testing is done through the project's command eval system and manual verification. Key scenarios:

1. **Happy path rebase**: /validate rebases successfully when branch is behind master, then all 4 checks run on rebased code
2. **Conflict abort**: /validate aborts cleanly when rebase hits conflicts, shows conflicting files, does NOT proceed to checks
3. **Already current**: /validate completes silently when branch is already up-to-date (no-op rebase)
4. **Ship freshness alert**: /ship detects branch fell behind between /validate and /ship, alerts user before pushing
5. **PR template structure**: /ship generates PR body with Problem/Root Cause/Fix/Value visible and implementation details in collapsible section

### Codebase Impact
- Files to modify: `.claude/commands/validate.md`, `.claude/commands/ship.md`
- Files auto-synced: 7 agent directories via `node scripts/sync-commands.js`
- No changes to: bin/forge.js, lib/, tests, CI workflows, Lefthook hooks

## Follow-up Work

The broader workflow consolidation (absorbing /premerge into /review, moving doc updates to /ship, reducing from 7 to 6 stages) is tracked in **forge-s0c3**, which depends on this PR landing first.
