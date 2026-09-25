# fix/kernel-native-stage-gate

- source: (local branch, no worktree)
- branch: fix/kernel-native-stage-gate
- HEAD: 3209ebfe4f6ccd4ae2d565661588c0e914921474
- last commit: 2026-07-03T17:43:58+05:30 "Merge branch 'master' into fix/kernel-native-stage-gate"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__kernel-native-stage-gate 3209ebfe4f6c   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__kernel-native-stage-gate/commits/*.patch
git apply wip-archive/fix__kernel-native-stage-gate/uncommitted.diff
cp -r wip-archive/fix__kernel-native-stage-gate/untracked/. .
```
