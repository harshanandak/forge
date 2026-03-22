---
name: status
description: Check current stage and context
tools: []
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
