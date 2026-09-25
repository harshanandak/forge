# feat/grounding-p1

- source: (local branch, no worktree)
- branch: feat/grounding-p1
- HEAD: dbe1bc88fa4edba9955e84be41aefd24c5d95709
- last commit: 2026-07-16T19:08:11+05:30 "fix(grounding): close kernel driver after context-event I/O (Windows EBUSY)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__grounding-p1 dbe1bc88fa4e   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__grounding-p1/commits/*.patch
git apply wip-archive/feat__grounding-p1/uncommitted.diff
cp -r wip-archive/feat__grounding-p1/untracked/. .
```
