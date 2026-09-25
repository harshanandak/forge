# fix/status-reads-kernel

- source: (local branch, no worktree)
- branch: fix/status-reads-kernel
- HEAD: 82699caa5efdc03221127f76ae8a56a9fa88b837
- last commit: 2026-07-06T11:56:12+05:30 "test(status): drop redundant in-process handler guard (superseded by e2e revert guard)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__status-reads-kernel 82699caa5efd   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__status-reads-kernel/commits/*.patch
git apply wip-archive/fix__status-reads-kernel/uncommitted.diff
cp -r wip-archive/fix__status-reads-kernel/untracked/. .
```
