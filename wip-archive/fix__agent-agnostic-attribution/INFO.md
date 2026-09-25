# fix/agent-agnostic-attribution

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/agent-agnostic-attribution
- branch: fix/agent-agnostic-attribution
- HEAD: 9c4d7291881e1514959c2a178827ec160001f08e
- last commit: 2026-07-31T19:36:11+05:30 "fix(skills): remove provider-specific attribution"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__agent-agnostic-attribution 9c4d7291881e   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__agent-agnostic-attribution/commits/*.patch
git apply wip-archive/fix__agent-agnostic-attribution/uncommitted.diff
cp -r wip-archive/fix__agent-agnostic-attribution/untracked/. .
```
