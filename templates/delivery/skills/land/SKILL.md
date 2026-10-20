---
name: land
description: "Use when a PR may be ready to merge, or after it merged. The orchestrator checks the merge conditions, merges with the head pinned, verifies the merge on base, closes the issue, cleans up, saves what a future session needs and picks the next slice."
---

# land

Orchestrator only. A worker never merges. Merge by: {{values.merge.by}}.

## Merge conditions: all of them, read fresh

1. `gh pr view <n> --json state,mergeStateStatus,headRefOid` shows `OPEN` and `CLEAN`. Anything else (`BLOCKED`, `BEHIND`, `DIRTY`, `UNSTABLE`, `UNKNOWN`) is a no.
2. A passing check receipt exists for that exact head: `forge check show --input '{"id":"<receipt>"}'`. Its head equals `headRefOid`. A receipt for an older head is no receipt.
3. No open review threads, counted over every page; it must print `0`:

```
gh api graphql --paginate -F owner='{owner}' -F repo='{repo}' -F n=<n> -f query='query($owner:String!,$repo:String!,$n:Int!,$endCursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$n){reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{id isResolved}}}}}' --jq '.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved|not)|.id' | wc -l
```

4. No one-way door is open. A merge that deploys, publishes or migrates is a door ({{values.doors}}): it needs the owner's reply naming that action. Silence or "continue" is not a yes.

Any no: do not merge. Go back to `review`, or ask the owner about the door, then stop.

## Merge, pinned

```
gh pr merge <n> --{{values.merge.method}} --match-head-commit <headRefOid>
```

A refused merge because the head moved means read the conditions again from step 1. Never merge without the pin.

## Verify

1. `gh pr view <n> --json state,mergeCommit` shows `MERGED`; keep the merge commit SHA.
2. CI on base for that commit: `gh run list --branch <base> --commit <sha>`. Wait for it through the harness, not a sleep loop. Red there is a new bug: file it at p0 or p1 and fix forward.
3. Close the issue. The worker released its claim, so take it again first: `forge issue claim --input '{"id":"<slice>","ttlSeconds":{{values.claims.ttlSeconds}}}'`, then `forge issue close --input '{"id":"<slice>","reason":"merged in <sha>"}'`.
4. Worktree: list what is in it first (`git -C <path> status --short` and `git -C <path> log origin/<base>..HEAD --oneline`). Remove it only when both are empty; anything left is filed or pushed first. Removing a worktree with work in it is a one-way door.
5. Stop watching: in T3 Code, `unwatch_pull_request`.

## Learn

- Save facts a future session on other work would need: `forge memory add --input '{"text":"...","tags":["..."]}'`. Standing rules get the tag `rule`.
- A mistake that repeated: fix it with a test or lint first, a skill line second, an AGENTS.md line last.

## Re-plan

Take the next ready slice (`forge issue ready --input '{}'`), re-slice, re-frame, or mark the epic done and close slices this one superseded.

## Rollback

`git revert <sha>` on a new branch, through a new PR and this same loop. Never `reset --hard` or force-push a shared branch.
