# fix/p0-scanroot-blocker

- source: (local branch, no worktree)
- branch: fix/p0-scanroot-blocker
- HEAD: febe09f6458c323368a5a7f7a20a7e4cd1b02101
- last commit: 2026-08-06T16:18:07+05:30 "fix: sanitize mixed-case git hook variables"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__p0-scanroot-blocker febe09f6458c   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__p0-scanroot-blocker/commits/*.patch
git apply wip-archive/fix__p0-scanroot-blocker/uncommitted.diff
cp -r wip-archive/fix__p0-scanroot-blocker/untracked/. .
```
