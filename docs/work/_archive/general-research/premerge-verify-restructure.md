# Research: /premerge + /verify Workflow Restructure

**Date**: 2026-02-24
**Objective**: Determine if restructuring `/merge` → `/premerge` (pre-merge doc prep) and making `/verify` read-only is the right approach, and identify potential problems.

---

## Codebase Analysis

### Current State

| Component | Location | Status |
| --- | --- | --- |
| `/merge` command | `.claude/commands/merge.md` | Exists — currently does docs + handoff |
| `/verify` command | `.claude/commands/verify.md` | Exists — finds gaps, commits fixes, can create PRs |
| Workflow table (stage 8) | `CLAUDE.md`, `AGENTS.md`, `docs/WORKFLOW.md`, all 11 command files | All say `/merge` |

### The Loop Problem

```
/merge → doc commits → PR
User merges
/verify → finds gaps → commits to master → PROTECTED → needs new PR
User merges again
/verify again?
```

Every post-merge doc fix requires its own PR because `master` is branch-protected.

---

## Web Research Findings

### Finding 1: Post-merge doc commits on protected branches are fundamentally broken

**Source**: Multiple CI/CD resources (Terramate, Medium, GitHub Docs)

Post-merge commits to protected branches fail because:
- They bypass the PR validation flow
- Squash merges create "phantom conflicts" when the same branch is re-merged
- Stale approval dismissal means post-merge commits lose approval status
- Each failure requires another follow-up PR → recursive loop

**Verdict**: Our problem is a known anti-pattern. Pre-merge documentation is the correct fix.

---

### Finding 2: Pre-merge documentation is the correct pattern

**Source**: LinearB, GitHub Actions best practices, Graphite

Successful teams enforce documentation as part of the PR itself — not as a follow-up. The PR is only ready to merge when it contains code + tests + docs.

**Verdict**: Moving doc updates into the feature branch (before handoff) is confirmed correct.

---

### Finding 3: Keep pre-merge checks fast and focused

**Source**: ZenCoder AI, LinearB

Overly complex pre-merge checklists slow down merging and get skipped. Each check should be targeted and relevant to the specific PR.

**Verdict**: `/premerge` should check only docs that are actually relevant to the feature — not a blanket update of all files every time.

---

## Problems We Could Face

### Problem 1: Simultaneous PRs conflict on shared doc files

If two PRs are open and both update `PROGRESS.md` or `CLAUDE.md`, one will have a merge conflict.

**Mitigation**: `/premerge` should warn if the branch is behind `master` and tell user to rebase first. Since user merges sequentially, this is rare but possible.

---

### Problem 2: CLAUDE.md has managed sections that must not be touched

`CLAUDE.md` has `<!-- OPENSPEC:START/END -->` and `<!-- USER:START/END -->` blocks managed by external tools. Breaking the structure causes `openspec update` to fail.

**Mitigation**: `/premerge` must only update the **USER section** (between `<!-- USER:START -->` and `<!-- USER:END -->`). Never modify managed blocks.

---

### Problem 3: Doc commits on feature branch re-trigger full CI

When `/premerge` pushes doc update commits, Greptile and other CI tools re-run. This could add new Greptile review comments on the documentation changes.

**Mitigation**: This is acceptable — doc updates should be reviewed. `/premerge` output should tell the user to re-check CI after the doc push, and run `/review` again if needed.

---

### Problem 4: Stage 8 label `/merge` appears in 4+ locations

The workflow table with stage 8 = `/merge` exists in:
1. `CLAUDE.md`
2. `AGENTS.md`
3. `docs/WORKFLOW.md` (407 lines)
4. The "Integration with Workflow" section inside **each of the 11 command files**

Missing any of these creates inconsistency.

**Mitigation**: Update all locations as part of the implementation PR. The 11 command files are the easiest to miss.

---

### Problem 5: `/verify` becomes nearly trivial

If all doc updates happen pre-merge, `/verify` has almost nothing to do post-merge. Risk: it gets skipped entirely.

**Mitigation**: Give `/verify` a clear, focused purpose:
- `git checkout master && git pull` (update local)
- Confirm the feature entry is in `PROGRESS.md` on main (quick sanity check)
- Output "clean — ready for next feature, run /status"
- If something IS missing: create a Beads issue, never commit inline

This makes it lightweight and always worth running.

---

### Problem 6: PR #47 already open with the old merge.md update

PR #47 currently contains the old `merge.md` update (handoff-only version). Now we're replacing it with `premerge.md` + updated `verify.md` + all doc references.

**Mitigation**: Amend the same branch (`fix/merge-command-no-auto-merge`) — add `premerge.md`, delete `merge.md`, update everything. PR #47 will automatically update.

---

## Clarified Command Design (Final)

### `/premerge <pr-number>` — Everything before the user clicks merge

All documentation and changes go here. The PR must be 100% complete before handoff.

Checklist:
- All CI checks passing
- Branch up to date with master (warn if behind)
- `PROGRESS.md` updated
- `README.md` updated (if user-facing)
- `API_REFERENCE.md` updated (if API changes)
- Architecture docs updated (if structural)
- `CLAUDE.md` USER section updated (if conventions changed)
- `AGENTS.md` updated (if agent config/skills changed)
- `docs/WORKFLOW.md` updated (if workflow changed)
- Commit all doc updates to feature branch → push
- Archive OpenSpec (if strategic)
- Sync Beads
- **STOP** → present PR URL → wait for user to merge

### `/verify` — Post-merge health check (not a doc check)

Runs AFTER user confirms they've merged. Focuses on system health, not documentation.

Checklist:
- `git checkout master && git pull` (confirm merge landed)
- Did CI pass on main after merge? (`gh run list --branch master --limit 3`)
- Are deployments up? (Vercel preview → production, or other deploy targets)
- Any post-merge failures or broken checks on main?
- Is the PR marked as merged (not just closed)?
- If any issues: report them clearly — these may need hotfix PRs

**Never commits.** If documentation gaps are found at this stage, create a Beads issue rather than committing inline.

---

## Key Decisions

### Decision 1: Delete `/merge`, create `/premerge` — don't alias

**Why**: An alias creates confusion. Clean break is better.

**Evidence**: User confirmed "delete it."

### Decision 2: `/verify` = post-merge health check, not doc verification

**Why**: Documentation completeness is `/premerge`'s job. `/verify` should answer: "did everything land and run correctly after the merge?" — deployments, CI on main, merge status.

**Evidence**: User explicitly clarified this: "check if the pull request has been merged properly, if deployments are working properly, if we are facing any issues."

### Decision 3: `/premerge` owns ALL documentation updates

**Why**: Eliminates the recursive PR loop entirely. The PR contains code + tests + docs as a single complete unit. User merges once.

**Evidence**: Web research confirms pre-merge documentation is the correct pattern. Post-merge commits on protected branches are a known anti-pattern.

---

## Scope Assessment

**Tactical** (no OpenSpec needed) — this is a workflow command update, not an architecture change.

**Complexity**: Medium — 4+ files to update, careful with managed sections in CLAUDE.md.

**Risk**: Low — command files are documentation, no code logic affected.

---

## Sources

- [GitHub Docs: Managing branch protection rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule)
- [Mastering Terraform Workflows: apply-before-merge vs apply-after-merge](https://terramate.io/rethinking-iac/mastering-terraform-workflows-apply-before-merge-vs-apply-after-merge/)
- [The case for apply before merge](https://medium.com/@DiggerHQ/the-case-for-apply-before-merge-bc08a7a9bfea)
- [LinearB: Pre-merge Workflow Automation](https://linearb.io/resources/automate-pre-merge-workflow-automation-for-dev-efficiency)
- [Graphite: Mandatory pull request checks](https://graphite.com/guides/mandatory-pull-request-checks-and-requirements-in-github)
