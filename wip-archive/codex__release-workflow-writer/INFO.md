# codex/release-workflow-writer

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/release-workflow-writer
- branch: codex/release-workflow-writer
- HEAD: 030d81e7a7ae8a834c095afd03a6e47edb7a371c
- last commit: 2026-08-11T12:35:04+05:30 "test(release): isolate source head authorization"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 6
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/codex__release-workflow-writer 030d81e7a7ae   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__release-workflow-writer/commits/*.patch
git apply wip-archive/codex__release-workflow-writer/uncommitted.diff
cp -r wip-archive/codex__release-workflow-writer/untracked/. .
```
