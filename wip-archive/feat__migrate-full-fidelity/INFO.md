# feat/migrate-full-fidelity

- source: (local branch, no worktree)
- branch: feat/migrate-full-fidelity
- HEAD: a9d202d8d3c8e7a4f034bc2debd58b35ac6f5d6d
- last commit: 2026-07-04T07:43:23+05:30 "fix(migrate): derive id-less event/interaction idempotency key from stable fields"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__migrate-full-fidelity a9d202d8d3c8   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__migrate-full-fidelity/commits/*.patch
git apply wip-archive/feat__migrate-full-fidelity/uncommitted.diff
cp -r wip-archive/feat__migrate-full-fidelity/untracked/. .
```
