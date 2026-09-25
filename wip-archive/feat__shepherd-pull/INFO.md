# feat/shepherd-pull

- source: (local branch, no worktree)
- branch: feat/shepherd-pull
- HEAD: b7364fb30338e2589d7be153a32b31bd3422ae7c
- last commit: 2026-07-10T17:43:23+05:30 "Merge remote-tracking branch 'origin/master' into feat/shepherd-pull"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__shepherd-pull b7364fb30338   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__shepherd-pull/commits/*.patch
git apply wip-archive/feat__shepherd-pull/uncommitted.diff
cp -r wip-archive/feat__shepherd-pull/untracked/. .
```
