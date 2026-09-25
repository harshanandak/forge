# feat/core-skills

- source: (local branch, no worktree)
- branch: feat/core-skills
- HEAD: c2a776516f6b7496bdc300453265c4285eacc240
- last commit: 2026-07-04T13:18:56+05:30 "fix(verify): fail /verify when an intended issue close fails"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__core-skills c2a776516f6b   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__core-skills/commits/*.patch
git apply wip-archive/feat__core-skills/uncommitted.diff
cp -r wip-archive/feat__core-skills/untracked/. .
```
