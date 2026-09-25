# feat/shepherd-owner-cutover

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/shepherd-owner-cutover
- branch: feat/shepherd-owner-cutover
- HEAD: 6bc004e95fc7c4d047cdd95b00e0f6a4b5d87c26
- last commit: 2026-08-26T20:03:54+05:30 "fix(shepherd): hash marker-only legacy directories in the cutover gate"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 18
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/feat__shepherd-owner-cutover 6bc004e95fc7   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__shepherd-owner-cutover/commits/*.patch
git apply wip-archive/feat__shepherd-owner-cutover/uncommitted.diff
cp -r wip-archive/feat__shepherd-owner-cutover/untracked/. .
```
