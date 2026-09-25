# codex/pr1-beta5-evidence

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr1-beta5-evidence
- branch: codex/pr1-beta5-evidence
- HEAD: 9cfa59adc18be1f61a01fff4301fc6c3c3e218ff
- last commit: 2026-08-09T20:53:16+05:30 "fix(review): canonicalize beta5 evidence ordering"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 9
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/codex__pr1-beta5-evidence 9cfa59adc18b   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr1-beta5-evidence/commits/*.patch
git apply wip-archive/codex__pr1-beta5-evidence/uncommitted.diff
cp -r wip-archive/codex__pr1-beta5-evidence/untracked/. .
```
