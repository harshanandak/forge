
Check where you are in the project and what work is in progress.

# Status Check

This command helps you understand the current state of the project before starting new work.

## Usage

```bash
/status
```

## What This Command Does

### Step 1: Smart Status (Issues ranked by priority)
```bash
bash scripts/smart-status.sh
```
- Shows issues grouped by status (in-progress, open, completed)
- Ranked by priority within each group (blocked first, then by staleness/age)
- Includes task progress and last commit for each issue

Hint: `bd show <id>` for full context on any issue.

### Step 2: Review Recent Commits
```bash
git log --oneline -10
```

### Step 3: Determine Context
- **New feature**: No active work, ready to start fresh
- **Continuing work**: In-progress issues found, resume where left off
- **Review needed**: Work marked complete, needs review/merge

## Example Output

```
=== IN PROGRESS (1) ===
  forge-ctc  Clean up stale workflow refs
    3/7 tasks done | Last: Validation logic (def5678)

=== OPEN (3) ===
  forge-xyz  Add retry logic to API client
  forge-pqr  Refactor config loader
  forge-mno  Update CI pipeline

=== RECENTLY COMPLETED (2) ===
  forge-uto  Sync AGENTS.md with agent cleanup
  forge-abc  Auth refresh tokens

Recent commits:
  abc1234 feat: add retry logic
  def5678 test: validation tests

Context: Continuing work

Next: Resume with /dev or /validate (check issue status)
```

## Next Steps

- **If starting new work**: Run `/plan <feature-name>`
- **If continuing work**: Resume with appropriate phase command
- **If reviewing**: Run `/review <pr-number>` or `/premerge <pr-number>`
