---
name: rollback
description: >
  Safely revert or undo a change that is already committed or shipped, using non-destructive
  `git revert` (never `reset --hard`, `push --force`, or `clean`). Drives the interactive
  `bunx forge rollback` menu: undo the last commit, revert a commit by hash, revert a merged
  PR (git revert -m 1), restore individual files to a prior version, revert a commit range, or
  dry-run/preview first. Use when the user says roll back, revert, undo, back out, or restore
  — e.g. "undo the last commit", "undo that change, the approach was wrong", "back out PR
  #123", "revert the merge commit", "restore src/auth.js to before my last commit", or when a
  shipped/merged change broke something and must be pulled back. Do NOT use for: replying to
  or fixing PR review feedback (review), monitoring an open PR's checks toward merge
  (shepherd), the post-merge CI health check on master (verify), pushing a branch or opening a
  PR (ship), or ordinary issue status/field edits (issue-basics).
allowed-tools: Bash, Read, Edit, Grep, Glob
terminal: true
---

Comprehensive rollback system with multiple methods and automatic USER content preservation.

# Rollback

This skill provides safe rollback operations with comprehensive validation and USER section preservation.

## Usage

```bash
bunx forge rollback
```

Interactive menu with 6 options:
1. **Rollback last commit** - Quick undo of most recent change
2. **Rollback specific commit** - Target any commit by hash
3. **Rollback merged PR** - Revert an entire PR merge
4. **Rollback specific files** - Restore only certain files
5. **Rollback entire branch** - Revert multiple commits
6. **Preview rollback** - Dry run mode (shows changes without executing)

## How It Works

### Safety Features

**1. Working Directory Check**
- Requires clean working directory (no uncommitted changes)
- Prevents accidental data loss
- Prompts to commit or stash changes first

**2. Input Validation**
- Commit hashes: Must match `/^[0-9a-f]{4,40}$/i` or be 'HEAD'
- File paths: Validated to be within project (prevents path traversal)
- Methods: Whitelisted to 'commit', 'pr', 'partial', 'branch'
- Shell metacharacters: Rejected (`;`, `|`, `&`, `$`, `` ` ``, `(`, `)`, `<`, `>`, `\n`, `\r`)

**3. USER Section Preservation**
- Automatically extracts USER sections before rollback
- Restores USER sections after rollback
- Preserves custom commands in `.claude/commands/custom/`
- Amends rollback commit to include restored content

**4. Dry Run Mode**
- Preview affected files without executing
- Shows what would change
- No git operations performed

**5. Non-Destructive**
- Uses `git revert` (creates new commit)
- Never uses `git reset --hard` (destructive)
- Preserves full git history
- Can be undone with another rollback

### USER Section Preservation

**What Gets Preserved**:
```markdown
<!-- USER:START -->
Your custom content here
<!-- USER:END -->

<!-- USER:START:custom-name -->
Named USER section
<!-- USER:END:custom-name -->
```

**Process**:
1. Extract all USER sections from AGENTS.md, CLAUDE.md, etc.
2. Backup custom commands from `.claude/commands/custom/`
3. Execute rollback operation
4. Restore USER sections to current file content
5. Restore custom command files
6. Amend rollback commit to include restored content

**Result**: Your customizations survive rollback operations.

## Rollback methods

Six methods, selected interactively. Full step-by-step walkthroughs (commands,
prompts, expected output) are in [references/methods.md](references/methods.md) —
read it when running a specific rollback.

1. **Rollback last commit** — undo the most recent commit.
2. **Rollback specific commit** — revert one commit by hash.
3. **Rollback merged PR** — revert a merge commit.
4. **Rollback specific files** — restore named files from the previous commit.
5. **Rollback entire branch** — reset a range.
6. **Preview (dry run)** — show what a rollback would do, change nothing.

## Integration, issue status & troubleshooting

When to reach for rollback, how it fits the workflow, how revert state is recorded,
and error recovery are in
[references/workflow-integration.md](references/workflow-integration.md).
