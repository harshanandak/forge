# worktree-agent-a12848dd7755c7a59

- source: (local branch, no worktree)
- branch: worktree-agent-a12848dd7755c7a59
- HEAD: 168f850bcfdb1d8c1ff2cf939e77f2ef83c75069
- last commit: 2026-06-27T14:41:11+05:30 "refactor(setup): repoint setup to write per-skill dirs from canonical skills/"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 6
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/worktree-agent-a12848dd7755c7a59 168f850bcfdb   # if the sha still exists locally; else start from origin/master
git am wip-archive/worktree-agent-a12848dd7755c7a59/commits/*.patch
git apply wip-archive/worktree-agent-a12848dd7755c7a59/uncommitted.diff
cp -r wip-archive/worktree-agent-a12848dd7755c7a59/untracked/. .
```
