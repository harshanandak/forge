# codex/pr2-memory-contracts-hook-proof

- source: C:/Users/harsha_befach/AppData/Local/Temp/forge-pr2-commit-5957f163eaff4191836e76a112395082/worktree
- branch: codex/pr2-memory-contracts-hook-proof
- HEAD: 72e6322a57e87411e906ac897d84ef00022bc0fd
- last commit: 2026-08-09T23:57:46+05:30 "fix(memory): reject Stripe secret keys"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0
- uncommitted: 5 entries (0 untracked); untracked copied: 0
- excluded: none

## restore

```
git switch -c restore/codex__pr2-memory-contracts-hook-proof 72e6322a57e8   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr2-memory-contracts-hook-proof/commits/*.patch
git apply wip-archive/codex__pr2-memory-contracts-hook-proof/uncommitted.diff
cp -r wip-archive/codex__pr2-memory-contracts-hook-proof/untracked/. .
```
