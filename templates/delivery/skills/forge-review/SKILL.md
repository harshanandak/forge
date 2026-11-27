---
name: forge-review
description: "Triage PR conflicts, threads and CI on each harness wake."
---

# forge-review

If a worker brief says stop after push or PR open, link an open PR to the issue, release the claim, then stop; leave thread linking and CI watching to the orchestrator.

## Heavy proof

Heavy or critical PRs: use `forge route get review --text`. Count with `forge issue call <slice> --role review`. Stop on LIMIT_REACHED. Retry REVISION_CONFLICT. Pass returned timeboxMinutes and stopBy. Tell the subagent to stop and report the checkpoint when timeboxMinutes expire, never later than stopBy. Via the route, review the diff, saved trunk/head output and each acceptance item in fresh context. Save findings and evidence on the slice. Use `single-family` if returned. Never claim another family.

Each push: [checkpoint](../forge-build/pull-request.md#checkpoints) `review` SHA/time, round in `next`, before replies.

## On each wake: conflicts, then threads, then CI

1. First run `forge pr state <n>` and act on `verdict`. Read checkpoint push SHA/time and round. Merge the base branch into a PR branch only to resolve a conflict or after a queue rejection. In the merge message, write `Merge-reason: conflict` or `Merge-reason: queue-rejection`. Resolve conflicts locally, commit and run `forge-build`'s Final-head proof before push. Never rebase a pushed branch or force-push.
2. Get `<owner> <repo>` from `gh repo view --json owner,name`. List unresolved threads via `node <skill-dir>/list-threads.mjs <owner> <repo> <n>`. Read full comments and timestamps via `gh api repos/{owner}/{repo}/pulls/<n>/comments --paginate` before deciding.
3. Triage comments and checks newer than the last push only. Verify old fixes at head before closing with `Fixed in <sha>`. Other old threads wait for new evidence.

## Each finding

1. Check the source; bots can be wrong. Cite the line that shows it.
2. Fix only P0, P1 findings on lines this PR changed, inside the slice's done boundary.
3. Everything else (P2, P3, or outside the boundary) is filed. Search open issues by symptom. Comment on a match or `forge issue create --input '{"title":"...","kind":"task","labels":["review-deferred","p2"],"parent":"<epic>","body":"from <pr url> thread <id>"}'`.
4. Let the run finish, collect its failures, fix the batch, then push once. Stop after three failed runs and escalate. Commit thread and CI fixes together. Run `forge-build`'s Final-head proof before pushing.

## Reply and resolve every answered thread

Read [thread-helpers.md](thread-helpers.md) before replying or resolving.

## Red checks

No in-run retries or raised timeouts. Only known flakes qualify for a rerun. Rerun a failed CI run at most once, only to classify the failure. A rerun pass proves a flake. Find or file one issue per signature (job, test, first error line). Comment and count each repeat. Close only on a root-cause fix and deterministic regression test or proof it cannot occur.

1. `gh pr checks <n>`, then `gh run view <run> --log-failed`.
2. Classify only attempt-one jobs (`gh run rerun <run> --failed`). A second failure blocks handoff.
3. Still red on base with the same signature (`gh run list --branch <base>`, then `gh run view <base-run> --log-failed`)? File or comment on the issue and label it. A different signature is this PR's failure and goes to step 4.
4. Otherwise, fix it in the batch.

## Round budget and handoff

- One round is one triage pass plus one push. Log it: `forge issue comment --input '{"id":"<slice>","body":"review round <k>: fixed ..., filed ...; push <sha> at <time>"}'`.
- At most 2 rounds. After round 2, split or re-plan new blockers with the orchestrator.
- No sleep loop. After each push, run `forge agent wait <n>`. For `t3-tool`, skip its steps (watch active). Otherwise do each step and follow `then`.
- When checks pass and no threads remain, hand off to `forge-land`.
