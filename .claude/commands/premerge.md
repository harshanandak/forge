---
description: Complete all doc updates on feature branch, then hand off PR to user for merge
---

Prepare the pull request for merge by completing ALL documentation updates on the feature branch, then hand off to the user.

# Premerge

**The actual merge is always done by the user in the GitHub UI — never by this command.**

This command makes the PR 100% complete: code + tests + docs in one unit. After this, the user merges once and there are no follow-up doc PRs needed.

## Usage

```bash
/premerge <pr-number>
```

## What This Command Does

### Step 1: Verify All CI Checks Pass

```bash
gh pr checks <pr-number>
```

All checks must be green before proceeding. If any fail, run `/review <pr-number>` first.

### Step 2: Warn If Branch Is Behind Master

```bash
gh pr view <pr-number> --json baseRefName,headRefName
git fetch origin master
git status
```

If the feature branch is behind `master`, tell the user to rebase first:

```
⚠️  Branch is behind master — rebase before updating docs to avoid conflicts:
    git rebase origin/master
    git push --force-with-lease
```

### Step 3: Update ALL Relevant Documentation (on feature branch)

Check each of the following and update if the feature affects it. Be selective — only update what genuinely changed.

**A. `docs/planning/PROGRESS.md`** (always):
- Add feature entry to completed section:
  - Feature name, completion date, Beads ID, PR number, research doc link
  - Key deliverables and files changed
- Note: `docs/planning/` is gitignored — update locally only, no commit needed

**B. `README.md`** (if user-facing changes):
- Features list, configuration options, usage examples

**C. `docs/reference/API_REFERENCE.md`** (if API changes):
- New endpoints, request/response schemas, authentication

**D. Architecture docs** (if structural changes):
- `docs/architecture/` diagrams, decision records (ADRs)

**E. `CLAUDE.md` — USER section only** (if project conventions changed):
```
<!-- USER:START - Add project-specific learnings here as you work -->
...update only between these markers...
<!-- USER:END -->
```
⚠️  NEVER touch `<!-- OPENSPEC:START/END -->` or other managed blocks.

**F. `AGENTS.md`** (if agent config, skills, or cross-agent workflow changed):
- Update relevant sections describing agent capabilities or workflow

**G. `docs/WORKFLOW.md`** (if the workflow itself changed):
- Update stage descriptions or workflow tables

**Commit doc updates to feature branch**:

```bash
git add README.md docs/ AGENTS.md CLAUDE.md
git commit -m "docs: update documentation for <feature-name>

- Updated: [list files changed]
- Reason: [brief explanation]"

git push
```

⚠️  **After pushing**: CI will re-trigger (Greptile, SonarCloud, etc.). Wait for checks to pass. If new Greptile comments appear on the doc changes, run `/review <pr-number>` again.

### Step 4: Archive OpenSpec (if strategic)

```bash
openspec archive <feature-slug> --yes
```

Only run if this feature had an OpenSpec proposal.

### Step 5: Sync Beads

```bash
bd sync
```

### Step 6: Hand Off — STOP HERE

**DO NOT run `gh pr merge`.** Present the PR and wait for the user to merge.

Output:

```
✅ PR #<number> is ready to merge

  All checks: ✓ passing
  Documentation: ✓ updated on feature branch
  Beads: ✓ synced
  OpenSpec: ✓ archived (if applicable)

  👉 Please merge in the GitHub UI:
     https://github.com/<owner>/<repo>/pull/<number>

  Recommended: Squash and merge (keeps main history clean)

After you merge, run /verify to confirm everything landed correctly.
```

## Example Output

```
✓ CI checks: All passing
✓ Branch: Up to date with master
✓ Documentation updated:
  - PROGRESS.md: Feature entry added (local only)
  - README.md: Features list updated
  - CLAUDE.md: USER section updated with new pattern
  - Committed: docs: update documentation for auth-refresh
✓ CI re-triggered after doc push — all checks still passing
✓ Beads synced

✅ PR #89 is ready to merge

  👉 Please merge in the GitHub UI:
     https://github.com/harshanandak/forge/pull/89

After you merge, run /verify
```

## Rules

- **NEVER run `gh pr merge`** — blocked by PreToolUse hook in `.claude/settings.json`
- **CLAUDE.md USER section only** — never touch managed blocks (`OPENSPEC:START/END`)
- **Warn if branch is behind** — tell user to rebase before doc updates
- **Re-check CI after doc push** — doc commits re-trigger full CI pipeline
- **One PR, complete** — code + tests + docs merged together, no follow-up doc PRs

## Integration with Workflow

```
1. /status               → Understand current context
2. /research <name>      → Research and document
3. /plan <feature-slug>  → Create plan and tracking
4. /dev                  → Implement with TDD
5. /check                → Validate
6. /ship                 → Create PR
7. /review               → Address comments
8. /premerge             → Complete docs, hand off to user (you are here)
9. /verify               → Post-merge health check
```
