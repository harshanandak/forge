---
name: forge-land
description: "Use when a PR may be ready to merge or has merged. The orchestrator gates, merges the pinned head, verifies base CI, closes the issue, cleans up, saves context and picks the next slice."
---

# forge-land

Orchestrator only. A worker never merges. Merge by: agent.

## Merge conditions: all of them, read fresh

Preview: `forge check gate --input '{"pr":<n>}'`. The merge below must return exit 0, `ok:true` and `result.outcome` MERGED. Keep `result.head` as `<head>` and `result.receipt` as `<id>`.

The gate requires an open, clean PR, a verified current-head PASS receipt covering `receiptChecks`, successful required CI checks, no unresolved threads across every page, and no changed file matching `doorPaths`. It re-reads the head before returning. REFUSED exits 1 with reasons; fix through `forge-review` and rerun the gate.

A matched door path always refuses: the owner merges that PR by hand. A merge that deploys, publishes or migrates is also a door (publish, force-push, prod-write, migration-apply, delete-branch, delete-worktree, merge-to-autodeploy, global-config): it needs the owner's reply naming that action. Silence, "continue" or "fix all" never counts as approval.

## Merge, pinned and serial

Merge one PR at a time, after combined-code CI: minimise time to merge within floors of zero red checks, open threads and open doors.

```
forge pr merge <n>
```

It runs the gate and uses `gh pr merge <n> --squash --match-head-commit <head>` pinned to its head, never `--admin`, `--auto` or `--delete-branch`. Never run raw `gh pr merge`. On `CHECK_GATE_REFUSED`, fix `result.gate.reasons` through `forge-review`. On `MERGE_UNVERIFIED`, read `forge pr state <n>` before anything else.

A refused merge because the head moved means run the gate again. Never merge without the pin.

## Verify

1. Readback shows `MERGED`; keep `result.mergeCommit` as the merge commit SHA.
2. Base CI: `gh run list --branch <base> --commit <sha>`. Wait through the harness, not a sleep loop. Red is a new bug: file at p0 or p1 and fix forward.
3. Close the issue. The worker released its claim, so take it again first: `forge issue claim <slice>`. Run `forge issue links <slice>`; if the newest `delivers` link is not the PR being landed (or none exists), add the current PR URL first with `forge issue link <slice> --relation delivers --url "<pr url>"` while holding the claim. Then run `forge issue close <slice> --reason "merged in <sha>" --receipt <id>` using the gate's receipt or a `check run` receipt at the merge commit. On `RECEIPT_HEAD_MISMATCH` or `PR_NOT_MERGED`, stop; never switch to `withoutReceipt`. On `UNAVAILABLE`, retry.
4. Inspect the worktree (`git -C <path> status --short` and `git -C <path> log origin/<base>..HEAD --oneline`). Remove only when both are empty; file or push anything left first. Removing work is a one-way door.
5. Stop watching after verify: run `forge agent wait <n> --done`, do each step, then follow `then`. Same cleanup when abandoning or handing back the PR.

## Learn

- Save future-session facts: `forge memory add --input '{"text":"...","level":"device","scope":"<name>","tags":["..."]}'`. Use the lowercase repo name from `gh repo view --json name --jq '.name|ascii_downcase'` as `<name>`.
- Propose a standing rule: `forge decision propose --input '{"title":"...","text":"..."}'`. On `format_missing`, follow the returned `repair`, then propose again. Only after `proposed`, hand it to a human for `decision.adopt`; adoption makes it binding.
- A mistake that repeated: fix it with a test or lint first, a skill line second, an AGENTS.md line last.

## Re-plan

Take the next ready slice (`forge issue ready --input '{}'`), re-slice, re-frame, or mark the epic done and close slices this one superseded.

## Rollback

`git revert <sha>` on a new branch, through a new PR and this same loop. Never `reset --hard` or force-push a shared branch.
