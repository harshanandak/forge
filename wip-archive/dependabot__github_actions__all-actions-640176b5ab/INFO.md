# dependabot/github_actions/all-actions-640176b5ab

- source: (local branch, no worktree)
- branch: dependabot/github_actions/all-actions-640176b5ab
- HEAD: 989f02106084b69c886e3431bd8a0ec971d0fde4
- last commit: 2026-07-10T22:06:42+05:30 "fix(ci): bump actions/checkout to v7 in agentic-workflow source lock"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/dependabot__github_actions__all-actions-640176b5ab 989f02106084   # if the sha still exists locally; else start from origin/master
git am wip-archive/dependabot__github_actions__all-actions-640176b5ab/commits/*.patch
git apply wip-archive/dependabot__github_actions__all-actions-640176b5ab/uncommitted.diff
cp -r wip-archive/dependabot__github_actions__all-actions-640176b5ab/untracked/. .
```
