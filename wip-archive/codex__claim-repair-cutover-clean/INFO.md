# codex/claim-repair-cutover-clean

- source: (local branch, no worktree)
- branch: codex/claim-repair-cutover-clean
- HEAD: 3b620e1948893a2bd0a018a006c09609427f6f51
- last commit: 2026-08-13T01:58:31+05:30 "fix(kernel): reject aliased repair recovery"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 13
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__claim-repair-cutover-clean 3b620e194889   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__claim-repair-cutover-clean/commits/*.patch
git apply wip-archive/codex__claim-repair-cutover-clean/uncommitted.diff
cp -r wip-archive/codex__claim-repair-cutover-clean/untracked/. .
```
