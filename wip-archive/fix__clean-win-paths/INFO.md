# fix/clean-win-paths

- source: (local branch, no worktree)
- branch: fix/clean-win-paths
- HEAD: 770723f49ec8744466c2f7c38a63d54b4c413782
- last commit: 2026-07-07T18:17:42+05:30 "fix(clean): fold whole worktree key case-insensitively on win32"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__clean-win-paths 770723f49ec8   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__clean-win-paths/commits/*.patch
git apply wip-archive/fix__clean-win-paths/uncommitted.diff
cp -r wip-archive/fix__clean-win-paths/untracked/. .
```
