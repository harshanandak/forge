# feat/12b00157-07a2-4431-99c2-14dd640eb225

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/12b00157-07a2-4431-99c2-14dd640eb225
- branch: feat/12b00157-07a2-4431-99c2-14dd640eb225
- HEAD: 9a5f2ee074521e4f12f14406bb97ece9937762df
- last commit: 2026-07-14T13:57:02+05:30 "fix(gates): close 2 fail-open holes on the preflight remedy path (R1/R2)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: 2 entries (2 untracked); untracked copied: 2
- excluded: none

## restore

```
git switch -c restore/feat__12b00157-07a2-4431-99c2-14dd640eb225 9a5f2ee07452   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__12b00157-07a2-4431-99c2-14dd640eb225/commits/*.patch
git apply wip-archive/feat__12b00157-07a2-4431-99c2-14dd640eb225/uncommitted.diff
cp -r wip-archive/feat__12b00157-07a2-4431-99c2-14dd640eb225/untracked/. .
```
