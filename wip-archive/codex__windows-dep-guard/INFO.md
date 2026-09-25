# codex/windows-dep-guard

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/windows-dep-guard
- branch: codex/windows-dep-guard
- HEAD: 2b5858873dbd3845770722af678139278d849f43
- last commit: 2026-08-07T22:23:49+05:30 "fix: preserve signals on shard errors"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 8
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- also covers (their unique commits are a subset of this one): codex/windows-embedded-lf, codex/windows-stale-fixture
- excluded: none

## restore

```
git switch -c restore/codex__windows-dep-guard 2b5858873dbd   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__windows-dep-guard/commits/*.patch
git apply wip-archive/codex__windows-dep-guard/uncommitted.diff
cp -r wip-archive/codex__windows-dep-guard/untracked/. .
```
