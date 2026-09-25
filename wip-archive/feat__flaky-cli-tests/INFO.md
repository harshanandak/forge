# feat/flaky-cli-tests

- source: (local branch, no worktree)
- branch: feat/flaky-cli-tests
- HEAD: 7dae67b5f15914c928b82d55ac6da50c755c6db2
- last commit: 2026-07-28T15:39:40+05:30 "fix(test): scrub mixed-case ambient Forge env"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 5
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__flaky-cli-tests 7dae67b5f159   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__flaky-cli-tests/commits/*.patch
git apply wip-archive/feat__flaky-cli-tests/uncommitted.diff
cp -r wip-archive/feat__flaky-cli-tests/untracked/. .
```
