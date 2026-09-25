# codex/bun-proof-long-path

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge-worktrees/forge-bun-proof-long-path
- branch: codex/bun-proof-long-path
- HEAD: f73cc14ea7f2146d76ed80ef0b45630621487b2c
- last commit: 2026-08-10T02:37:00+05:30 "fix: use native path resolution for Bun proof roots"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/codex__bun-proof-long-path f73cc14ea7f2   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__bun-proof-long-path/commits/*.patch
git apply wip-archive/codex__bun-proof-long-path/uncommitted.diff
cp -r wip-archive/codex__bun-proof-long-path/untracked/. .
```
