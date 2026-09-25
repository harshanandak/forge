# pr425

- source: (local branch, no worktree)
- branch: pr425
- HEAD: e8db5c967a6afae885e0fc457f7c9bd2afba2a9c
- last commit: 2026-07-20T13:07:50+05:30 "fix(pr-monitor): auto-update-branch uses re-triggering token (CI-dead-head)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/pr425 e8db5c967a6a   # if the sha still exists locally; else start from origin/master
git am wip-archive/pr425/commits/*.patch
git apply wip-archive/pr425/uncommitted.diff
cp -r wip-archive/pr425/untracked/. .
```
