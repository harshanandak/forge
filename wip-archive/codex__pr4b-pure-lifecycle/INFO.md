# codex/pr4b-pure-lifecycle

- source: (local branch, no worktree)
- branch: codex/pr4b-pure-lifecycle
- HEAD: 96a643cfbcd8bb2e1e63a5ddc9e559b6624bbda6
- last commit: 2026-08-11T01:47:29+05:30 "refactor(shepherd): satisfy Sonar lifecycle limits"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__pr4b-pure-lifecycle 96a643cfbcd8   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr4b-pure-lifecycle/commits/*.patch
git apply wip-archive/codex__pr4b-pure-lifecycle/uncommitted.diff
cp -r wip-archive/codex__pr4b-pure-lifecycle/untracked/. .
```
