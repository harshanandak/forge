# fix/s0-packaged-dispatch

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/s0-packaged-dispatch
- branch: fix/s0-packaged-dispatch
- HEAD: 7a22b751171860edd1f635f836ead0b21efc5ab9
- last commit: 2026-08-01T13:21:01+05:30 "fix: reconcile shepherd bot review refreshes"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 8
- uncommitted: 6 entries (0 untracked); untracked copied: 0
- also covers (their unique commits are a subset of this one): codex/pr471-release-rebase
- excluded: none

## restore

```
git switch -c restore/fix__s0-packaged-dispatch 7a22b7511718   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__s0-packaged-dispatch/commits/*.patch
git apply wip-archive/fix__s0-packaged-dispatch/uncommitted.diff
cp -r wip-archive/fix__s0-packaged-dispatch/untracked/. .
```
