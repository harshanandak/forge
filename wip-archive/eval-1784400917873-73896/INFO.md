# eval-1784400917873-73896

- source: (local branch, no worktree)
- branch: eval-1784400917873-73896
- HEAD: 1676e7172a3a73cec18ed22c30e23d4da8889237
- last commit: 2026-07-19T00:14:53+05:30 "fix(skills): overlap tie-break only + post-budget title fence (W1)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 8
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/eval-1784400917873-73896 1676e7172a3a   # if the sha still exists locally; else start from origin/master
git am wip-archive/eval-1784400917873-73896/commits/*.patch
git apply wip-archive/eval-1784400917873-73896/uncommitted.diff
cp -r wip-archive/eval-1784400917873-73896/untracked/. .
```
