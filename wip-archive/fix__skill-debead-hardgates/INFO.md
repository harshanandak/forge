# fix/skill-debead-hardgates

- source: (local branch, no worktree)
- branch: fix/skill-debead-hardgates
- HEAD: 1506c673535c5f66a982318de5a493c47f0011d0
- last commit: 2026-07-04T00:16:59+05:30 "fix(skills): mirror stage-transition envelope + surface real helper failures"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__skill-debead-hardgates 1506c673535c   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__skill-debead-hardgates/commits/*.patch
git apply wip-archive/fix__skill-debead-hardgates/uncommitted.diff
cp -r wip-archive/fix__skill-debead-hardgates/untracked/. .
```
