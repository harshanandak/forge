# codex/windows-suite-contention

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/windows-suite-contention
- branch: codex/windows-suite-contention
- HEAD: bd4b11e5b38de0851f599f48f27acb5d75f3804b
- last commit: 2026-08-08T18:24:07+05:30 "docs: record beta5 release evidence"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0
- uncommitted: 1 entries (0 untracked); untracked copied: 0
- excluded: none

## restore

```
git switch -c restore/codex__windows-suite-contention bd4b11e5b38d   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__windows-suite-contention/commits/*.patch
git apply wip-archive/codex__windows-suite-contention/uncommitted.diff
cp -r wip-archive/codex__windows-suite-contention/untracked/. .
```
