# feat/memory-recall-s0

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/s0-memory-recall
- branch: feat/memory-recall-s0
- HEAD: f216406b5eb1652cb667b733a02132ab16f1380a
- last commit: 2026-07-31T14:46:29+05:30 "fix(memory): bound schema setup lock wait"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 29
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/feat__memory-recall-s0 f216406b5eb1   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__memory-recall-s0/commits/*.patch
git apply wip-archive/feat__memory-recall-s0/uncommitted.diff
cp -r wip-archive/feat__memory-recall-s0/untracked/. .
```
