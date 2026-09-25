# codex/full-suite-isolation

- source: (local branch, no worktree)
- branch: codex/full-suite-isolation
- HEAD: 8096df3a311947cb2bcdbd6b019477927928cc0a
- last commit: 2026-08-05T22:29:02+05:30 "test: harden full-suite isolation fixture"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__full-suite-isolation 8096df3a3119   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__full-suite-isolation/commits/*.patch
git apply wip-archive/codex__full-suite-isolation/uncommitted.diff
cp -r wip-archive/codex__full-suite-isolation/untracked/. .
```
