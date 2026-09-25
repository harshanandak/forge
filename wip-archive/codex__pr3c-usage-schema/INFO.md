# codex/pr3c-usage-schema

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr3c-usage-schema
- branch: codex/pr3c-usage-schema
- HEAD: 0f03d4a4c44c03f31d4dca7ab7d241fa27d0bfe6
- last commit: 2026-08-10T13:02:21+05:30 "feat(memory): add durable usage evidence seam"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/codex__pr3c-usage-schema 0f03d4a4c44c   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr3c-usage-schema/commits/*.patch
git apply wip-archive/codex__pr3c-usage-schema/uncommitted.diff
cp -r wip-archive/codex__pr3c-usage-schema/untracked/. .
```
