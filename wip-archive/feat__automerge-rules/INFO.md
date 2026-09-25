# feat/automerge-rules

- source: (local branch, no worktree)
- branch: feat/automerge-rules
- HEAD: 280b0f472d51ff2df0230c23f187159ae57945d5
- last commit: 2026-07-04T23:42:51+05:30 "docs(merge): align checks_green comment with isCheckGreen success class"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 7
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__automerge-rules 280b0f472d51   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__automerge-rules/commits/*.patch
git apply wip-archive/feat__automerge-rules/uncommitted.diff
cp -r wip-archive/feat__automerge-rules/untracked/. .
```
