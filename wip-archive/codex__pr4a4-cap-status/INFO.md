# codex/pr4a4-cap-status

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr4a4-cap-status
- branch: codex/pr4a4-cap-status
- HEAD: d19dd570a8d18f26574a1b97540035df6a0e7dcc
- last commit: 2026-08-10T22:17:17+05:30 "fix(flow): preserve incomplete cap outcomes"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0 (tip is on origin as origin/codex/pr4a4-cap-status; not patch-archived)
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/codex__pr4a4-cap-status d19dd570a8d1   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr4a4-cap-status/commits/*.patch
git apply wip-archive/codex__pr4a4-cap-status/uncommitted.diff
cp -r wip-archive/codex__pr4a4-cap-status/untracked/. .
```
