# docs/onboarding-surface

- source: (local branch, no worktree)
- branch: docs/onboarding-surface
- HEAD: 3ec486efe62264e5144a8aa96ca4fda11a71ef1e
- last commit: 2026-07-06T14:15:46+05:30 "chore(d20): regenerate bd call-site kill-list for orientation.js line shift"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/docs__onboarding-surface 3ec486efe622   # if the sha still exists locally; else start from origin/master
git am wip-archive/docs__onboarding-surface/commits/*.patch
git apply wip-archive/docs__onboarding-surface/uncommitted.diff
cp -r wip-archive/docs__onboarding-surface/untracked/. .
```
