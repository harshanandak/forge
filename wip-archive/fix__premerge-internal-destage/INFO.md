# fix/premerge-internal-destage

- source: (local branch, no worktree)
- branch: fix/premerge-internal-destage
- HEAD: dc55bbe78421387a1c0ef9068f4873bf8a05d2c1
- last commit: 2026-07-03T17:20:16+05:30 "Merge remote-tracking branch 'origin/master' into fix/premerge-internal-destage"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__premerge-internal-destage dc55bbe78421   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__premerge-internal-destage/commits/*.patch
git apply wip-archive/fix__premerge-internal-destage/uncommitted.diff
cp -r wip-archive/fix__premerge-internal-destage/untracked/. .
```
