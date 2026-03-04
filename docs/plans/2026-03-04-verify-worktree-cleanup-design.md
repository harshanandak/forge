# Design: Fix /verify to Clean Up Worktree and Branch After Merge

- **Slug**: verify-worktree-cleanup
- **Date**: 2026-03-04
- **Status**: Draft
- **Beads**: forge-bmi

---

## Purpose

`/verify` runs after a PR merges. Currently it checks CI and deployments, but never removes the feature worktree or local branch — leaving stale state in the repo. The example output even shows "Branch: feat/auth-refresh deleted ✓" but no step actually does this.

Result: every merged feature leaves a dangling worktree + local branch forever, requiring manual cleanup.

---

## Success Criteria

1. After `/verify` runs on a healthy merge, the feature worktree is removed (`git worktree remove`)
2. After `/verify` runs on a healthy merge, the local feature branch is deleted (`git branch -d`)
3. If the worktree directory doesn't exist (already cleaned up manually), step skips gracefully
4. If the branch is already deleted, step skips gracefully
5. Cleanup only happens after CI is confirmed healthy — not before
6. The HARD-GATE is updated to include cleanup as a required step
7. All other agents' verify command files are updated identically (if they exist)

---

## Out of Scope

- Deleting the remote branch (GitHub does that automatically on merge with branch auto-delete enabled)
- Cleanup on unhealthy merges (user may need to inspect the worktree)
- Creating new worktree cleanup infrastructure — this is just adding `git worktree remove` + `git branch -d` to the existing verify steps

---

## Approach Selected

Add two steps to `/verify` between the existing "Step 5: Report Status" and "Step 7: Close Beads Issue":

**New Step 6: Clean Up Worktree and Branch**

The feature branch name is known from the Beads issue or from `git worktree list`. Steps:
1. Run `git worktree list` to find the worktree path for the merged branch
2. `git worktree remove <path>` (if it exists)
3. `git branch -d <branch>` (if it still exists locally)
4. Report cleanup in the status output

Cleanup is conditional on healthy CI (Step 3 passed). If CI failed, skip cleanup and note it in the output.

---

## Constraints

- Cleanup is **destructive** — must only run after confirming the merge actually landed (`gh pr list --state merged` confirmed in Step 2)
- Must be idempotent — if worktree or branch already gone, skip silently
- `git branch -d` (safe delete) not `git branch -D` (force) — if branch has unmerged commits it should warn rather than silently delete
- Do not remove worktrees that belong to other in-progress features

---

## Edge Cases

- **Worktree already removed**: `git worktree list` won't show it — skip gracefully
- **Branch already deleted**: `git branch -d` exits non-zero if branch doesn't exist — catch and skip
- **Multiple worktrees**: `git worktree list` may show multiple — only remove the one matching the merged branch
- **No worktree was ever created**: Some workflows skip worktree setup — if no matching worktree found, skip cleanup step entirely
- **Stale superpowers-gaps worktree**: This fix will clean up the `feat/superpowers-gaps` worktree the next time a verify-like cleanup is run manually (`git worktree remove .worktrees/superpowers-gaps`)

---

## Ambiguity Policy

If the merged branch name cannot be determined (e.g., squash merge loses branch name), skip cleanup and tell the user: "Could not determine feature branch — run `git worktree list` and `git worktree remove <path>` manually."

---

## Technical Research

### How to detect which worktree to remove

```bash
# List all worktrees with their branches
git worktree list --porcelain
# Output includes: worktree <path>, HEAD <sha>, branch refs/heads/<name>
# Find the entry where branch = merged branch name
```

### How to get merged branch name

From the PR info retrieved in Step 2:
```bash
gh pr view <number> --json headRefName --jq '.headRefName'
```

### OWASP Analysis

- No user input processed — branch names come from `git` and `gh` CLI output
- `git worktree remove` and `git branch -d` are local operations only
- No injection risk — branch names passed as arguments are from controlled sources
- Risk: **A01 Broken Access Control** — N/A (local git operations)
- Risk: **A03 Injection** — minimal; branch names from `gh` output, not user-typed. Mitigate: use `--` separator in git commands if needed.

### TDD Test Scenarios

1. **Happy path**: Worktree exists for merged branch → removed, branch deleted, report shows cleanup
2. **Worktree already gone**: `git worktree list` has no entry for branch → skip silently, no error
3. **Branch already deleted**: `git branch -d` fails → catch, skip, log "branch already deleted"
4. **CI failed**: Step 3 detected failing CI → skip cleanup entirely, leave worktree intact
5. **Multiple worktrees**: Two worktrees exist → only the one matching merged branch is removed

---

## Task List

### Task 1: Update `.claude/commands/verify.md` — add cleanup steps

**File(s)**: `.claude/commands/verify.md`

**What to implement**:
- Add **Step 6: Clean Up Worktree and Branch** between current Step 5 (Report Status) and Step 7 (Close Beads):
  1. Get merged branch name: `gh pr view <number> --json headRefName --jq '.headRefName'`
  2. Find matching worktree: `git worktree list --porcelain | grep <branch>`
  3. If found: `git worktree remove <path> --force` (force needed because bun install creates node_modules)
  4. Delete local branch: `git branch -d <branch>` (safe delete, skip if not found)
  5. Report: "Worktree: removed ✓" / "Branch: deleted ✓" in status output
- Update example output to show cleanup lines (they're already in the example — just need the actual steps)
- Update HARD-GATE to add: "Worktree removed (or confirmed already gone)"

**TDD steps**:
1. Write test: `test/commands/verify.test.js` — check that verify.md contains "worktree remove", "branch -d", and the HARD-GATE mentions worktree cleanup
2. Run test: `bun test test/commands/verify.test.js` — fails (those strings not in file)
3. Implement: edit verify.md to add Step 6
4. Run test: passes
5. Commit: `fix: add worktree and branch cleanup to /verify stage`

**Expected output**: verify.md has Step 6 with worktree/branch cleanup; test passes.

---

### Task 2: Clean up the stale `superpowers-gaps` worktree now

**File(s)**: none (one-time cleanup)

**What to implement**:
The `feat/superpowers-gaps` worktree at `.worktrees/superpowers-gaps` is stale — PR 50 merged. Remove it manually as a one-time fix:
```bash
git worktree remove .worktrees/superpowers-gaps --force
git branch -d feat/superpowers-gaps
```

**TDD steps**:
1. Run: `git worktree list` — confirm superpowers-gaps appears
2. Run cleanup: `git worktree remove .worktrees/superpowers-gaps --force && git branch -d feat/superpowers-gaps`
3. Run: `git worktree list` — confirm it's gone
4. Commit: `chore: clean up stale superpowers-gaps worktree`

**Expected output**: `git worktree list` shows only master and active feature worktrees.

---

## Ordering

Task 2 can run in parallel with Task 1 — it's a one-time cleanup independent of the command file edit.
