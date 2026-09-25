# eval-1787717837257-72980

- source: (local branch, no worktree)
- branch: eval-1787717837257-72980
- HEAD: c9a1e638e2255a2290882b3ca354b5bf67967f3f
- last commit: 2026-08-26T08:22:14+05:30 "Merge remote-tracking branch 'origin/master' into feat/shepherd-owner-foundation"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 37
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/eval-1787717837257-72980 c9a1e638e225   # if the sha still exists locally; else start from origin/master
git am wip-archive/eval-1787717837257-72980/commits/*.patch
git apply wip-archive/eval-1787717837257-72980/uncommitted.diff
cp -r wip-archive/eval-1787717837257-72980/untracked/. .
```
