# eval-1789059817965-32752

- source: (local branch, no worktree)
- branch: eval-1789059817965-32752
- HEAD: fee7af51e33d264bc21debbcdf1110d83c5377e8
- last commit: 2026-09-10T22:09:01+05:30 "fix(kernel): preserve exact claim repair file identity"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/eval-1789059817965-32752 fee7af51e33d   # if the sha still exists locally; else start from origin/master
git am wip-archive/eval-1789059817965-32752/commits/*.patch
git apply wip-archive/eval-1789059817965-32752/uncommitted.diff
cp -r wip-archive/eval-1789059817965-32752/untracked/. .
```
