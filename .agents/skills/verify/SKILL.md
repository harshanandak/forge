---
name: verify
description: >
  Runs the Forge verify stage — the post-merge health check performed AFTER a PR is merged:
  switch to master and pull, confirm the merge landed, check CI is green on master, confirm
  deployments are up, remove the merged worktree, safe-delete the branch, and close the
  kernel issues the PR resolved. Use when asked to verify a merge went cleanly, confirm
  post-merge CI health on master, check deployments after merging, clean up a merged branch or
  worktree, or close the issue now that its PR is merged — and whenever `/verify` is invoked.
  Strictly the POST-merge stage: use shepherd instead to monitor a still-open PR toward merge,
  review to fix and resolve PR feedback before merge, ship to push the branch and open the PR,
  rollback to undo an already-shipped change, status to merely report the current stage
  without acting, and issue-basics to close an issue unrelated to a just-merged PR.
allowed-tools: Bash, Read, Grep, Glob
---

Verify that the merge landed correctly and everything is running properly after merge.

# Verify

This skill runs AFTER the user has merged the PR. It checks system health — not documentation (that was handled by the pre-merge gate embedded in `/ship` and `/review`).

## Usage

```bash
/verify
```

## What This Skill Does

### Step 1: Switch to Master and Pull

```bash
git checkout master
git pull
```

Confirm the merge actually landed on master. If the PR isn't merged yet, stop and tell the user to merge first.

### Step 2: Confirm PR Is Merged

Detect the PR that produced the current HEAD commit — scope the lookup to that
commit's SHA so you don't pick up an unrelated newer merge:

```bash
gh pr list --state merged --base master --search "$(git rev-parse HEAD)" --limit 1 --json number,state,mergedAt,mergedBy
```

- `state` should be `MERGED`
- If no PR found: the merge may not have landed yet — stop and tell the user to merge first
- If the wrong PR appears: user can specify the number directly with `gh pr view <number> --json state,mergedAt,mergedBy`

### Step 3: Check CI on Master After Merge

```bash
gh run list --branch master --limit 5
```

Check the most recent workflow runs on `master`:
- All should be passing or in progress
- If any failed: identify which workflow and what failed
- Failed CI on master after merge may need a hotfix PR

### Step 4: Check Deployments (if applicable)

Check if the project has a deployment target:

```bash
# Check deployment status from latest run
gh run list --branch master --limit 1

# Check Vercel deployments for the merged PR (use number from Step 2)
gh pr view <number> --json statusCheckRollup
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

### Step 7: If Issues Found — Create Issue

**Never commit inline.** If something is wrong, create a tracking issue:

```bash
forge create --title="Post-merge: <description of issue>" --type=bug --priority=1
```

### Step 8: Close resolved issues (if healthy)

If everything is clean, close all issues referenced in the merged PR.

**Auto-detect issues from PR body and branch name:**

```bash
# Get PR body and branch name
PR_BODY=$(gh pr view <number> --json body --jq '.body')
PR_BRANCH=$(gh pr view <number> --json headRefName --jq '.headRefName')

# Extract issue IDs from PR body
# Matches short form (e.g. "Closes forge-abc") and kernel UUIDs (e.g. "Closes d71a824b-b0a2-...")
# Patterns: "Closes <id>", "Fixes <id>", "Resolves <id>"
SHORT_IDS=$(echo "$PR_BODY" | grep -oiE '(closes|fixes|resolves):?\s+[a-z]+-[a-z0-9]+' | grep -oiE '[a-z]+-[a-z0-9]{3,6}$')
UUID_IDS=$(echo "$PR_BODY" | grep -oiE '(closes|fixes|resolves):?\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | grep -oiE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
ISSUE_IDS="$SHORT_IDS $UUID_IDS"

# Validate each ID exists in the kernel
VALID_IDS=""
for id in $ISSUE_IDS; do
  if forge show "$id" >/dev/null 2>&1; then
    VALID_IDS="$VALID_IDS $id"
  fi
done
ISSUE_IDS="$VALID_IDS"

# Also check branch name for an issue ID — extract segment after last /
# then validate with forge show to avoid false matches like "pr-templa"
BRANCH_SLUG=$(echo "$PR_BRANCH" | sed 's|.*/||')
BRANCH_ID=$(echo "$BRANCH_SLUG" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z]+-[a-z0-9]{3,6}' | head -1)
if [ -n "$BRANCH_ID" ] && ! forge show "$BRANCH_ID" >/dev/null 2>&1; then
  BRANCH_ID=""  # Not a valid issue ID — discard
fi
```

**Close each matched issue:**

```bash
# Close issues found in PR body. Track failures — a close that fails must
# block /verify completion, not be downgraded to a warning.
close_failed=0
for id in $ISSUE_IDS; do
  if ! forge close "$id" --reason="Merged and verified on master (PR #<number>)"; then
    echo "Warning: could not close $id"
    close_failed=1
  fi
done

# If no issues found in body, try branch name match (skip if already closed above)
if [ -z "$ISSUE_IDS" ] && [ -n "$BRANCH_ID" ]; then
  forge close "$BRANCH_ID" --reason="Merged and verified on master (PR #<number>)" || { echo "Warning: could not close $BRANCH_ID"; close_failed=1; }
elif [ -n "$BRANCH_ID" ] && ! echo "$ISSUE_IDS" | grep -qw "$BRANCH_ID"; then
  forge close "$BRANCH_ID" --reason="Merged and verified on master (PR #<number>)" || { echo "Warning: could not close $BRANCH_ID"; close_failed=1; }
fi

# Any intended close that failed → /verify is NOT complete.
if [ "$close_failed" -ne 0 ]; then
  echo "✗ One or more issues failed to close — /verify is NOT complete."
  exit 1
fi
```

**If no issues detected at all**, prompt the user:
```
⚠ No issue ID found in PR body or branch name.
  If this PR closes an issue, run: forge close <id> --reason="Merged and verified on master (PR #<number>)"
```

```
<HARD-GATE: /verify exit>
Do NOT declare /verify complete until:
1. gh run list --branch master --limit 3 shows actual CI output (not "should be fine")
2. If healthy: issues extracted from PR body/branch and closed (`forge close` run and confirmed)
   - If no issue ID found: user was warned and given manual close command
3. If issues found: tracking issue created for every problem
4. Worktree removed (or confirmed already gone) — OR Step 6 was intentionally skipped because CI was unhealthy; if skipped, state explicitly: "cleanup deferred, CI was not healthy"
"It should be fine" is not evidence. Run the command. Show the output.
</HARD-GATE>
```

## Rules

- **Never commits code** — this skill may update issue state after post-merge health is verified
- **Never creates PRs** — if fixes are needed, that's a new /dev cycle
- **Runs after user confirms merge** — not before
- **Reports honestly** — if CI is broken on master, say so clearly

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

  Created issue: forge-xyz
  "Post-merge: SonarCloud quality gate failing on master after PR #89"

  Run /status to assess next steps
```

## Integration with Workflow

```
Utility: /status  -> Understand current context before starting

Default template:
  /plan      -> Optional default planner; external planners may satisfy /dev entry
  /dev       -> Implement each task with subagent-driven TDD
  /validate  -> Type check, lint, tests, security
  /ship      -> Push + create PR
  /review    -> Address PR feedback
  /verify    -> Post-merge health check

Pre-merge gate: doc updates + CI-green checkpoint embedded in /ship and /review (not a separate stage).
```
