# eval-1784138193867-53340

- source: (local branch, no worktree)
- branch: eval-1784138193867-53340
- HEAD: 5324c61e66f0da11136e954a9f43439ca351df69
- last commit: 2026-07-15T22:56:02+05:30 "fix(plan): direct fresh branch into isolated checkout; keep HEAD unswitched"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- also covers (their unique commits are a subset of this one): feat/aa14966c-6fcb-42e5-bd54-44ea851db703, eval-1784119998802-48932
- excluded: none

## restore

```
git switch -c restore/eval-1784138193867-53340 5324c61e66f0   # if the sha still exists locally; else start from origin/master
git am wip-archive/eval-1784138193867-53340/commits/*.patch
git apply wip-archive/eval-1784138193867-53340/uncommitted.diff
cp -r wip-archive/eval-1784138193867-53340/untracked/. .
```
