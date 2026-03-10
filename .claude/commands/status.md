---
description: Check current stage and context
---

Check where you are in the project and what work is in progress.

# Status Check

This command helps you understand the current state of the project before starting new work.

## Usage

```bash
/status
```

## What This Command Does

### Step 1: Check Project Health
```bash
bd stats
```
- How many open / in-progress / completed issues?
- Any blocked issues?

### Step 2: Check Active Work
```bash
# Active Beads issues
bd list --status in_progress
```

### Step 3: Review Recent Work
```bash
# Recent commits
git log --oneline -10

# Recently completed Beads
bd list --status completed --limit 5
```

### Step 4: Determine Context
- **New feature**: No active work, ready to start fresh
- **Continuing work**: In-progress issues found, resume where left off
- **Review needed**: Work marked complete, needs review/merge

## Example Output

```
✓ Project Health: 3 open, 1 in-progress, 12 completed

Active Work:
  - forge-ctc: Clean up stale workflow refs (in_progress)

Recent Completions:
  - forge-uto: Sync AGENTS.md with agent cleanup (closed 2 days ago)
  - forge-abc: Auth refresh tokens (closed 5 days ago)

Context: Ready for new feature

Next: /plan <feature-name>
```

## Next Steps

- **If starting new work**: Run `/plan <feature-name>`
- **If continuing work**: Resume with appropriate phase command
- **If reviewing**: Run `/review <pr-number>` or `/premerge <pr-number>`
