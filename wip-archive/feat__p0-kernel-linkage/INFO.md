# feat/p0-kernel-linkage

- source: (local branch, no worktree)
- branch: feat/p0-kernel-linkage
- HEAD: c837558fd8f63d00572c7792f5451f2b9199d7cb
- last commit: 2026-07-04T16:29:11+05:30 "fix(worktree): ignore literal HEAD from detached worktree when recording branch"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__p0-kernel-linkage c837558fd8f6   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__p0-kernel-linkage/commits/*.patch
git apply wip-archive/feat__p0-kernel-linkage/uncommitted.diff
cp -r wip-archive/feat__p0-kernel-linkage/untracked/. .
```
