# feat/shepherd-owner-authority

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/shepherd-owner-authority
- branch: feat/shepherd-owner-authority
- HEAD: 448760cbb29a3ce32bcd32e45e9bfbfbd23641c1
- last commit: 2026-08-20T00:17:57+05:30 "fix(shepherd): block unverified legacy evidence"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/feat__shepherd-owner-authority 448760cbb29a   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__shepherd-owner-authority/commits/*.patch
git apply wip-archive/feat__shepherd-owner-authority/uncommitted.diff
cp -r wip-archive/feat__shepherd-owner-authority/untracked/. .
```
