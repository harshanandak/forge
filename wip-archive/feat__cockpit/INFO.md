# feat/cockpit

- source: (local branch, no worktree)
- branch: feat/cockpit
- HEAD: e00aa1440e91d10303ebb8260196ef1559e1c9ee
- last commit: 2026-07-13T16:23:51+05:30 "fix(dashboard): rail rows track real config state + honesty fixes (review)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__cockpit e00aa1440e91   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__cockpit/commits/*.patch
git apply wip-archive/feat__cockpit/uncommitted.diff
cp -r wip-archive/feat__cockpit/untracked/. .
```
