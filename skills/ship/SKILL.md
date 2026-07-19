---
name: ship
description: >
  Forge SHIP stage: push the validated feature branch and open a PR populated from the
  project's OWN PR template (design-doc link, Forge issue IDs, real test/commit data), then
  hand off for MANUAL merge; never merges or auto-merges. Use once /validate passes and you
  want a PR on the board. Triggers: "ship it", "ship this branch", "open the PR", "push and
  open a PR", "gh pr create", "checks passed, now cut the PR". Runs branch-freshness +
  parallel-PR merge-sim checks, force-with-lease push, records the ship->review handoff, then
  stops. One stage only; not for: the whole plan->dev->validate->ship->review pipeline or
  drive-to-done (smith); type-check/lint/tests/security first (validate); addressing PR
  comments or resolving Greptile/SonarCloud/CodeRabbit threads on an existing PR (review);
  babysitting an open PR toward merge (shepherd); post-merge CI health check + closing issues
  (verify); reverting an already-shipped change (rollback). If the PR already exists, this is
  not the skill.
allowed-tools: Bash, Read, Edit, Grep, Glob
next: review
terminal: false
handoffs:
  - shepherd
---

Push code and create a pull request with full context and documentation links.

# Ship

> **Chain (HARD-GATE):** the successor depends on the change classification (source of truth: lib/workflow/stages.js) — Standard → `review`; Critical → `review` → `verify`; Simple/Hotfix/Refactor/Docs END at `ship`. `review` is the default/critical-path next; `shepherd` may monitor the PR's checks. `ship` never merges.

This skill creates a PR after validation passes.

## Usage

```bash
/ship
```

```
<HARD-GATE: /ship entry>
Do NOT create PR until:
1. /validate was run in this session with all four outputs shown (type, lint, tests, security)
2. All checks confirmed passing — not assumed, not "was passing earlier"
3. Forge issue is in_progress (`forge issue show <id>` confirms status)
4. git branch --show-current output is NOT main or master
</HARD-GATE>
```

## What This Skill Does

### Step 1: Verify /validate Passed
Ensure all four validation checks completed successfully with fresh output in this session.

### Step 2: Freshness Check — Is Branch Still Current?

Even though /validate rebased onto the base branch, time may have passed since then (user reviewed design doc, took a break, etc.). This lightweight check catches staleness before pushing.

```bash
BASE=$(git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}')
if [ -z "$BASE" ] || [ "$BASE" = "(unknown)" ]; then BASE="master"; fi
git fetch origin "$BASE" || { echo "✗ Fetch failed — cannot verify freshness"; exit 1; }
BEHIND=$(git rev-list --count HEAD..origin/"$BASE")
```

- If `BEHIND > 0`: **STOP**. Print: "$BASE has advanced since /validate ($BEHIND new commits). Run /validate again to rebase and re-check."
- If `BEHIND = 0`: Continue to push.
- If fetch fails: the `|| { ...; exit 1; }` guard catches this — **STOP**. Do NOT push without confirming freshness.

This is NOT a full rebase — just a check. The rebase happens in /validate where the full test suite runs afterward.

### Parallel PR coordination (soft block)

Before creating the PR, check merge readiness:

```bash
# Run merge simulation against base branch
bash scripts/pr-coordinator.sh merge-sim "$(git branch --show-current)" 2>&1

# Show recommended merge order
bash scripts/pr-coordinator.sh merge-order 2>&1 || true

# Auto-label the PR after creation (called after gh pr create below)
# bash scripts/pr-coordinator.sh auto-label <issue-id>
```

If merge simulation finds conflicts:
- Display conflicted files
- Ask: "Merge conflicts detected with base branch. These PRs should merge first: [list]. Proceed with PR creation anyway? (y/n)"
- If `n`: exit cleanly
- If `y`: log override via `forge comment <id> "Ship override: creating PR despite merge conflicts"`, then continue

After PR creation completes:
```bash
# Auto-label the newly created PR
bash scripts/pr-coordinator.sh auto-label <issue-id>

# Check for stale worktrees (informational)
bash scripts/pr-coordinator.sh stale-worktrees 2>&1 || true
```

### Step 3: Record PR Handoff
```bash
forge comment <id> "PR created: <pr-url>. Awaiting review and merge verification."
forge sync
```

Do not mark the Forge issue done during `/ship`. Completion happens only after merge and post-merge verification.

### Step 4: Push Branch

Use `--force-with-lease` because `/validate` may have rebased the branch, rewriting history. This is safe: it only forces the push if the remote branch hasn't been updated by someone else since the last fetch.

```bash
git push --force-with-lease -u origin <branch-name>
```

### Step 5: Create PR Using Project's PR Template

**CRITICAL**: Always use the project's own PR template. Never use a hardcoded body.

**Step 5a: Locate the PR template**

Check for a PR template in the project (in order of precedence):
```bash
# Check standard locations
PR_TEMPLATE=""
for path in .github/pull_request_template.md .github/PULL_REQUEST_TEMPLATE.md docs/pull_request_template.md pull_request_template.md; do
  if [ -f "$path" ]; then
    PR_TEMPLATE="$path"
    break
  fi
done
```

**Step 5b: Read and populate the template**

If a PR template exists:
1. **Read the template file** using the Read tool
2. **Fill in every section** with actual data from the current PR context:
   - Replace HTML comments (`<!-- ... -->`) with real content
   - Check applicable checkboxes (`- [x]`)
   - Fill in Forge issue IDs (replace `forge-xxx` with actual ID)
   - Fill in test results, validation status, and other concrete data
   - Reference the design doc: `docs/work/YYYY-MM-DD-<slug>/plan.md`
3. **Do NOT remove any sections** — fill them all, even if "N/A"
4. **Do NOT restructure the template** — keep the project's chosen format

If no PR template exists, use this minimal fallback:
```
## Summary
[1-3 sentences: what this PR does and why]

## Changes
[Bulleted list of key changes]

## Testing
[How it was tested, test results]

## Issue
Closes forge-xxx

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Step 5c: Create the PR**

```bash
gh pr create --title "<type>: <concise description>" --body "<populated-template-content>"
```

Rules for the PR body:
- **Use the project's template structure** — never substitute your own format
- **Fill in concrete data** — commit counts, test results, actual file paths, real Forge IDs
- **Check applicable checkboxes** — `[x]` for items that apply, `[ ]` for items that don't
- **Include "Closes forge-xxx"** in the Issue section (required for auto-close in /verify)

### Step 6: Confirm Context and Record Stage Transition
```bash
# Confirm the issue carries design + acceptance context (helper when present; otherwise inspect the issue).
# Only falls back to `forge issue show` when the helper is absent — a real validate failure stays visible.
if [ -f scripts/beads-context.sh ]; then
  bash scripts/beads-context.sh validate <id>
else
  forge issue show <id>
fi

# Record the ship→review transition (structured helper when present; kernel-native comment otherwise).
# The fallback comment mirrors the same envelope the helper emits (Stage:/Summary:/Decisions:/Artifacts:/Next:).
if [ -f scripts/beads-context.sh ]; then
  bash scripts/beads-context.sh stage-transition <id> ship review \
    --summary "<PR created, checks pending>" \
    --decisions "<template sections filled, issue linked>" \
    --artifacts "<PR URL, branch name>" \
    --next "<review focus areas>"
else
  forge comment <id> "Stage: ship complete → ready for review
Summary: <PR created, checks pending>
Decisions: <template sections filled, issue linked>
Artifacts: <PR URL, branch name>
Next: <review focus areas>"
fi
```

### Team sync after PR

After PR is created, sync issue state to GitHub and verify 1:1 mapping:

```bash
# Sync issue state to GitHub
forge team sync 2>&1 || true

# Verify 1:1 mapping
forge team verify 2>&1 || true
```

## Output

`/ship` reports live validation status, branch freshness, Forge issue PR handoff state, push status, PR URL, template sections, linked issue IDs, and CI polling state. Values come from the current branch, issue tracker, and GitHub response; do not copy static IDs, URLs, or branch names into this skill file.

When checks are still pending after the polling window, stop after reporting the PR number and direct the next session to `/review <pr-number>` once automated checks complete or new feedback appears.

## Pre-merge gate (before merge)

Pre-merge is a doc-update **gate/checkpoint**, not a separate stage — run it here, before the PR is handed off for merge, whenever the change touches anything documented:

1. **Finish the docs on the feature branch** (update only what genuinely changed):
   - `CHANGELOG.md` (always) — entry under `## [Unreleased]` using Keep a Changelog categories, with PR number + issue ID.
   - `README.md` (user-facing), `docs/reference/API_REFERENCE.md` (API), architecture docs (structural).
   - `CLAUDE.md` — **USER section only** (between the USER markers); never touch other managed blocks.
   - `AGENTS.md` (agent config, skills, or cross-agent workflow changes).
   Commit the doc updates to the feature branch and push.
2. **Confirm CI is green** — doc commits re-trigger CI; poll briefly (~60s), then hand off if still pending. New review feedback → run `/review` again.
3. **Sync the issue store** — `forge sync`.
4. **Hand off for MANUAL merge** — present the PR and stop. **Never run `gh pr merge`; never auto-merge.** The user merges in the GitHub UI, then runs `/verify`.

## Integration with Workflow

```
Utility: /status  -> Understand current context before starting

Default template:
  /plan      -> Optional default planner; external planners may satisfy /dev entry
  /dev       -> Implement each task with subagent-driven TDD
  /validate  -> Type check, lint, tests, security
  /ship      -> Push + create PR
  /review    -> Address PR feedback
  /verify    -> Post-merge health check

Pre-merge gate: doc updates + CI-green checkpoint embedded in /ship and /review (not a separate stage).
```

## Tips

- **Use the project's PR template**: Always read `.github/pull_request_template.md` (or equivalent) and populate it — never substitute your own format
- **Fill every section**: Even if "N/A" — empty/missing sections cause review friction
- **Include "Closes forge-xxx"**: Required for auto-close in /verify
- **Concrete data only**: Test counts, file paths, commit SHAs — not placeholder text
- **Poll briefly, then stop**: Check PR status for up to 60 seconds, then hand off if checks are still pending
- **NO auto-merge**: Always wait for /review phase
