# fix/skills-accuracy

- source: (local branch, no worktree)
- branch: fix/skills-accuracy
- HEAD: 74bd940056041e9f03b7d13eefcc8fecfc65da84
- last commit: 2026-07-03T21:50:38+05:30 "fix: skills accuracy pass — backend-accurate plan labels, symlink-safe skill sync"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__skills-accuracy 74bd94005604   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__skills-accuracy/commits/*.patch
git apply wip-archive/fix__skills-accuracy/uncommitted.diff
cp -r wip-archive/fix__skills-accuracy/untracked/. .
```
