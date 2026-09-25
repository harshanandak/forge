# codex/pr5-doctor

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr5-doctor
- branch: codex/pr5-doctor
- HEAD: 1f0b2b9ba12ff98200b3ec317bc72367156e313a
- last commit: 2026-08-11T00:14:34+05:30 "fix(doctor): classify diagnostic reasons"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 10
- uncommitted: none
- excluded: 
  - secret scan: dropped from commits/0007-fix-doctor-fail-closed-on-incomplete-health-eviden.patch: test/health/doctor-runner.test.js (password-literal, api-key-literal); local copy kept outside the repo
  - secret scan: dropped from commits/0008-fix-doctor-validate-and-cancel-provider-probes.patch: test/health/doctor-runner.test.js (password-literal, api-key-literal); local copy kept outside the repo

## restore

```
git switch -c restore/codex__pr5-doctor 1f0b2b9ba12f   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr5-doctor/commits/*.patch
git apply wip-archive/codex__pr5-doctor/uncommitted.diff
cp -r wip-archive/codex__pr5-doctor/untracked/. .
```
