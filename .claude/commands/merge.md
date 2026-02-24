---
description: Update docs, prep PR for merge, archive proposals, and clean up — merge is done by the user
---

Update project documentation, prepare the PR for merge, archive proposals, and clean up.

# Merge

This command prepares everything for merge. **The actual merge is always done by the user in the GitHub UI — never by this command.**

## Usage

```bash
/merge <pr-number>
```

## What This Command Does

### Step 1: Final Verification
```bash
gh pr checks <pr-number>  # Ensure all checks pass
gh pr view <pr-number> --json reviewDecision  # Check approval status
```

### Step 2: Update Project Documentation (BEFORE merge)

**A. Update PROGRESS.md**:
```bash
# Add feature to completed list with:
# - Feature name
# - Completion date
# - Beads issue ID
# - PR number
# - Research doc link
```

**B. Update API_REFERENCE.md** (if API changes):
```bash
# Document:
# - New endpoints
# - Request/response schemas
# - Authentication requirements
# - Example requests
```

**C. Update Architecture docs** (if strategic):
```bash
# Update:
# - docs/architecture/ diagrams
# - New patterns introduced
# - System architecture overview
# - Decision records (ADRs) if applicable
```

**D. Update README.md** (if user-facing):
```bash
# Update:
# - Features list
# - Configuration options
# - Installation/setup steps
# - Usage examples
```

**E. Update Testing docs** (if new patterns):
```bash
# Document:
# - New test utilities
# - Testing strategy
# - Examples
```

**F. Commit documentation updates**:
```bash
git add docs/ README.md
git commit -m "docs: update project documentation for <feature-name>

- Updated PROGRESS.md: Marked <feature> as complete
- Updated API_REFERENCE.md: Added <endpoints> (if applicable)
- Updated architecture docs: <changes> (if applicable)
- Updated README.md: <changes> (if applicable)

Closes: <beads-id>
See: docs/research/<feature-slug>.md"

git push
```

### Step 3: Archive OpenSpec (if strategic)
```bash
openspec archive <feature-slug> --yes
```

### Step 4: Sync Beads
```bash
bd sync
```

### Step 5: Hand off to user — STOP HERE

**DO NOT run `gh pr merge`.** Present the PR as ready and wait for the user to merge.

Output a clear summary like:

```
✅ PR #<number> is ready to merge

  All checks: ✓ passing
  Documentation: ✓ updated
  Beads: ✓ synced
  OpenSpec: ✓ archived (if applicable)

  👉 Please merge in the GitHub UI:
     https://github.com/<owner>/<repo>/pull/<number>

  Merge options:
  - Squash and merge (recommended — keeps main history clean)
  - Create a merge commit

After you merge, run /verify to cross-check documentation.
```

### Step 6: After user merges — cleanup

Once the user confirms merge is done:

```bash
git checkout master
git pull
```

## Example Output

```
✓ Documentation Updates:
  - docs/planning/PROGRESS.md: Feature marked complete
  - docs/reference/API_REFERENCE.md: 3 new endpoints documented
  - README.md: Billing features added
  - Committed: docs: update project documentation

✓ PR checks: All passing
✓ Beads synced
✓ OpenSpec archived: openspec/changes/stripe-billing/ (if strategic)

✅ PR #123 is ready to merge

  👉 Please merge in the GitHub UI:
     https://github.com/harshanandak/forge/pull/123

After you merge, run /verify to cross-check documentation.
```

## Integration with Workflow

```
1. /status               → Understand current context
2. /research <name>      → Research and document
3. /plan <feature-slug>  → Create plan and tracking
4. /dev                  → Implement with TDD
5. /check                → Validate
6. /ship                 → Create PR
7. /review               → Address comments
8. /merge                → Prep for merge, hand off to user (you are here)
9. /verify               → Final documentation check (after user merges)
```

## Rules

- **NEVER run `gh pr merge`** — this is blocked by a PreToolUse hook in `.claude/settings.json`
- **Merging is the user's decision** — always present the PR URL and stop
- **Update docs BEFORE handing off**: All documentation must be current before telling the user to merge
- **Archive OpenSpec**: Strategic proposals get archived before handoff
- **Sync Beads**: Ensure Beads database is up-to-date before handoff
