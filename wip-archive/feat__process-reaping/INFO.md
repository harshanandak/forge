# feat/process-reaping

- source: (local branch, no worktree)
- branch: feat/process-reaping
- HEAD: f74759d99d12c46d0d6a1f377d8997e264b2b245
- last commit: 2026-08-04T20:51:19+05:30 "test(process): declare macOS-only case"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 8
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__process-reaping f74759d99d12   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__process-reaping/commits/*.patch
git apply wip-archive/feat__process-reaping/uncommitted.diff
cp -r wip-archive/feat__process-reaping/untracked/. .
```
