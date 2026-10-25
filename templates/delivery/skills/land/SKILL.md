---
name: land
description: "Use when a PR may be ready to merge, or after it merged. The orchestrator checks the merge conditions, merges with the head pinned, verifies the merge on base, closes the issue, cleans up, saves what a future session needs and picks the next slice."
---

# land

Orchestrator only. A worker never merges. Merge by: {{values.merge.by}}.

## Merge conditions: all of them, read fresh

Run `forge check gate --input '{"pr":<n>}'`. Require exit 0, `ok:true` and `result.verdict` PASS. Keep its `head` as `<head>` and `receipt` as `<id>`.

The gate requires an open, clean PR, a verified PASS receipt for its current head covering the configured `receiptChecks`, successful required CI checks, no unresolved review threads across every page, and no changed file matching configured `doorPaths`. It reads the head again before returning. REFUSED exits 1 with reasons; fix them through `review` and rerun the gate.

A matched door path always refuses: the owner merges that PR by hand. A merge that deploys, publishes or migrates is also a door ({{values.doors}}): it needs the owner's reply naming that action. Silence or "continue" is not a yes.

## Merge, pinned

```
gh pr merge <n> --{{values.merge.method}} --match-head-commit <head>
```

A refused merge because the head moved means read the conditions again from step 1. Never merge without the pin.

## Verify

1. `gh pr view <n> --json state,mergeCommit` shows `MERGED`; keep the merge commit SHA.
2. CI on base for that commit: `gh run list --branch <base> --commit <sha>`. Wait for it through the harness, not a sleep loop. Red there is a new bug: file it at p0 or p1 and fix forward.
3. Close the issue. The worker released its claim, so take it again first: `forge issue claim --input '{"id":"<slice>","ttlSeconds":{{values.claims.ttlSeconds}}}'`, then `forge issue close --input '{"id":"<slice>","reason":"merged in <sha>","receipt":"<id>"}'` using the gate's receipt.
4. Worktree: list what is in it first (`git -C <path> status --short` and `git -C <path> log origin/<base>..HEAD --oneline`). Remove it only when both are empty; anything left is filed or pushed first. Removing a worktree with work in it is a one-way door.
5. Stop watching: in T3 Code, `unwatch_pull_request`.

## Learn

- Save facts a future session would need: `forge memory add --input '{"text":"...","level":"device","scope":"<name>","tags":["..."]}'`. Use the lowercase repo name from `gh repo view --json name --jq '.name|ascii_downcase'` as `<name>`.
- Propose a standing rule: `forge decision propose --input '{"title":"...","text":"..."}'`. On `format_missing`, follow the returned `repair`, then propose again. Only after `proposed`, hand it to a human for `decision.adopt`; adoption makes it binding.
- A mistake that repeated: fix it with a test or lint first, a skill line second, an AGENTS.md line last.

## Re-plan

Take the next ready slice (`forge issue ready --input '{}'`), re-slice, re-frame, or mark the epic done and close slices this one superseded.

## Rollback

`git revert <sha>` on a new branch, through a new PR and this same loop. Never `reset --hard` or force-push a shared branch.
