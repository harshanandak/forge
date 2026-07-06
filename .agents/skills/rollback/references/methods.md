# Rollback methods (reference)

Detailed walkthroughs for each rollback method. Read the one you need; the skill body summarizes them.

## Rollback Methods

### 1. Rollback Last Commit

**Use when**: Quick undo of most recent change

**How it works**:
```bash
git revert HEAD --no-edit
```

**Example**:
```bash
bunx forge rollback
# Select: 1. Rollback last commit

✓ Working directory is clean
✓ Extracting USER sections...
✓ Executing: git revert HEAD --no-edit
✓ Restoring USER sections...
✓ Amended commit to preserve USER content

Rollback complete!
  Commit: a1b2c3d "Revert: add authentication feature"
  Files affected: 5
```

### 2. Rollback Specific Commit

**Use when**: Need to revert a commit from earlier in history

**How it works**:
```bash
git revert <commit-hash> --no-edit
```

**Example**:
```bash
bunx forge rollback
# Select: 2. Rollback specific commit
# Enter: a1b2c3d

✓ Validating commit hash...
✓ Working directory is clean
✓ Extracting USER sections...
✓ Executing: git revert a1b2c3d --no-edit
✓ Restoring USER sections...
✓ Amended commit to preserve USER content

Rollback complete!
  Commit: x9y8z7w "Revert: a1b2c3d"
  Files affected: 8
```

**Input validation**:
- Accepts 4-40 character hex strings
- Accepts 'HEAD'
- Rejects shell metacharacters
- Rejects invalid formats

### 3. Rollback Merged PR

**Use when**: Need to revert an entire merged pull request

**How it works**:
```bash
git revert -m 1 <merge-commit-hash> --no-edit
```

**Example**:
```bash
bunx forge rollback
# Select: 3. Rollback merged PR
# Enter: def456 (merge commit hash)

✓ Validating commit hash...
✓ Working directory is clean
✓ Extracting USER sections...
✓ Executing: git revert -m 1 def456 --no-edit
✓ Restoring USER sections...
✓ Amended commit to preserve USER content
✓ Beads integration: Issue #123 marked as 'reverted'

Rollback complete!
  Commit: m1n2o3p "Revert: Merge pull request #123"
  Files affected: 15
  Beads issue: #123 status → reverted
```

**Beads Integration**:
- Parses commit message for issue number (`#123`)
- If found, runs: `forge update <id> --status reverted --comment "PR reverted"`
- Silently skips if Beads not installed
- Updates issue tracking automatically

### 4. Rollback Specific Files

**Use when**: Only certain files need to be restored

**How it works**:
```bash
git checkout HEAD~1 -- <file1> <file2> ...
git commit -m "chore: rollback <files>"
```

**Example**:
```bash
bunx forge rollback
# Select: 4. Rollback specific files
# Enter: AGENTS.md,CLAUDE.md

✓ Validating file paths...
✓ Working directory is clean
✓ Extracting USER sections...
✓ Executing: git checkout HEAD~1 -- AGENTS.md CLAUDE.md
✓ Committing changes...
✓ Restoring USER sections...
✓ Amended commit to preserve USER content

Rollback complete!
  Commit: q4r5s6t "chore: rollback AGENTS.md, CLAUDE.md"
  Files affected: 2
```

**Path validation**:
- Comma-separated file paths
- Validates paths are within project root
- Prevents path traversal (`../../../etc/passwd`)
- Rejects shell metacharacters
- Uses `path.resolve()` + `startsWith()` check

### 5. Rollback Entire Branch

**Use when**: Need to revert a range of commits

**How it works**:
```bash
git revert <start-commit>..<end-commit> --no-edit
```

**Example**:
```bash
bunx forge rollback
# Select: 5. Rollback entire branch
# Enter: abc123..def456

✓ Validating commit range...
✓ Working directory is clean
✓ Extracting USER sections...
✓ Executing: git revert abc123..def456 --no-edit
✓ Restoring USER sections...
✓ Amended commit to preserve USER content

Rollback complete!
  Commits reverted: 7
  Files affected: 24
```

**Range validation**:
- Format: `start..end`
- Both commits must be valid hashes (4-40 chars)
- Rejects invalid formats
- Checks for `..` separator

### 6. Preview Rollback (Dry Run)

**Use when**: Want to see what would change without executing

**How it works**:
- Prompts for method and target
- Validates inputs
- Shows affected files
- No git operations performed

**Example**:
```bash
bunx forge rollback
# Select: 6. Preview rollback (dry run)
# Enter method: partial
# Enter target: AGENTS.md,package.json

✓ Validating inputs...
✓ DRY RUN MODE - No changes will be made

Preview of rollback:
  Method: partial
  Target: AGENTS.md, package.json

  Files that would be affected:
    - AGENTS.md
    - package.json

  USER sections that would be preserved:
    - AGENTS.md: 2 sections

  Custom commands that would be preserved:
    - .claude/commands/custom/my-workflow.md

No changes made (dry run).
```
