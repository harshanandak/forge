---
name: review
description: "Use when an open PR has new checks, comments or review threads, on each wake while it is open. Triages only what is newer than the last push, fixes P0, P1 inside the done boundary, files P2, P3 as issues, replies to and resolves every thread from any author, and stops after 2 rounds."
---

# review

## Read only what is new

1. `gh pr view <n> --json headRefOid,mergeStateStatus,statusCheckRollup,reviewDecision`.
2. Unresolved threads, every page, one JSON line each (thread id, first comment id, path, line, author, short body):

```
gh api graphql --paginate -F owner='{owner}' -F repo='{repo}' -F n=<n> -f query='query($owner:String!,$repo:String!,$n:Int!,$endCursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$n){reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{id isResolved path line comments(first:1){nodes{databaseId author{login} body}}}}}}}' --jq '.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved|not)|{thread:.id,comment:.comments.nodes[0].databaseId,path,line,author:.comments.nodes[0].author.login,body:.comments.nodes[0].body[:200]}'
```

3. Act only on checks and comments newer than your last push. Older ones were handled or are waiting on that push.

## Each finding

1. Check it against the source. A bot can be wrong; say so with the line that shows it.
2. Fix only P0, P1 findings on lines this PR changed, inside the slice's done boundary.
3. Everything else (P2, P3, or outside the boundary) is filed, not fixed: `forge issue create --input '{"title":"...","kind":"task","labels":["review-deferred","p2"],"parent":"<epic>","body":"from <pr url> thread <id>"}'`.
4. Commit and push fixes before replying, so the reply can cite the SHA.

## Reply and resolve every thread

Write the reply to a file with the editor tool, then reply in the thread and resolve it:

```
gh api -X POST repos/{owner}/{repo}/pulls/<n>/comments/<comment id>/replies -F body=@<reply file>
gh api graphql -F id=<thread id> -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' --jq '.data.resolveReviewThread.thread.isResolved'
```

The second must print `true`. Reply text: "Fixed in <sha>: ..." or "Filed as <issue id>: ...", or why the finding does not hold. Every thread, from any author, bot or human. Never resolve a thread you did not fix, file or answer. Run the list again: it must print nothing.

## Red checks

1. `gh pr checks <n>`, then `gh run view <run> --log-failed`.
2. Red on base too (`gh run list --branch <base>`)? Not this PR's bug. Rerun up to 1 time with `gh run rerun <run> --failed`, file or comment on the flake issue, and label it. Never fix it in this PR.
3. Red only here: fix it like a finding.
4. Behind base: `gh pr update-branch <n>`. Never rebase a pushed branch, never force-push.

## Round budget

- One round is one triage pass plus one push. Log it: `forge issue comment --input '{"id":"<slice>","body":"review round <k>: fixed ..., filed ..."}'`.
- At most 2 rounds. After the last, a new blocker means split or re-plan with the orchestrator, not another round.
- When checks are green and the list prints nothing, hand over to `land`.
