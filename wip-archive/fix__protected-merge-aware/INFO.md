# fix/protected-merge-aware

- source: (local branch, no worktree)
- branch: fix/protected-merge-aware
- HEAD: a111bbb93326987d87a7a43702087797ef94217d
- last commit: 2026-09-10T14:29:14+05:30 "fix: verify advertised upstream head"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 13
- uncommitted: none
- also covers (their unique commits are a subset of this one): tmp-pr546-3qslhx, feat/pr546-merge-exempt-k7x2p9
- excluded: none

## restore

```
git switch -c restore/fix__protected-merge-aware a111bbb93326   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__protected-merge-aware/commits/*.patch
git apply wip-archive/fix__protected-merge-aware/uncommitted.diff
cp -r wip-archive/fix__protected-merge-aware/untracked/. .
```
