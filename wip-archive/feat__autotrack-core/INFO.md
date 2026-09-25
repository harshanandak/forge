# feat/autotrack-core

- source: (local branch, no worktree)
- branch: feat/autotrack-core
- HEAD: 9f803c54937163f6beadbe1c786323a39286d2eb
- last commit: 2026-07-06T18:40:42+05:30 "fix(kernel): report linked:false when branch->issue link fails to persist"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__autotrack-core 9f803c549371   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__autotrack-core/commits/*.patch
git apply wip-archive/feat__autotrack-core/uncommitted.diff
cp -r wip-archive/feat__autotrack-core/untracked/. .
```
