# codex/pr4b-exact-head-verdict

- source: (local branch, no worktree)
- branch: codex/pr4b-exact-head-verdict
- HEAD: 1ae8be406b8b22ef81d670ccd45aad44a995c86e
- last commit: 2026-08-11T04:20:05+05:30 "fix(pr-monitor): honor wildcard required checks"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 5
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__pr4b-exact-head-verdict 1ae8be406b8b   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr4b-exact-head-verdict/commits/*.patch
git apply wip-archive/codex__pr4b-exact-head-verdict/uncommitted.diff
cp -r wip-archive/codex__pr4b-exact-head-verdict/untracked/. .
```
