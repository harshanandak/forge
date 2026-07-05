# Rollback: workflow integration, issue status & troubleshooting (reference)

## Integration with Workflow

### When to Use Rollback

**During Development** (`/dev`):
- Implemented wrong approach
- Tests reveal fundamental issues
- Need to start over with different strategy

**After Shipping** (`/ship`):
- PR feedback requires complete redesign
- CI/CD failures indicate architecture problems
- Breaking changes need to be reverted

**After Merging** (pre-merge gate + user merge):
- Production issues discovered
- Need to revert feature entirely
- Rollback PR merge commit

**Recovery Scenarios**:
- Accidentally committed sensitive data (rollback + force push)
- Merge conflict resolution went wrong
- Refactor broke existing functionality

### Workflow Integration

```bash
# Standard workflow
/status → /plan → /dev → /validate → /ship → /review → /verify   (pre-merge doc gate runs inside /ship and /review)

# Recovery workflow
/dev → (issues discovered) → bunx forge rollback → /dev (retry)
/ship → (CI fails) → bunx forge rollback → /dev (fix) → /ship
/verify → (production issues) → bunx forge rollback → /plan (redesign)
```

### Example: Failed Feature Implementation

```bash
# 1. Development phase - implement feature
/dev
# ... implementation ...
git commit -m "feat: add payment integration"

# 2. Check phase - tests fail
/validate
# ERROR: Security vulnerability in payment handling

# 3. Rollback the implementation
bunx forge rollback
# Select: 1. Rollback last commit

# 4. Plan with security in mind
/plan payment-integration

# 5. Implement correctly
/dev
# ... proper implementation with security ...

# 6. Verify and ship
/validate → /ship
```

## Beads Integration

If Beads is installed (`bunx forge setup`), rollback automatically updates issue tracking.

### PR Rollback → Issue Status

When rolling back a merged PR:
1. Parse commit message for issue number (`#123`, `fixes #456`, etc.)
2. If issue number found:
   ```bash
   forge update <id> --status reverted --comment "PR reverted by rollback"
   ```
3. Silently skip if:
   - Beads not installed
   - No issue number in commit message
   - Issue doesn't exist

### Manual Beads Update

If automatic detection doesn't work:
```bash
# After rollback
forge update 123 --status reverted --comment "Rolled back due to production issues"
```

## Troubleshooting

### Error: "Working directory not clean"

**Cause**: Uncommitted changes in working directory

**Solution**:
```bash
# Option 1: Commit changes
git add .
git commit -m "wip: current work"

# Option 2: Stash changes
git stash

# Then retry rollback
bunx forge rollback
```

### Error: "Invalid commit hash format"

**Cause**: Commit hash doesn't match required pattern

**Valid formats**:
- `HEAD` (special keyword)
- `a1b2c3d` (4-40 character hex string)
- `abc123def456` (longer hash)

**Invalid formats**:
- `abc;rm -rf /` (contains shell metacharacter)
- `12` (too short, < 4 chars)
- `not-a-hash` (not hexadecimal)

**Solution**:
```bash
# Get valid commit hash
git log --oneline
# Copy full or abbreviated hash (4+ chars)
```

### Error: "Path outside project"

**Cause**: File path resolves to outside project root

**Examples**:
- `../../../etc/passwd` (path traversal)
- `/absolute/path/outside/project`

**Solution**:
```bash
# Use relative paths within project
bunx forge rollback
# Select: 4. Rollback specific files
# Enter: src/auth.js,docs/API.md (relative paths)
```

### Error: "Invalid characters in path"

**Cause**: File path contains shell metacharacters

**Rejected characters**: `;`, `|`, `&`, `$`, `` ` ``, `(`, `)`, `<`, `>`, `\n`, `\r`

**Solution**:
```bash
# Remove special characters from filename
mv "file;name.js" "filename.js"

# Or escape properly (not recommended)
```

### Error: "Branch range must use format: start..end"

**Cause**: Branch range doesn't include `..` separator

**Valid formats**:
- `abc123..def456`
- `a1b2c3d..x9y8z7w`

**Invalid formats**:
- `abc123-def456` (wrong separator)
- `abc123` (no range)

**Solution**:
```bash
# Use correct format
bunx forge rollback
# Select: 5. Rollback entire branch
# Enter: <start-commit>..<end-commit>
```

### Merge Conflicts During Rollback

**Cause**: Revert conflicts with subsequent changes

**Solution**:
```bash
# 1. Rollback creates conflict markers
git status
# On branch: main
# Unmerged paths:
#   both modified: src/auth.js

# 2. Resolve conflicts manually
# Edit src/auth.js, remove markers

# 3. Complete the revert
git add src/auth.js
git revert --continue

# 4. USER sections restored automatically
```

### USER Sections Not Restored

**Cause**: Markers missing or malformed

**Check markers**:
```bash
grep -n "USER:START" AGENTS.md
grep -n "USER:END" AGENTS.md
```

**Valid markers**:
```markdown
<!-- USER:START -->
Content
<!-- USER:END -->

<!-- USER:START:name -->
Named section
<!-- USER:END:name -->
```

**Invalid markers**:
```markdown
<!-- USER START --> (missing colon)
<!-- USER:START (missing closing -->)
<!-- USER:END --> (no matching START)
```

**Solution**:
```bash
# Fix markers before rollback
# Ensure all USER:START have matching USER:END
```

## Safety Notes

### Input Validation

All inputs are validated **before** use in git commands:

**Commit hashes**:
```javascript
if (target !== 'HEAD' && !/^[0-9a-f]{4,40}$/i.test(target)) {
  return { valid: false, error: 'Invalid commit hash format' };
}
```

**File paths**:
```javascript
const resolved = path.resolve(projectRoot, file);
if (!resolved.startsWith(projectRoot)) {
  return { valid: false, error: 'Path outside project' };
}
```

**Shell metacharacters**:
```javascript
if (/[;|&$`()<>\r\n]/.test(file)) {
  return { valid: false, error: 'Invalid characters in path' };
}
```

### Non-Destructive Operations

**Uses**:
- `git revert` (creates new commit, preserves history)
- `git checkout HEAD~1 -- <files>` (restores specific files)

**Never uses**:
- `git reset --hard` (destroys commits)
- `git push --force` (overwrites remote)
- `git clean -f` (deletes untracked files)

### Data Preservation

**Always preserved**:
- USER sections in all files
- Custom commands in `.claude/commands/custom/`
- Git history (revert creates new commits)
- Untracked files (not affected)

**Never lost**:
- Your customizations
- Work in progress (if committed/stashed)
- Remote branches (local operation only)

### Recommended Workflow

```bash
# 1. Always commit work before rollback
git add .
git commit -m "wip: current state"

# 2. Use dry run to preview
bunx forge rollback
# Select: 6. Preview rollback (dry run)

# 3. Execute rollback
bunx forge rollback
# Select appropriate method

# 4. Verify USER sections preserved
grep -A5 "USER:START" AGENTS.md

# 5. Push if needed (after verification)
git push
```

## Examples

### Example 1: Quick Undo Last Commit

```bash
# Scenario: Just committed but realized approach is wrong

git log --oneline
# abc123d (HEAD) feat: add caching layer
# def456e fix: validation bug

bunx forge rollback
# 1. Rollback last commit

# Output:
# ✓ Working directory is clean
# ✓ Extracting USER sections...
# ✓ Executing: git revert HEAD --no-edit
# ✓ Restoring USER sections...
# ✓ Rollback complete!

git log --oneline
# xyz789f (HEAD) Revert: feat: add caching layer
# abc123d feat: add caching layer
# def456e fix: validation bug
```

### Example 2: Revert Merged PR

```bash
# Scenario: PR #123 caused production issues

git log --oneline
# merge789 (HEAD) Merge pull request #123
# feat456a feat: add real-time updates
# bugfix123 fix: websocket connection

bunx forge rollback
# 3. Rollback merged PR
# Enter: merge789

# Output:
# ✓ Validating commit hash...
# ✓ Working directory is clean
# ✓ Extracting USER sections...
# ✓ Executing: git revert -m 1 merge789 --no-edit
# ✓ Restoring USER sections...
# ✓ Beads: Issue #123 → status: reverted
# ✓ Rollback complete!

forge show 123
# ID: 123
# Title: Add real-time updates
# Status: reverted
# Comments:
#   - PR reverted by rollback
```

### Example 3: Restore Specific Files

```bash
# Scenario: Accidentally updated wrong files in last commit

git show HEAD --name-only
# commit abc123
# feat: update documentation
#   AGENTS.md (should not have changed)
#   docs/API.md
#   README.md

bunx forge rollback
# 4. Rollback specific files
# Enter: AGENTS.md

# Output:
# ✓ Validating file paths...
# ✓ Working directory is clean
# ✓ Extracting USER sections...
# ✓ Executing: git checkout HEAD~1 -- AGENTS.md
# ✓ Committing changes...
# ✓ Restoring USER sections...
# ✓ Rollback complete!
#   Files affected: 1

git status
# On branch: main
# nothing to commit, working tree clean
# (AGENTS.md restored to previous version)
```

### Example 4: Dry Run Preview

```bash
# Scenario: Want to see what rollback would do

bunx forge rollback
# 6. Preview rollback (dry run)
# Method: commit
# Target: HEAD

# Output:
# ✓ Validating inputs...
# ✓ DRY RUN MODE - No changes will be made
#
# Preview of rollback:
#   Method: commit
#   Target: HEAD
#
#   Files that would be affected:
#     - src/auth/middleware.js
#     - src/auth/validators.js
#     - tests/auth.test.js
#
#   USER sections that would be preserved:
#     - AGENTS.md: 2 sections
#     - CLAUDE.md: 1 section
#
#   Custom commands that would be preserved:
#     - .claude/commands/custom/deploy.md
#
# No changes made (dry run).

# Decision: Proceed with rollback
bunx forge rollback
# 1. Rollback last commit
```

## See Also

- [/dev](.claude/commands/dev.md) - TDD development workflow
- [/validate](.claude/commands/validate.md) - Validation before shipping
- [AGENTS.md](../../AGENTS.md) - Complete workflow guide
- [Beads](https://github.com/beadshq/beads) - Issue tracking integration
