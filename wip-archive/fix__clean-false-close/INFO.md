# fix/clean-false-close

- source: (local branch, no worktree)
- branch: fix/clean-false-close
- HEAD: cb0d8c2c54c0f9d69fdcbbbfa1f05a94891c0755
- last commit: 2026-07-26T13:46:47+05:30 "chore(skills): regenerate worktree scorecard after clean safety docs"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__clean-false-close cb0d8c2c54c0   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__clean-false-close/commits/*.patch
git apply wip-archive/fix__clean-false-close/uncommitted.diff
cp -r wip-archive/fix__clean-false-close/untracked/. .
```
