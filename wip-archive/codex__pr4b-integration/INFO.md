# codex/pr4b-integration

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr4b-integration
- branch: codex/pr4b-integration
- HEAD: 58c62bda40d5f5f47833d945a0d7ea52a5581cc5
- last commit: 2026-08-19T03:45:19+05:30 "test: isolate merge authority repository seam"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 53
- uncommitted: 5 entries (5 untracked); untracked copied: 3
- excluded: 
  - secret scan: dropped from commits/0043-fix-monitor-sanitize-durable-provider-evidence.patch: test/pr-monitor/flow-monitor.test.js (password-literal); local copy kept outside the repo
- untracked not copied (2):
  - .forge/kernel/comments.jsonl (848KB > 256KB)
  - .forge/kernel/issues.jsonl (1404KB > 256KB)

## restore

```
git switch -c restore/codex__pr4b-integration 58c62bda40d5   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr4b-integration/commits/*.patch
git apply wip-archive/codex__pr4b-integration/uncommitted.diff
cp -r wip-archive/codex__pr4b-integration/untracked/. .
```
