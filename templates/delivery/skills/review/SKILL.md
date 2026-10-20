---
name: review
description: "Use when an open PR has new checks, comments or review threads, on each wake while it is open. Triages only what is newer than the last push, fixes {{values.review.fix}} inside the done boundary, files {{values.review.file}} as issues, replies to and resolves every thread from any author, and stops after {{values.review.rounds}} rounds."
---

# review

## Read only what is new

1. `gh pr view <n> --json headRefOid,mergeStateStatus,statusCheckRollup,reviewDecision`.
2. Threads: `node {{values.helpers}}/review-threads.mjs <n>` prints the unresolved ones as JSON: thread id, comment id, path, line, author, short body.
3. Act only on checks and comments newer than your last push. Older ones were handled or are waiting on that push.

## Each finding

1. Check it against the source. A bot can be wrong; say so with the line that shows it.
2. Fix only {{values.review.fix}} findings on lines this PR changed, inside the slice's done boundary.
3. Everything else ({{values.review.file}}, or outside the boundary) is filed, not fixed: `forge issue create --input '{"title":"...","kind":"task","labels":["{{values.labels.deferred}}","p2"],"parent":"<epic>","body":"from <pr url> thread <id>"}'`.
4. Commit and push fixes before replying, so the reply can cite the SHA.

## Reply and resolve every thread

Write the reply to a file with the editor tool, then:

```
node {{values.helpers}}/resolve-thread.mjs <n> <comment id> <thread id> <reply file>
```

It posts the reply in the thread and resolves it, and fails unless GitHub reads the thread back as resolved. Reply text: "Fixed in <sha>: ..." or "Filed as <issue id>: ...", or why the finding does not hold. Every thread, from any author, bot or human. Never resolve a thread you did not fix, file or answer. Run the list again: it must print `[]`.

## Red checks

1. `gh pr checks <n>`, then `gh run view <run> --log-failed`.
2. Red on base too (`gh run list --branch <base>`)? Not this PR's bug. Rerun up to {{values.review.reruns}} time with `gh run rerun <run> --failed`, file or comment on the flake issue, and label it. Never fix it in this PR.
3. Red only here: fix it like a finding.
4. Behind base: `gh pr update-branch <n>`. Never rebase a pushed branch, never force-push.

## Round budget

- One round is one triage pass plus one push. Log it: `forge issue comment --input '{"id":"<slice>","body":"review round <k>: fixed ..., filed ..."}'`.
- At most {{values.review.rounds}} rounds. After the last, a new blocker means split or re-plan with the orchestrator, not another round.
- When checks are green and the list prints `[]`, hand over to `land`.
