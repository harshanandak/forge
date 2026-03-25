---
description: Check current stage and context
mode: code
---

Check where you are in the project and what work is in progress.

# Status Check

This command helps you understand the current state of the project before starting new work.

## Usage

```bash
/status
```

## What This Command Does

## Step 0: Sync team state

```bash
# Sync team state before showing status
bash scripts/sync-utils.sh auto-sync
```

### Step 1: Smart Status (ranked issues with conflict detection)

```bash
bash scripts/smart-status.sh
```
This script dynamically computes and displays all issues ranked by composite score (priority, dependency impact, type, staleness, epic proximity). Output includes active sessions, conflict risk annotations, and grouped categories. No manual querying needed — the script handles everything.

For full context on any issue: `bd show <id>`

### Step 1b: Reconcile stale in-progress issues

Check if any in-progress issues were already merged but not closed (can happen if `/verify` was skipped or backup was restored from stale snapshot):

```bash
# Detect default branch dynamically
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||')
if [ -z "$DEFAULT_BRANCH" ]; then
  if git rev-parse --verify master >/dev/null 2>&1; then DEFAULT_BRANCH="master"
  elif git rev-parse --verify main >/dev/null 2>&1; then DEFAULT_BRANCH="main"
  else DEFAULT_BRANCH="master"; fi
fi

# For each in_progress issue, check if its PR was already merged
bd list --status=in_progress --json 2>/dev/null | jq -r '.[].id' | while read id; do
  # Search git log for the issue ID in commit messages
  if git log --oneline --first-parent "$DEFAULT_BRANCH" --fixed-strings --grep="$id" | grep -q .; then
    echo "STALE: $id — found in git history, likely already merged"
  fi
done
```

If stale issues are found, close them:
```bash
bd close <id> --force --reason="Already merged — detected during status reconciliation"
```

### Step 2: Review Recent Commits
```bash
git log --oneline -10
```

### Step 3: Determine Context
- **New feature**: No active work, ready to start fresh
- **Continuing work**: In-progress issues found, resume where left off
- **Review needed**: Work marked complete, needs review/merge

## Next Steps

- **If starting new work**: Run `/plan <feature-name>`
- **If continuing work**: Resume with appropriate phase command
- **If reviewing**: Run `/review <pr-number>` or `/premerge <pr-number>`
