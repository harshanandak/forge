# eval-1786147569042-103152

- source: (local branch, no worktree)
- branch: eval-1786147569042-103152
- HEAD: 252a9232f65f9644975a8fbd0eb6c244cbaa1f74
- last commit: 2026-08-08T05:28:26+05:30 "fix: stabilize Windows lefthook repair tests"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- also covers (their unique commits are a subset of this one): eval-1786147578866-103152
- excluded: none

## restore

```
git switch -c restore/eval-1786147569042-103152 252a9232f65f   # if the sha still exists locally; else start from origin/master
git am wip-archive/eval-1786147569042-103152/commits/*.patch
git apply wip-archive/eval-1786147569042-103152/uncommitted.diff
cp -r wip-archive/eval-1786147569042-103152/untracked/. .
```
