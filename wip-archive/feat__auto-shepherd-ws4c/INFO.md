# feat/auto-shepherd-ws4c

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/auto-shepherd-ws4c
- branch: feat/auto-shepherd-ws4c
- HEAD: f7f680b275b91a4c8c1fb2d27f5d35b02ff1c069
- last commit: 2026-07-29T15:16:02+05:30 "fix: harden automatic shepherd ownership"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 7
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/feat__auto-shepherd-ws4c f7f680b275b9   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__auto-shepherd-ws4c/commits/*.patch
git apply wip-archive/feat__auto-shepherd-ws4c/uncommitted.diff
cp -r wip-archive/feat__auto-shepherd-ws4c/untracked/. .
```
