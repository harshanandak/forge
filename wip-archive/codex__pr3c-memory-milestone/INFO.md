# codex/pr3c-memory-milestone

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr3c-memory-milestone
- branch: codex/pr3c-memory-milestone
- HEAD: 2b80cde47c126411ee5f6ed77cc81babb5e21a79
- last commit: 2026-08-10T17:38:06+05:30 "fix: reject missing claim and dependency endpoints"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 12
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- also covers (their unique commits are a subset of this one): codex/pr3c-monitor-schema, codex/pr3c-usage-schema
- excluded: none

## restore

```
git switch -c restore/codex__pr3c-memory-milestone 2b80cde47c12   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr3c-memory-milestone/commits/*.patch
git apply wip-archive/codex__pr3c-memory-milestone/uncommitted.diff
cp -r wip-archive/codex__pr3c-memory-milestone/untracked/. .
```
