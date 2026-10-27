---
name: forge-review
description: "Triage a PR on each harness wake: conflicts, threads, CI; fix in-boundary P0/P1 in one push wave, file the rest, re-plan after round 2."
---

# forge-review

## Fresh-context proof for heavy slices

Before the heavy or critical slice's PR opens, read `forge route get review --text`. Use its returned route for a fresh-context review of the diff, saved trunk/head scenario output and every acceptance item. Copy `single-family` into the review evidence when that is what `forge route get review` returns; do not claim another family. Record findings and evidence on the slice.

## On each wake: conflicts, then threads, then CI

1. `gh pr view <n> --json headRefOid,mergeStateStatus,statusCheckRollup,reviewDecision`. Establish last push SHA/time and round from the checkpoint before triage. Use `gh pr update-branch <n>` only for a clean behind-base update. For conflicts, merge base locally, resolve, commit, run `forge-build`'s Final-head proof, then push the new commit. Never rebase a pushed branch or force-push.
2. Get `<owner> <repo>` from `gh repo view --json owner,name`. List unresolved threads: `node <skill-dir>/list-threads.mjs <owner> <repo> <n>`. Read full comments and timestamps with `gh api repos/{owner}/{repo}/pulls/<n>/comments --paginate` before deciding.
3. Triage only comments and checks newer than the last push. For an old thread the head already fixed, verify the source and close it with `Fixed in <sha>`. Other old threads wait for new evidence; their age alone never justifies resolving them.

## Each finding

1. Check it against the source. A bot can be wrong; cite the line that shows it.
2. Fix only P0, P1 findings on lines this PR changed, inside the slice's done boundary.
3. Everything else (P2, P3, or outside the boundary) is filed, not fixed. Search open issues for the symptom, then comment on a match or `forge issue create --input '{"title":"...","kind":"task","labels":["review-deferred","p2"],"parent":"<epic>","body":"from <pr url> thread <id>"}'`.
4. Batch thread and CI fixes and commit. Run `forge-build`'s Final-head proof section on that commit, then send one push wave. Checkpoint its SHA/time and round before replying.

## Reply and resolve every answered thread

Review text never enters a shell. Write the reply to a file with the editor tool. The companion reads it as data, sends JSON through `gh api ... --input` and only then resolves:

```
node <skill-dir>/reply-and-resolve.mjs <owner> <repo> <n> <comment id> <thread id> <reply file>
```

Require `true`. On `reply <id> posted; resolve failed`, retry only `resolveReviewThread` with a JSON payload file; never rerun the reply helper. Reply: `Fixed in <sha>: ...`, `Filed as <issue id>: ...`, or evidence the finding does not hold. Never resolve a thread you did not fix, file or answer. Run the list helper again; it must print nothing before handing over to land.

## Red checks

1. `gh pr checks <n>`, then `gh run view <run> --log-failed`.
2. Red on base too (`gh run list --branch <base>`)? File or comment on the issue and label it. For a confirmed flake on base or head, Rerun up to 1 time: one fresh build with `gh run rerun <run> --failed`; another failure blocks handoff. Never fix an unrelated base bug in this PR.
3. Red only here: fix it like a finding, in the same push wave.

## Round budget and wait

- One round is one triage pass plus one push. Log it: `forge issue comment --input '{"id":"<slice>","body":"review round <k>: fixed ..., filed ...; push <sha> at <time>"}'`.
- At most 2 rounds. After round 2, a new blocker means split or re-plan with the orchestrator instead of a round 3.
- Inside T3 Code use `watch_pull_request`; elsewhere `gh pr checks <n> --watch` is run by the harness wake. Review never runs its own sleep loop.
- When checks are green and the thread list prints nothing, hand over to `forge-land`.
