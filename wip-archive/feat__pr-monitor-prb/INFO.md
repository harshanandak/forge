# feat/pr-monitor-prb

- source: (local branch, no worktree)
- branch: feat/pr-monitor-prb
- HEAD: 51baf820756113083278026ea485ea0603a00dd1
- last commit: 2026-07-13T15:43:42+05:30 "fix(shepherd): guard against same-process duplicate watchers + deterministic sleep tests"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__pr-monitor-prb 51baf8207561   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__pr-monitor-prb/commits/*.patch
git apply wip-archive/feat__pr-monitor-prb/uncommitted.diff
cp -r wip-archive/feat__pr-monitor-prb/untracked/. .
```
