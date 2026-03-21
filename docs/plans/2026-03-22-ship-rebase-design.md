# Design: Ship Rebase + Workflow Consolidation

- **Feature**: ship-rebase
- **Date**: 2026-03-22
- **Status**: Draft
- **Beads**: forge-ebls

## Purpose

/ship pushes the branch and creates a PR without checking if the branch is up-to-date with master. If master advanced while the worktree was in /dev, the PR shows as "out of date" and may have merge conflicts. Additionally, /premerge adds a full CI cycle just for doc updates, and the PR template focuses on implementation details rather than the "why" behind the change.

## Success Criteria

1. /validate rebases onto origin/master before running checks; aborts cleanly on conflicts
2. /ship checks freshness before push as a safety net
3. PR template leads with Problem/Root Cause/Fix/Value; implementation details in expandable section
4. /ship auto-detects which docs need updating based on the diff and proposes changes
5. /premerge is absorbed into /review's exit gate (verify CI + hand off)
6. Workflow stages reduced from 7 to 6
7. All agent directories stay in sync via sync-commands.js

## Out of Scope

- Runtime code changes (bin/forge.js, lib/) -- this is command-file-only
- Changing /plan, /dev, or /verify commands
- Changing the Lefthook hooks or CI/CD workflows
- Automating conflict resolution (always abort + alert user)

## Approach Selected

Command-file-only changes to `.claude/commands/{validate,ship,review}.md`:
- Modify /validate to add rebase step at entry gate
- Modify /ship to add freshness check, improved PR template, and doc update phase
- Modify /review to absorb /premerge's verify+handoff exit gate
- Deprecate /premerge (keep file but mark as absorbed into /review)
- Run sync-commands.js to propagate to all 7 agent directories

## Constraints

- Command files are markdown instruction files, not executable code
- sync-commands.js must be run after every command file edit
- Agent hook in .claude/settings.json blocks `gh pr merge` -- /review exit gate must NOT merge
- /premerge.md should NOT be deleted (other docs/workflows may reference it); mark as deprecated with redirect

## Edge Cases

1. **Rebase conflicts in /validate**: Abort rebase, show conflicting files, tell user to resolve manually and re-run /validate. Do NOT proceed to checks.
2. **Master advances between /validate and /ship**: /ship's safety check catches this -- re-fetch and rebase if needed. If conflicts, abort.
3. **No docs need updating**: /ship's doc phase detects no affected docs and skips with a note.
4. **PR with no Beads issue**: Template should handle missing Beads gracefully (skip "Closes" line).
5. **Review with no /premerge reference**: /review exit gate works standalone; no dependency on /premerge having been run.

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

## Doc Auto-Detection in /ship

Phase 2 of /ship (before PR creation):
1. Run `git diff master..HEAD --name-only` to get changed files
2. Map changed files to doc locations:
   - Any change -> CHANGELOG.md (always)
   - README-visible features -> README.md
   - Command/workflow changes -> AGENTS.md, docs/WORKFLOW.md
   - API changes -> docs/reference/API_REFERENCE.md
   - Architecture changes -> docs/architecture/
   - Convention changes -> CLAUDE.md (USER section only)
   - Package changes -> package.json description/keywords
   - Template changes -> .github/ templates
3. Propose list to user for approval
4. Update approved docs
5. Commit doc updates to feature branch

## /review Exit Gate (absorbing /premerge)

After all review feedback is addressed:
1. Verify all CI checks pass: `gh pr checks <pr-number>`
2. Verify all review threads resolved
3. Sync Beads: `bd sync`
4. Hand off PR URL to user with merge instructions
5. HARD-GATE: Do NOT run `gh pr merge`

## Workflow Change Summary

Before (7 stages):
```
/plan -> /dev -> /validate -> /ship -> /review -> /premerge -> /verify
```

After (6 stages):
```
/plan -> /dev -> /validate -> /ship -> /review -> /verify
```

- /validate gains: rebase onto origin/master at entry
- /ship gains: freshness check, improved PR template, doc updates
- /review gains: verify+handoff exit gate (from /premerge)
- /premerge: deprecated (redirect to /review)
