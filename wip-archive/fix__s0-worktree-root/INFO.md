# fix/s0-worktree-root

- source: (local branch, no worktree)
- branch: fix/s0-worktree-root
- HEAD: 5d0e6e94695b7ce9f34d477de5f710de30ea8a72
- last commit: 2026-07-31T22:19:47+05:30 "test: assert rooted worktree git calls"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__s0-worktree-root 5d0e6e94695b   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__s0-worktree-root/commits/*.patch
git apply wip-archive/fix__s0-worktree-root/uncommitted.diff
cp -r wip-archive/fix__s0-worktree-root/untracked/. .
```
