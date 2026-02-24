---
description: Post-merge health check — confirm merge landed, CI is clean, deployments are up
---

Verify that the merge landed correctly and everything is running properly after merge.

# Verify

This command runs AFTER the user has merged the PR. It checks system health — not documentation (that was handled in `/premerge`).

## Usage

```bash
/verify
```

## What This Command Does

### Step 1: Switch to Main and Pull

```bash
git checkout master
git pull
```

Confirm the merge actually landed on main. If the PR isn't merged yet, stop and tell the user to merge first.

### Step 2: Confirm PR Is Merged

Detect the most recently merged PR from the current HEAD commit:

```bash
gh pr list --state merged --base master --limit 1 --json number,state,mergedAt,mergedBy
```

- `state` should be `MERGED`
- If no PR found: the merge may not have landed yet — stop and tell the user to merge first
- If the wrong PR appears: user can specify the number directly with `gh pr view <number> --json state,mergedAt,mergedBy`

### Step 3: Check CI on Main After Merge

```bash
gh run list --branch master --limit 5
```

Check the most recent workflow runs on `master`:
- All should be passing or in progress
- If any failed: identify which workflow and what failed
- Failed CI on main after merge may need a hotfix PR

### Step 4: Check Deployments (if applicable)

Check if the project has a deployment target:

```bash
# Check deployment status from latest run
gh run list --branch master --limit 1

# Check Vercel deployments for the merged PR (use number from Step 2)
gh pr view <number> --json deployments
```

If deployments exist:
- Are they showing as successful?
- Is the production/preview URL responding?

### Step 5: Report Status

**If everything is clean**:
```
✅ Merge verified — everything is healthy

  PR: #<number> merged by <user> at <time>
  CI on master: ✓ All passing
  Deployments: ✓ Up (if applicable)

  Ready for next feature → run /status
```

**If issues found**:
```
⚠️  Post-merge issues detected

  PR: #<number> merged ✓
  CI on master: ✗ <workflow-name> failing
    - Error: <description>
    - Action needed: <hotfix or investigation>

  Deployments: ✗ <deployment> not responding

  Next: Create hotfix branch or investigate root cause
```

### Step 6: If Issues Found — Create Beads Issue

**Never commit inline.** If something is wrong, create a tracking issue:

```bash
bd create --title="Post-merge: <description of issue>" --type=bug --priority=1
```

## Rules

- **Never commits** — this command is read-only
- **Never creates PRs** — if fixes are needed, that's a new /dev cycle
- **Runs after user confirms merge** — not before
- **Reports honestly** — if CI is broken on main, say so clearly

## Example Output (Healthy)

```
✅ Merge verified — everything is healthy

  PR: #89 merged by harshanandak at 2026-02-24T14:30:00Z
  Branch: feat/auth-refresh deleted ✓
  CI on master:
    ✓ Test Suite (ubuntu, node 20): passing
    ✓ Test Suite (windows, node 22): passing
    ✓ ESLint: passing
    ✓ SonarCloud: passing
    ✓ CodeQL: passing
  Deployments: N/A (no deployment configured)

  Ready for next feature → run /status
```

## Example Output (Issues Found)

```
⚠️  Post-merge issues detected

  PR: #89 merged ✓
  CI on master:
    ✓ Test Suite: passing
    ✗ SonarCloud: quality gate failing
      - 2 new code smells introduced
      - Action: investigate or create hotfix

  Created Beads issue: forge-xyz
  "Post-merge: SonarCloud quality gate failing on master after PR #89"

  Run /status to assess next steps
```

## Integration with Workflow

```
1. /status               → Understand current context
2. /research <name>      → Research and document
3. /plan <feature-slug>  → Create plan and tracking
4. /dev                  → Implement with TDD
5. /check                → Validate
6. /ship                 → Create PR
7. /review               → Address comments
8. /premerge             → Complete docs, hand off to user
9. /verify               → Post-merge health check (you are here) ✓
```
