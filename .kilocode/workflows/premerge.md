---
description: Complete all doc updates on feature branch, then hand off PR to user for merge
mode: code
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

**A. `CHANGELOG.md`** (always):
- Add entry under `## [Unreleased]` heading (create heading if not present)
- Use [Keep a Changelog](https://keepachangelog.com/) categories:
  - **Added**: New features
  - **Changed**: Changes to existing functionality
  - **Fixed**: Bug fixes
  - **Removed**: Removed features
- Include: feature name, PR number, Beads ID
- Example:
  ```markdown
  ## [Unreleased]

  ### Added
  - Authentication refresh tokens (PR #89, forge-a3f8)
  ```

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
⚠️  NEVER touch other managed blocks (e.g., `<!-- AGENT:START/END -->`).

**F. `AGENTS.md`** (if agent config, skills, or cross-agent workflow changed):
- Update relevant sections describing agent capabilities or workflow

**G. `docs/WORKFLOW.md`** (if the workflow itself changed):
- Update stage descriptions or workflow tables

**Commit doc updates to feature branch**:

```bash
git add CHANGELOG.md README.md docs/ AGENTS.md CLAUDE.md
git commit -m "docs: update documentation for <feature-name>

- Updated: [list files changed]
- Reason: [brief explanation]"

git push
```

⚠️  **After pushing**: CI will re-trigger (Greptile, SonarCloud, etc.). Wait for checks to pass. If new Greptile comments appear on the doc changes, run `/review <pr-number>` again.

### Step 4: Sync Beads

```bash
bd sync
```

### Step 5: Hand Off — STOP HERE

**DO NOT run `gh pr merge`.** Present the PR and wait for the user to merge.

Output:

```
✅ PR #<number> is ready to merge

  All checks: ✓ passing
  Documentation: ✓ updated on feature branch
  Beads: ✓ synced

  👉 Please merge in the GitHub UI:
     https://github.com/<owner>/<repo>/pull/<number>

  Recommended: Squash and merge (keeps main history clean)

After you merge, run /verify to confirm everything landed correctly.
```

```
<HARD-GATE: /premerge exit>
Do NOT run gh pr merge.
Do NOT suggest merging.
/premerge ends here. Output the PR URL and status. Wait for user.

"After you merge, run /verify to confirm everything landed correctly."
</HARD-GATE>
```

## Example Output

```
✓ CI checks: All passing
✓ Branch: Up to date with master
✓ Documentation updated:
  - CHANGELOG.md: Entry added under [Unreleased]
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
- **CLAUDE.md USER section only** — never touch other managed blocks
- **Warn if branch is behind** — tell user to rebase before doc updates
- **Re-check CI after doc push** — doc commits re-trigger full CI pipeline
- **One PR, complete** — code + tests + docs merged together, no follow-up doc PRs

## Integration with Workflow

```
Utility: /status     → Understand current context before starting
Stage 1: /plan       → Design intent → research → branch + worktree + task list
Stage 2: /dev        → Implement each task with subagent-driven TDD
Stage 3: /validate      → Type check, lint, tests, security — all fresh output
Stage 4: /ship       → Push + create PR
Stage 5: /review     → Address GitHub Actions, Greptile, SonarCloud
Stage 6: /premerge   → Update docs, hand off PR to user (you are here)
Stage 7: /verify     → Post-merge CI check on main
```
