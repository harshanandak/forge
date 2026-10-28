---
name: forge-review
description: "Triage PR conflicts, threads and CI on each harness wake."
---

# forge-review

If a worker brief says stop after push or after the PR opens, stop there, overriding later steps; leave PR linking and CI watching to the orchestrator.

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
4. Batch and commit thread/CI fixes. Run `forge-build`'s Final-head proof section on that commit, then send one push wave.

## Reply and resolve every answered thread

Read [thread-helpers.md](thread-helpers.md) before replying or resolving, including reply failures and null comment ids.

## Red checks

1. `gh pr checks <n>`, then `gh run view <run> --log-failed`.
2. Red on base too (`gh run list --branch <base>`)? File or comment on the issue and label it. For a confirmed flake on base or head, Rerun up to 1 time: one fresh build with `gh run rerun <run> --failed`; another failure blocks handoff. Never fix an unrelated base bug in this PR.
3. Red only here: fix it like a finding, in the same push wave.

## Round budget and handoff

- One round is one triage pass plus one push. Log it: `forge issue comment --input '{"id":"<slice>","body":"review round <k>: fixed ..., filed ...; push <sha> at <time>"}'`.
- At most 2 rounds. After round 2, a new blocker means split or re-plan with the orchestrator instead of a round 3.
- No sleep loop. After each push, run `forge agent wait <n>`; for `t3-tool`, skip its steps (already watching); otherwise do each step and follow `then`.
- When checks are green and the thread list prints nothing, hand over to `forge-land`.
