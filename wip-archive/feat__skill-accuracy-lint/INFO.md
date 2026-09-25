# feat/skill-accuracy-lint

- source: (local branch, no worktree)
- branch: feat/skill-accuracy-lint
- HEAD: 67fe5ea5cb06a157386fe04f7ebaee85d66aac01
- last commit: 2026-07-22T11:10:58+05:30 "fix(test-runner): run accuracy-lint detectors on lib/skill-eval.js edits"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 5
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__skill-accuracy-lint 67fe5ea5cb06   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__skill-accuracy-lint/commits/*.patch
git apply wip-archive/feat__skill-accuracy-lint/uncommitted.diff
cp -r wip-archive/feat__skill-accuracy-lint/untracked/. .
```
