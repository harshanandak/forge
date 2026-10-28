---
name: forge-land
description: "Use when a PR may be ready to merge, or after it merged. The orchestrator checks the merge conditions, merges with the head pinned, verifies the merge on base, closes the issue, cleans up, saves what a future session needs and picks the next slice."
---

# forge-land

Orchestrator only. A worker never merges. Merge by: agent.

## Merge conditions: all of them, read fresh

Run `forge check gate --input '{"pr":<n>}'`. Require exit 0, `ok:true` and `result.verdict` PASS. Keep its `head` as `<head>` and `receipt` as `<id>`.

The gate requires an open, clean PR, a verified PASS receipt for its current head covering the configured `receiptChecks`, successful required CI checks, no unresolved review threads across every page, and no changed file matching configured `doorPaths`. It reads the head again before returning. REFUSED exits 1 with reasons; fix them through `forge-review` and rerun the gate.

A matched door path always refuses: the owner merges that PR by hand. A merge that deploys, publishes or migrates is also a door (publish, force-push, prod-write, migration-apply, delete-branch, delete-worktree, merge-to-autodeploy, global-config): it needs the owner's reply naming that action. Silence, "continue" or "fix all" never counts as approval.

## Merge, pinned and serial

Merge one PR at a time, after combined-code CI: minimise time to merge within floors of zero red checks, open threads and open doors.

```
gh pr merge <n> --squash --match-head-commit <head>
```

A refused merge because the head moved means run the gate again. Never merge without the pin.

## Verify

1. `gh pr view <n> --json state,mergeCommit` shows `MERGED`; keep the merge commit SHA.
2. CI on base for that commit: `gh run list --branch <base> --commit <sha>`. Wait for it through the harness, not a sleep loop. Red there is a new bug: file it at p0 or p1 and fix forward.
3. Close the issue. The worker released its claim, so take it again first: `forge issue claim --input '{"id":"<slice>"}'`. Run `forge issue links <slice>`; if no `delivers` link exists, add the PR URL with `forge issue link --input '{"id":"<slice>","relation":"delivers","url":"<pr url>"}'` while holding the claim. Then run `forge issue close --input '{"id":"<slice>","reason":"merged in <sha>","receipt":"<id>"}'` using the gate's receipt or a `check run` receipt at the merge commit. On `RECEIPT_HEAD_MISMATCH` or `PR_NOT_MERGED`, stop; never switch to `withoutReceipt`. On `UNAVAILABLE`, retry.
4. Worktree: list what is in it first (`git -C <path> status --short` and `git -C <path> log origin/<base>..HEAD --oneline`). Remove it only when both are empty; anything left is filed or pushed first. Removing a worktree with work in it is a one-way door.
5. Stop watching after verify: run `forge agent wait <n> --done`, do each step, then follow `then`. Use the same cleanup when abandoning or handing back the PR.

## Learn

- Save facts a future session would need: `forge memory add --input '{"text":"...","level":"device","scope":"<name>","tags":["..."]}'`. Use the lowercase repo name from `gh repo view --json name --jq '.name|ascii_downcase'` as `<name>`.
- Propose a standing rule: `forge decision propose --input '{"title":"...","text":"..."}'`. On `format_missing`, follow the returned `repair`, then propose again. Only after `proposed`, hand it to a human for `decision.adopt`; adoption makes it binding.
- A mistake that repeated: fix it with a test or lint first, a skill line second, an AGENTS.md line last.

## Re-plan

Take the next ready slice (`forge issue ready --input '{}'`), re-slice, re-frame, or mark the epic done and close slices this one superseded.

## Rollback

`git revert <sha>` on a new branch, through a new PR and this same loop. Never `reset --hard` or force-push a shared branch.
