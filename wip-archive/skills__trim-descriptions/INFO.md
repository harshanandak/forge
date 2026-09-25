# skills/trim-descriptions

- source: (local branch, no worktree)
- branch: skills/trim-descriptions
- HEAD: 61124b5edffc76b27fe374dd5b9d0315d15563c3
- last commit: 2026-07-05T16:47:09+05:30 "fix(skills): align plan description order with the worktree-first hard-gate (CodeRabbit #294)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/skills__trim-descriptions 61124b5edffc   # if the sha still exists locally; else start from origin/master
git am wip-archive/skills__trim-descriptions/commits/*.patch
git apply wip-archive/skills__trim-descriptions/uncommitted.diff
cp -r wip-archive/skills__trim-descriptions/untracked/. .
```
