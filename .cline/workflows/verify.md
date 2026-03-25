
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

### Step 6: Clean Up Worktree and Branch

Only run this step after CI is confirmed healthy (Step 3 passed).

Get the merged branch name:

```bash
gh pr view <number> --json headRefName --jq '.headRefName'
```

If the branch name cannot be determined (empty output or error), skip cleanup and tell the user to run `git worktree list` and clean up manually.

Find and remove the matching worktree (if it exists):

```bash
# Get the worktree path for this exact branch
WORKTREE_PATH=$(git worktree list --porcelain \
  | awk -v branch="refs/heads/<branch>" '
      /^worktree / { path=substr($0, 10) }
      $0 == "branch " branch { print path }
    ')

if [ -n "$WORKTREE_PATH" ]; then
  git worktree remove "$WORKTREE_PATH" --force
  echo "Worktree: removed ✓ ($WORKTREE_PATH)"
else
  echo "Worktree: not found (already removed or never created) — skipping"
fi
```

If no worktree is found for that branch, skip gracefully with a note: "Worktree: not found (already removed or never created)".

Delete the local branch (safe delete only):

```bash
git branch -d <branch> 2>/dev/null || echo "Branch: already deleted — skipping"
```

The `|| echo` fallback handles the case where the branch is already gone (e.g., deleted by a previous run or the remote), so the command never fails the verify step.

Report cleanup in output:
```
Worktree: removed ✓
Branch: <branch-name> deleted ✓
```

### Step 7: If Issues Found — Create Beads Issue

**Never commit inline.** If something is wrong, create a tracking issue:

```bash
bd create --title="Post-merge: <description of issue>" --type=bug --priority=1
```

### Step 8: Close Beads Issues (if healthy)

If everything is clean, close all Beads issues referenced in the merged PR.

**Auto-detect beads issues from PR body and branch name:**

```bash
# Get PR body and branch name
PR_BODY=$(gh pr view <number> --json body --jq '.body')
PR_BRANCH=$(gh pr view <number> --json headRefName --jq '.headRefName')

# Extract beads IDs from PR body (matches "Closes beads-xxx", "closes forge-xxx", etc.)
# Patterns: "Closes <prefix>-<id>", "Fixes <prefix>-<id>", "Resolves <prefix>-<id>"
BEADS_IDS=$(echo "$PR_BODY" | grep -oiE '(closes|fixes|resolves)\s+[a-z]+-[a-z0-9]+' | grep -oiE '[a-z]+-[a-z0-9]+$')

# Also check branch name for beads ID (e.g., feat/forge-m0fw-review-system)
BRANCH_ID=$(echo "$PR_BRANCH" | grep -oE '[a-z]+-[a-z0-9]{3,6}' | head -1)
```

**Close each matched issue:**

```bash
# Close issues found in PR body
for id in $BEADS_IDS; do
  bd close "$id" --reason="Merged and verified on master (PR #<number>)" 2>&1 || echo "Warning: could not close $id"
done

# If no issues found in body, try branch name match
if [ -z "$BEADS_IDS" ] && [ -n "$BRANCH_ID" ]; then
  bd close "$BRANCH_ID" --reason="Merged and verified on master (PR #<number>)" 2>&1 || echo "Warning: could not close $BRANCH_ID"
fi
```

**If no beads issues detected at all**, prompt the user:
```
⚠ No beads issue ID found in PR body or branch name.
  If this PR closes a beads issue, run: bd close <id> --reason="Merged (PR #<number>)"
```

```
<HARD-GATE: /verify exit>
Do NOT declare /verify complete until:
1. gh run list --branch master --limit 3 shows actual CI output (not "should be fine")
2. If healthy: Beads issues extracted from PR body/branch and closed (bd close run and confirmed)
   - If no beads ID found: user was warned and given manual close command
3. If issues found: Beads tracking issue created for every problem
4. Worktree removed (or confirmed already gone) — OR Step 6 was intentionally skipped because CI was unhealthy; if skipped, state explicitly: "cleanup deferred, CI was not healthy"
"It should be fine" is not evidence. Run the command. Show the output.
</HARD-GATE>
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
Utility: /status     → Understand current context before starting
Stage 1: /plan       → Design intent → research → branch + worktree + task list
Stage 2: /dev        → Implement each task with subagent-driven TDD
Stage 3: /validate      → Type check, lint, tests, security — all fresh output
Stage 4: /ship       → Push + create PR
Stage 5: /review     → Address GitHub Actions, Greptile, SonarCloud
Stage 6: /premerge   → Update docs, hand off PR to user
Stage 7: /verify     → Post-merge CI check on main (you are here) ✓
```
