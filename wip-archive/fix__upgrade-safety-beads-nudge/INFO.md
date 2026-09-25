# fix/upgrade-safety-beads-nudge

- source: (local branch, no worktree)
- branch: fix/upgrade-safety-beads-nudge
- HEAD: 2ef290730371cdb4608487662e53306ee379e59b
- last commit: 2026-07-06T00:01:11+05:30 "fix(migrate): move migrate require() inside the safety-net try; share one helper"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__upgrade-safety-beads-nudge 2ef290730371   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__upgrade-safety-beads-nudge/commits/*.patch
git apply wip-archive/fix__upgrade-safety-beads-nudge/uncommitted.diff
cp -r wip-archive/fix__upgrade-safety-beads-nudge/untracked/. .
```
