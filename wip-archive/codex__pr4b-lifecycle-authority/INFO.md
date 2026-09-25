# codex/pr4b-lifecycle-authority

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr4b-lifecycle-authority
- branch: codex/pr4b-lifecycle-authority
- HEAD: 6e0bb1011b9df8c3b3405267c10dbc3fa79ebb93
- last commit: 2026-08-12T18:24:40+05:30 "fix(kernel): validate atomic receipt identity"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 39
- uncommitted: 2 entries (1 untracked); untracked copied: 1
- also covers (their unique commits are a subset of this one): codex/pr4b-b3-restart, codex/pr4b-flow-monitor
- excluded: none

## restore

```
git switch -c restore/codex__pr4b-lifecycle-authority 6e0bb1011b9d   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr4b-lifecycle-authority/commits/*.patch
git apply wip-archive/codex__pr4b-lifecycle-authority/uncommitted.diff
cp -r wip-archive/codex__pr4b-lifecycle-authority/untracked/. .
```
