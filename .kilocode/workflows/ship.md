---
description: Create PR with comprehensive documentation
mode: code
---

Push code and create a pull request with full context and documentation links.

# Ship

This command creates a PR after validation passes.

## Usage

```bash
/ship
```

```
<HARD-GATE: /ship entry>
Do NOT create PR until:
1. /validate was run in this session with all four outputs shown (type, lint, tests, security)
2. All checks confirmed passing — not assumed, not "was passing earlier"
3. Beads issue is in_progress
4. git branch --show-current output is NOT main or master
</HARD-GATE>
```

## What This Command Does

### Step 1: Verify /validate Passed
Ensure all four validation checks completed successfully with fresh output in this session.

### Step 2: Freshness Check — Is Branch Still Current?

Even though /validate rebased onto master, time may have passed since then (user reviewed design doc, took a break, etc.). This lightweight check catches staleness before pushing.

```bash
git fetch origin master
BEHIND=$(git rev-list --count HEAD..origin/master)
```

- If `BEHIND > 0`: **STOP**. Print: "Master has advanced since /validate ($BEHIND new commits). Run /validate again to rebase and re-check."
- If `BEHIND = 0`: Continue to push.
- If fetch fails: **STOP**. Print error. Do NOT push without confirming freshness.

This is NOT a full rebase — just a check. The rebase happens in /validate where the full test suite runs afterward.

### Step 3: Update Beads
```bash
bd update <id> --status done
bd sync
```

### Step 4: Push Branch
```bash
git push -u origin <branch-name>
```

### Step 5: Create PR

Use the narrative PR template below. Lead with WHY (Problem/Root Cause/Fix/Value) — this is what reviewers need to understand first. Keep implementation details (test coverage, security review, design doc) in a collapsible section so they're available but don't clutter the summary.

If no Beads issue exists (hotfix, external contribution), skip the "Closes" line.

```bash
gh pr create --title "<type>: <concise description>" --body "$(cat <<'EOF'
## Problem
[What was broken, what need existed, or what user pain this addresses]

## Root Cause
[Why it happened, why it was missing, or what gap existed]

## Fix
[What this PR does to solve it — approach, not implementation details]

## Value
[Who benefits, what improves, what risk is removed]

## Beads
Closes: <issue-id>

<details>
<summary>Implementation Details</summary>

### Test Coverage
- Tests: [count] passing
- Scenarios covered: [list key scenarios]

### Security Review
- OWASP Top 10: [summary — applicable risks and mitigations]
- Automated scan: [result]

### Design Doc
See: docs/plans/YYYY-MM-DD-<slug>-design.md

### Decisions Log
See: docs/plans/YYYY-MM-DD-<slug>-decisions.md (if any undocumented decisions arose during /dev)

### Key Decisions
[From design doc — 3-5 key decisions with reasoning]

### Validation
- [x] Type check passing
- [x] Lint passing (0 errors, 0 warnings)
- [x] All tests passing
- [x] Security review completed

</details>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### Step 6: Record Stage Transition
```bash
bash scripts/beads-context.sh stage-transition <id> ship review
```

## Example Output

```
✓ Validation: /validate passed (all 4 checks — fresh output confirmed)
✓ Freshness: Branch is up-to-date with master
✓ Beads: Marked done & synced (forge-xyz)
✓ Pushed: feat/stripe-billing
✓ PR created: https://github.com/.../pull/123
  - PR body: Problem → Root Cause → Fix → Value (narrative format)
  - Beads linked: forge-xyz
  - Implementation details in collapsible section

⏸️  PR created, awaiting automated checks (Greptile, SonarCloud, GitHub Actions)

Next: /review <pr-number> (after automated checks complete)
```

## Integration with Workflow

```
Utility: /status     → Understand current context before starting
Stage 1: /plan       → Design intent → research → branch + worktree + task list
Stage 2: /dev        → Implement each task with subagent-driven TDD
Stage 3: /validate      → Type check, lint, tests, security — all fresh output
Stage 4: /ship       → Push + create PR (you are here)
Stage 5: /review     → Address GitHub Actions, Greptile, SonarCloud
Stage 6: /premerge   → Update docs, hand off PR to user
Stage 7: /verify     → Post-merge CI check on main
```

## Tips

- **Complete PR body**: Include design doc, decisions log, and test coverage
- **Link everything**: Design doc, decisions log, Beads issue
- **Document security**: OWASP Top 10 review in PR body
- **Test coverage**: Show all test scenarios passing
- **Wait for checks**: Let GitHub Actions, Greptile, SonarCloud run
- **NO auto-merge**: Always wait for /review phase
