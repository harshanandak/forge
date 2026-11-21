---
name: forge-land
description: "Use when a PR may be ready to merge, or after it merged."
---

# forge-land

Orchestrator only. A worker never merges. Merge by: agent. Read [owner-approval.md](owner-approval.md) on `APPROVAL_REQUIRED`.

## Merge conditions

From trusted config, run `forge check gate --pr <n>`. Keep `result.head` as `<head>` and `result.receipt` as `<id>`.

The gate checks PR state, current-head `receiptChecks`, required CI, unresolved threads, and `doorPaths`. For `gate.requiredReviews`, the named reviewer submits a GitHub approval with one standalone `forge-review:<kind>` line. Require approval on `<head>` or verified carry. Fix refusals through `forge-review`.

Only the owner merges by hand when `DOOR_PATH_TOUCHED` is the sole refusal. Verify the same reviews and pin `<head>`. A merge that deploys, publishes or migrates is a door. Doors (publish, force-push, prod-write, migration-apply, delete-branch, delete-worktree, merge-to-autodeploy, global-config) need an owner reply naming the action. Silence, "continue" or "fix all" never counts.

## Merge, pinned and serial

Merge serially after combined-code CI, with zero red checks, open threads and open doors.

```
forge pr merge <n> --head <head>
```

It runs the gate and pins `gh pr merge <n> --squash --match-head-commit <head>`. Never run raw `gh pr merge` or add `--admin`, `--auto` or `--delete-branch`. Require exit 0, `ok:true` and `result.outcome` MERGED. On `CHECK_GATE_REFUSED`, fix `result.gate.reasons`. On `MERGE_UNVERIFIED`, read `gh pr view <n> --json state,mergeCommit,headRefOid` before anything else and apply Verify 1.

A refused merge because the head moved means run the gate again. Never merge without the pin.

## Verify

1. `gh pr view <n> --json state,mergeCommit,headRefOid` must show `MERGED`, `headRefOid` equal to `<head>` and a valid `mergeCommit.oid`; otherwise the merge is not verified: stop. Keep its merge commit SHA.
2. Base CI: `gh run list --branch <base> --commit <sha>`. Wait through the harness, not a sleep loop. Red is a new bug: file at p0 or p1 and fix forward.
3. Claim before closing: `forge issue claim <slice>`. Run `forge issue links <slice>`; if the newest `delivers` link is not the PR being landed (or none exists), add the current PR URL first with `forge issue link <slice> --relation delivers --url "<pr url>"` while holding the claim. For a lane, run `forge lane close <slice> --pr <n> --receipt <id>` with the gate's receipt or a `check run` receipt at the merge commit. Without a lane, run `forge issue close <slice> --reason "merged in <sha>" --receipt <id>`. On `RECEIPT_HEAD_MISMATCH` or `PR_NOT_MERGED`, stop; never switch to `withoutReceipt`. On `UNAVAILABLE`, retry.
4. Before `forge lane close <slice> --no-pr --dropped "<reason>"`, require the owner's reply naming delete-worktree and, at base, delete-branch. Silence is not approval. Dirty checkouts refuse; ahead commits retain their branch.
5. Stop watching after verify: run `forge agent wait <n> --done`, do each step, then follow `then`. Same cleanup when abandoning or handing back the PR.

## Learn

- Save future-session facts: `forge memory add --input '{"text":"...","level":"device","scope":"<name>","tags":["..."]}'`. Use the lowercase repo name from `gh repo view --json name --jq '.name|ascii_downcase'` as `<name>`.
- Propose a standing rule: `forge decision propose --input '{"title":"...","text":"..."}'`. On `format_missing`, follow the returned `repair`, then propose again. Only after `proposed`, hand it to a human for `decision.adopt`; adoption makes it binding.
- Repeated mistakes: test or lint first, a skill line second, AGENTS.md last.

## Re-plan

Take the next ready slice (`forge issue ready --input '{}'`), re-slice, or finish the epic and close superseded slices.

## Rollback

`git revert <sha>` on a new branch, through a new PR and this same loop. Never `reset --hard` or force-push a shared branch.
