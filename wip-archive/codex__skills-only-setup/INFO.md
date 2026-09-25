# codex/skills-only-setup

- source: (local branch, no worktree)
- branch: codex/skills-only-setup
- HEAD: 998ac1d1e3052f4711355614c343c935f628dbf8
- last commit: 2026-08-04T16:39:27+05:30 "test(setup): cover default skills setup path"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__skills-only-setup 998ac1d1e305   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__skills-only-setup/commits/*.patch
git apply wip-archive/codex__skills-only-setup/uncommitted.diff
cp -r wip-archive/codex__skills-only-setup/untracked/. .
```
