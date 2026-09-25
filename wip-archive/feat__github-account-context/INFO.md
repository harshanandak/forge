# feat/github-account-context

- source: (local branch, no worktree)
- branch: feat/github-account-context
- HEAD: c168a96102b6af0e2b5ffb209594fad69915b1e9
- last commit: 2026-09-11T05:09:07+05:30 "fix(github): ignore ambient repository overrides"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 33
- uncommitted: none
- also covers (their unique commits are a subset of this one): eval-1789045048971-24388, eval-1789045059803-24388
- excluded: none

## restore

```
git switch -c restore/feat__github-account-context c168a96102b6   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__github-account-context/commits/*.patch
git apply wip-archive/feat__github-account-context/uncommitted.diff
cp -r wip-archive/feat__github-account-context/untracked/. .
```
