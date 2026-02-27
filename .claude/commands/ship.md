---
description: Create PR with comprehensive documentation
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
1. /check was run in this session with all four outputs shown (type, lint, tests, security)
2. All checks confirmed passing — not assumed, not "was passing earlier"
3. Beads issue is in_progress
4. git branch --show-current output is NOT main or master
</HARD-GATE>
```

## What This Command Does

### Step 1: Verify /check Passed
Ensure all four validation checks completed successfully with fresh output in this session.

### Step 2: Update Beads
```bash
bd update <id> --status done
bd sync
```

### Step 3: Push Branch
```bash
git push -u origin <branch-name>
```

### Step 4: Create PR

```bash
gh pr create --title "feat: <feature-name>" --body "$(cat <<'EOF'
## Summary
[Auto-generated from commits and design doc]

## Design Doc
See: docs/plans/YYYY-MM-DD-<slug>-design.md

## Decisions Log
See: docs/plans/YYYY-MM-DD-<slug>-decisions.md (if any undocumented decisions arose during /dev)

## Beads Issue
Closes: <issue-id>

## Key Decisions
[From design doc - 3-5 key decisions with reasoning]

## TDD Test Coverage
- Unit tests: [count] tests, [X] scenarios
- Integration tests: [count] tests
- E2E tests: [count] tests
- All tests passing ✓

## Security Review
- OWASP Top 10: All mitigations implemented
- Security tests: [count] scenarios passing
- Automated scan: No vulnerabilities

## Test Plan
- [x] Type check passing
- [x] Lint passing
- [x] Code review passing
- [x] E2E tests passing
- [x] Security review completed

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

## Example Output

```
✓ Validation: /check passed (all 4 checks — fresh output confirmed)
✓ Beads: Marked done & synced (forge-xyz)
✓ Pushed: feat/stripe-billing
✓ PR created: https://github.com/.../pull/123
  - Beads linked: forge-xyz
  - Design doc linked: docs/plans/2026-02-26-stripe-billing-design.md
  - Decisions log linked: docs/plans/2026-02-26-stripe-billing-decisions.md
  - Test coverage documented
  - Security review documented

PR Summary:
  - 12 commits
  - 18 test cases, all passing
  - OWASP Top 10 security review completed
  - 3 key architectural decisions documented

⏸️  PR created, awaiting automated checks (Greptile, SonarCloud, GitHub Actions)

Next: /review <pr-number> (after automated checks complete)
```

## Integration with Workflow

```
Utility: /status     → Understand current context before starting
Stage 1: /plan       → Design intent → research → branch + worktree + task list
Stage 2: /dev        → Implement each task with subagent-driven TDD
Stage 3: /check      → Type check, lint, tests, security — all fresh output
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
