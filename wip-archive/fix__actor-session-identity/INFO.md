# fix/actor-session-identity

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/actor-session-identity
- branch: fix/actor-session-identity
- HEAD: 4df1e1195fc80bf6c67959a6f1d089cffe3be0c5
- last commit: 2026-08-30T14:17:09+05:30 "fix: make issue identity resolution explicit"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0 (tip is on origin as origin/fix/actor-session-identity; not patch-archived)
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/fix__actor-session-identity 4df1e1195fc8   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__actor-session-identity/commits/*.patch
git apply wip-archive/fix__actor-session-identity/uncommitted.diff
cp -r wip-archive/fix__actor-session-identity/untracked/. .
```
