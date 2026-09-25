# feat/slice-a-dashboard

- source: (local branch, no worktree)
- branch: feat/slice-a-dashboard
- HEAD: 879f958edce9632d6f4c547c91532e587ad13015
- last commit: 2026-07-22T18:38:36+05:30 "docs(plan): fix plan-doc review nits"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__slice-a-dashboard 879f958edce9   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__slice-a-dashboard/commits/*.patch
git apply wip-archive/feat__slice-a-dashboard/uncommitted.diff
cp -r wip-archive/feat__slice-a-dashboard/untracked/. .
```
