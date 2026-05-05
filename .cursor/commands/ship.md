
Push code and create a pull request with full context and documentation links.

# Ship

This command creates a PR after validation passes.

## Usage

```bash
/ship
```

```
<HARD-GATE: /ship entry>
Do NOT create PR until:
1. /validate was run in this session with all four outputs shown (type, lint, tests, security)
2. All checks confirmed passing — not assumed, not "was passing earlier"
3. Beads issue is in_progress
4. git branch --show-current output is NOT main or master
</HARD-GATE>
```

## What This Command Does

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
- If `y`: log override via `bd comments add <id> "Ship override: creating PR despite merge conflicts"`, then continue

After PR creation completes:
```bash
# Auto-label the newly created PR
bash scripts/pr-coordinator.sh auto-label <issue-id>

# Check for stale worktrees (informational)
bash scripts/pr-coordinator.sh stale-worktrees 2>&1 || true
```

### Step 3: Update Beads
```bash
bd update <id> --status done
bd sync
```

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
   - Fill in beads issue IDs (replace `beads-xxx` with actual ID)
   - Fill in test results, validation status, and other concrete data
   - Reference the design doc: `docs/work/YYYY-MM-DD-<slug>/design.md`
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

## Beads
Closes beads-xxx

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Step 5c: Create the PR**

```bash
gh pr create --title "<type>: <concise description>" --body "<populated-template-content>"
```

Rules for the PR body:
- **Use the project's template structure** — never substitute your own format
- **Fill in concrete data** — commit counts, test results, actual file paths, real beads IDs
- **Check applicable checkboxes** — `[x]` for items that apply, `[ ]` for items that don't
- **Include "Closes beads-xxx"** in the Beads section (required for auto-close in /verify)

### Step 6: Validate Context and Record Stage Transition
```bash
bash scripts/beads-context.sh validate <id>
bash scripts/beads-context.sh stage-transition <id> ship review \
  --summary "<PR created, checks pending>" \
  --decisions "<template sections filled, beads linked>" \
  --artifacts "<PR URL, branch name>" \
  --next "<review focus areas>"
```

### Team sync after PR

After PR is created, sync issue state to GitHub and verify 1:1 mapping:

```bash
# Sync issue state to GitHub
forge team sync 2>&1 || true

# Verify 1:1 mapping
forge team verify 2>&1 || true
```

## Example Output

```
✓ Validation: /validate passed (all 4 checks — fresh output confirmed)
✓ Freshness: Branch is up-to-date with master
✓ Beads: Marked done & synced (forge-xyz)
✓ Pushed: feat/stripe-billing
✓ PR created: https://github.com/.../pull/123
  - PR body: Problem → Root Cause → Fix → Value (narrative format)
  - Beads linked: forge-xyz
  - Implementation details in collapsible section

⏸️  PR created, checks started (Greptile, SonarCloud, GitHub Actions)
   Poll for up to 60 seconds. If checks are still pending, stop here.

Next: /review <pr-number> (when automated checks complete or new feedback appears)
```

## Integration with Workflow

```
Utility: /status     → Understand current context before starting
Stage 1: /plan       → Design intent → research → branch + worktree + task list
Stage 2: /dev        → Implement each task with subagent-driven TDD
Stage 3: /validate      → Type check, lint, tests, security — all fresh output
Stage 4: /ship       → Push + create PR (you are here)
Stage 5: /review     → Address GitHub Actions, Greptile, SonarCloud
Stage 6: /premerge   → Update docs, hand off PR to user
Stage 7: /verify     → Post-merge CI check on main
```

## Tips

- **Use the project's PR template**: Always read `.github/pull_request_template.md` (or equivalent) and populate it — never substitute your own format
- **Fill every section**: Even if "N/A" — empty/missing sections cause review friction
- **Include "Closes beads-xxx"**: Required for auto-close in /verify
- **Concrete data only**: Test counts, file paths, commit SHAs — not placeholder text
- **Poll briefly, then stop**: Check PR status for up to 60 seconds, then hand off if checks are still pending
- **NO auto-merge**: Always wait for /review phase
