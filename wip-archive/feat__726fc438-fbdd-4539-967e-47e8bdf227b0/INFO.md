# feat/726fc438-fbdd-4539-967e-47e8bdf227b0

- source: (local branch, no worktree)
- branch: feat/726fc438-fbdd-4539-967e-47e8bdf227b0
- HEAD: e467be0c9e95f7cc09594e3ddbda78436b8fe679
- last commit: 2026-07-15T12:50:11+05:30 "chore(beads): regenerate stale D20 bd-call-site-kill-list.md"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__726fc438-fbdd-4539-967e-47e8bdf227b0 e467be0c9e95   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__726fc438-fbdd-4539-967e-47e8bdf227b0/commits/*.patch
git apply wip-archive/feat__726fc438-fbdd-4539-967e-47e8bdf227b0/uncommitted.diff
cp -r wip-archive/feat__726fc438-fbdd-4539-967e-47e8bdf227b0/untracked/. .
```
