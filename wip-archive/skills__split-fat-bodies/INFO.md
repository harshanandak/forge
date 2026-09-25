# skills/split-fat-bodies

- source: (local branch, no worktree)
- branch: skills/split-fat-bodies
- HEAD: 99c8ef3a4b6bcc07f92f1b4dc8a3bca184d9b37e
- last commit: 2026-07-06T00:04:14+05:30 "fix(skills): address CodeRabbit review on rollback refs + plan dep-guard test"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/skills__split-fat-bodies 99c8ef3a4b6b   # if the sha still exists locally; else start from origin/master
git am wip-archive/skills__split-fat-bodies/commits/*.patch
git apply wip-archive/skills__split-fat-bodies/uncommitted.diff
cp -r wip-archive/skills__split-fat-bodies/untracked/. .
```
