# fix/prepush-full-suite-flake

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/prepush-full-suite-flake
- branch: fix/prepush-full-suite-flake
- HEAD: 816cad29d65f164a73ced984da306fa36ddef373
- last commit: 2026-08-19T17:07:59+05:30 "fix: isolate explicit process-tree manifests"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: 7 entries (0 untracked); untracked copied: 0
- excluded: none

## restore

```
git switch -c restore/fix__prepush-full-suite-flake 816cad29d65f   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__prepush-full-suite-flake/commits/*.patch
git apply wip-archive/fix__prepush-full-suite-flake/uncommitted.diff
cp -r wip-archive/fix__prepush-full-suite-flake/untracked/. .
```
