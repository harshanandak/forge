---
name: forge-review
description: "Triage PR conflicts, threads and CI on each harness wake."
---

# forge-review

If a worker brief says stop after push or PR open, link an open PR to the issue, release the claim, then stop; leave thread linking and CI watching to the orchestrator.

## Heavy proof

Before heavy or critical PRs, read `forge route get review --text`. Count it with `forge issue call <slice> --role review`; LIMIT_REACHED stops the intent. Retry REVISION_CONFLICT. Pass returned timeboxMinutes and stopBy. Tell the subagent to stop and report the checkpoint when timeboxMinutes expire, never later than stopBy. Use the route to review the diff, saved trunk/head scenario output and every acceptance item in fresh context. Save findings/evidence on the slice, with `single-family` if returned; never claim another family.

Each push: [checkpoint](../forge-build/pull-request.md#checkpoints) `review` SHA/time, round in `next`, before replies.

## On each wake: conflicts, then threads, then CI

1. On wake, run `forge pr state <n>` and act on `verdict`. Read checkpoint's last push SHA/time and round before triage. Use `gh pr update-branch <n>` only for a clean behind-base update. For conflicts, merge base locally, resolve, commit, run `forge-build`'s Final-head proof, then push. Never rebase a pushed branch or force-push.
2. Get `<owner> <repo>` from `gh repo view --json owner,name`. List unresolved threads: `node <skill-dir>/list-threads.mjs <owner> <repo> <n>`. Read full comments and timestamps with `gh api repos/{owner}/{repo}/pulls/<n>/comments --paginate` before deciding.
3. Triage only comments and checks newer than the last push. Verify an old thread is fixed at head before closing with `Fixed in <sha>`. Other old threads wait for new evidence; age never justifies resolution.

## Each finding

1. Check the source; bots can be wrong. Cite the line that shows it.
2. Fix only P0, P1 findings on lines this PR changed, inside the slice's done boundary.
3. Everything else (P2, P3, or outside the boundary) is filed, not fixed. Search open issues for the symptom, then comment on a match or `forge issue create --input '{"title":"...","kind":"task","labels":["review-deferred","p2"],"parent":"<epic>","body":"from <pr url> thread <id>"}'`.
4. Commit thread and CI fixes together, run `forge-build`'s Final-head proof, and push once.

## Reply and resolve every answered thread

Read [thread-helpers.md](thread-helpers.md) before replying or resolving.

## Red checks

No in-run test or check retries, retry loops, or raised timeouts. Rerun a failed CI run at most once, only to classify the failure. A pass on rerun confirms a flake. Keep the check enabled and the fix open. Find or file one issue per signature (job, test, first error line). Comment there and increment its count on every repeat. Close only with a root-cause fix and deterministic regression test, or proof the named failure mechanism cannot happen.

1. `gh pr checks <n>`, then `gh run view <run> --log-failed`.
2. Classify only jobs that started in attempt one (`gh run rerun <run> --failed`). A second failure blocks handoff.
3. Still red on base (`gh run list --branch <base>`)? File or comment on the issue and label it. Keep unrelated fixes out of this PR.
4. Still red only here? Fix it in the same push wave.

## Round budget and handoff

- One round is one triage pass plus one push. Log it: `forge issue comment --input '{"id":"<slice>","body":"review round <k>: fixed ..., filed ...; push <sha> at <time>"}'`.
- At most 2 rounds. After round 2, a new blocker means split or re-plan with the orchestrator instead of a round 3.
- No sleep loop. After each push, run `forge agent wait <n>`; for `t3-tool`, skip its steps (already watching); otherwise do each step and follow `then`.
- When checks are green and the thread list prints nothing, hand over to `forge-land`.
