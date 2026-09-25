# feat/0ea7da6f-4ceb-482a-abf9-d404c55bb114

- source: (local branch, no worktree)
- branch: feat/0ea7da6f-4ceb-482a-abf9-d404c55bb114
- HEAD: 225ad4d2269e4ff821ff4eb5fb4a8b0942fb4c34
- last commit: 2026-07-15T17:04:13+05:30 "fix(kernel): make findExistingLink state-aware (R5 — third resolver)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__0ea7da6f-4ceb-482a-abf9-d404c55bb114 225ad4d2269e   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__0ea7da6f-4ceb-482a-abf9-d404c55bb114/commits/*.patch
git apply wip-archive/feat__0ea7da6f-4ceb-482a-abf9-d404c55bb114/uncommitted.diff
cp -r wip-archive/feat__0ea7da6f-4ceb-482a-abf9-d404c55bb114/untracked/. .
```
