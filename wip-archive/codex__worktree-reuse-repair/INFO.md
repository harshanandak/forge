# codex/worktree-reuse-repair

- source: (local branch, no worktree)
- branch: codex/worktree-reuse-repair
- HEAD: 345ff5ac58a8668c067b2690a4eb9f8fb23539d6
- last commit: 2026-08-04T17:24:36+05:30 "test(worktree): handle unsupported directory links cb8c7ab6"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__worktree-reuse-repair 345ff5ac58a8   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__worktree-reuse-repair/commits/*.patch
git apply wip-archive/codex__worktree-reuse-repair/uncommitted.diff
cp -r wip-archive/codex__worktree-reuse-repair/untracked/. .
```
