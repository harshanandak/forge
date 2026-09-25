# feat/comment-back

- source: (local branch, no worktree)
- branch: feat/comment-back
- HEAD: 8311d8f8273db0eab8fd7a46e7cd1397423e8359
- last commit: 2026-07-13T18:30:17+05:30 "perf(inbox): bounded collectInbox + accumulation-safe UserPromptSubmit nudge (CodeRabbit #379)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- also covers (their unique commits are a subset of this one): pr379-review
- excluded: none

## restore

```
git switch -c restore/feat__comment-back 8311d8f8273d   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__comment-back/commits/*.patch
git apply wip-archive/feat__comment-back/uncommitted.diff
cp -r wip-archive/feat__comment-back/untracked/. .
```
