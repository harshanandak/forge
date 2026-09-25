# codex/pr5-integration

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr5-integration
- branch: codex/pr5-integration
- HEAD: 065be8593d0cc71611a4562bbe9eae0b2ae77165
- last commit: 2026-09-12T17:12:15+05:30 "fix(skills): map capabilities to setup guidance"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 7
- uncommitted: none
- excluded: 
  - secret scan: dropped from commits/0002-fix-doctor-fail-closed-on-incomplete-health-eviden.patch: test/health/doctor-runner.test.js (password-literal, api-key-literal); local copy kept outside the repo
  - secret scan: dropped from commits/0003-fix-doctor-validate-and-cancel-provider-probes.patch: test/health/doctor-runner.test.js (password-literal, api-key-literal); local copy kept outside the repo

## restore

```
git switch -c restore/codex__pr5-integration 065be8593d0c   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr5-integration/commits/*.patch
git apply wip-archive/codex__pr5-integration/uncommitted.diff
cp -r wip-archive/codex__pr5-integration/untracked/. .
```
