# skills/rename-design-to-plan

- source: (local branch, no worktree)
- branch: skills/rename-design-to-plan
- HEAD: 6d81e082b0f1cd31363ddc76900089e8d9a06770
- last commit: 2026-07-05T19:11:32+05:30 "fix(ci): revert behavioral-test workflow artifacts (avoid gh-aw recompile drift) [CodeRabbit #297]"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 5
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/skills__rename-design-to-plan 6d81e082b0f1   # if the sha still exists locally; else start from origin/master
git am wip-archive/skills__rename-design-to-plan/commits/*.patch
git apply wip-archive/skills__rename-design-to-plan/uncommitted.diff
cp -r wip-archive/skills__rename-design-to-plan/untracked/. .
```
