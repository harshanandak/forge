---
name: status
description: >
  Report where the project stands right now and what work is in flight -- the Forge status
  snapshot. Reach for this at session start or whenever the user says "/status", "where am I",
  "what's in progress", "catch me up", "resume work", "what changed recently", or "what should
  I pick up next". It runs forge sync, then surfaces the detected workflow stage, the user's
  active/claimed issues, all issues ranked by composite score (priority, dependency impact,
  type, staleness) with conflict-risk annotations, stale in-progress issues that were already
  merged (which it reconciles by closing them), the last ~10 commits, and a forge team
  workload/dashboard overview. Use it to ORIENT and decide the next move: it reports state and
  points ahead -- it does not plan, run development, or claim an issue to work it (its only
  write is closing already-merged stale issues during reconciliation). Not for: routing to a
  specific stage skill or documenting the full issue-verb surface (that's kernel); deeply
  ranking and EXPLAINING a single next-ready or blocked issue to hand off (triage-ready);
  everyday create/update/list/close/comment/search issue operations (issue-basics); the Hermes
  harness's token-bounded orient/recap state contract (hermes-forge); or the post-merge CI
  health check that closes issues after a merge lands (verify).
allowed-tools: Bash, Read, Grep, Glob
---

Check where you are in the project and what work is in progress.

# Status Check

This skill helps you understand the current state of the project before starting new work.

## Usage

```bash
/status
```

## What This Skill Does

## Step 0: Sync team state

```bash
# Sync team state before showing status
forge sync || true
```

### Step 1: Smart Status (ranked issues with conflict detection)

```bash
bash scripts/smart-status.sh
```
This command dynamically computes and displays all issues ranked by composite score (priority, dependency impact, type, staleness, epic proximity). Output includes active sessions, conflict risk annotations, and grouped categories. No manual querying needed.

For full context on any issue: `forge show <id>`

### Step 1b: Reconcile stale in-progress issues

Check if any in-progress issues were already merged but not closed (can happen if `/verify` was skipped or backup was restored from stale snapshot):

```bash
# Detect default branch dynamically (prefer main over master)
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||')
if [ -z "$DEFAULT_BRANCH" ]; then
  if git rev-parse --verify main >/dev/null 2>&1; then DEFAULT_BRANCH="main"
  elif git rev-parse --verify master >/dev/null 2>&1; then DEFAULT_BRANCH="master"
  else echo "ERROR: No main or master branch found -- skipping stale reconciliation" >&2; DEFAULT_BRANCH=""; fi
fi

# For each in_progress issue, check if its PR was already merged
if [ -n "$DEFAULT_BRANCH" ]; then
  forge list --status=in_progress --json 2>/dev/null | jq -r '.[].id' | while read id; do
    # Search git log for the issue ID in commit messages (fixed-strings for literal match)
    if git log --oneline --first-parent "$DEFAULT_BRANCH" --fixed-strings --grep="$id" | grep -q .; then
      echo "STALE: $id -- found in git history, likely already merged"
    fi
  done
fi
```

If stale issues are found, close them:
```bash
forge close <id> --force --reason="Already merged -- detected during status reconciliation"
```

### Step 2: Review Recent Commits
```bash
git log --oneline -10
```

### Step 3: Determine Context
- **New feature**: No active work, ready to start fresh
- **Continuing work**: In-progress issues found, resume where left off
- **Review needed**: Work marked complete, needs review/merge

### Team context

Show current developer's active work and team overview:

```bash
# Show my active issues
forge team workload --me 2>&1 || true

# One-line team summary
forge team dashboard 2>&1 | head -5 || true
```

## Next Steps

- **If starting new work**: Run `/plan <feature-name>`
- **If continuing work**: Resume with appropriate phase command
- **If reviewing**: Run `/review <pr-number>` (the pre-merge doc gate is embedded in `/ship` and `/review`)
