# feat/skills-batch1

- source: (local branch, no worktree)
- branch: feat/skills-batch1
- HEAD: fc5ce47293d08f32cbf241424b4b3854ed43e6eb
- last commit: 2026-07-21T17:32:36+05:30 "fix(worktree): hide on-disk-removed worktrees from 'list' output"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 13
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__skills-batch1 fc5ce47293d0   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__skills-batch1/commits/*.patch
git apply wip-archive/feat__skills-batch1/uncommitted.diff
cp -r wip-archive/feat__skills-batch1/untracked/. .
```
