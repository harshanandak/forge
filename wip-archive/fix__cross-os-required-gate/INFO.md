# fix/cross-os-required-gate

- source: (local branch, no worktree)
- branch: fix/cross-os-required-gate
- HEAD: 8b180473f851c28558db5b4454e942a3e0123791
- last commit: 2026-07-05T15:49:23+05:30 "ci: run tests on skills/ changes + fix stale plan-skill assertion"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__cross-os-required-gate 8b180473f851   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__cross-os-required-gate/commits/*.patch
git apply wip-archive/fix__cross-os-required-gate/uncommitted.diff
cp -r wip-archive/fix__cross-os-required-gate/untracked/. .
```
