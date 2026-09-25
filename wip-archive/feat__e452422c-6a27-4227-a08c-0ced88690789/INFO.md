# feat/e452422c-6a27-4227-a08c-0ced88690789

- source: (local branch, no worktree)
- branch: feat/e452422c-6a27-4227-a08c-0ced88690789
- HEAD: 718c1c4786c8f581ff577c95daac47013083136c
- last commit: 2026-07-14T17:06:12+05:30 "fix(setup): same-repo guard so git-hook resolution never touches an ancestor repo (N1)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 6
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__e452422c-6a27-4227-a08c-0ced88690789 718c1c4786c8   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__e452422c-6a27-4227-a08c-0ced88690789/commits/*.patch
git apply wip-archive/feat__e452422c-6a27-4227-a08c-0ced88690789/uncommitted.diff
cp -r wip-archive/feat__e452422c-6a27-4227-a08c-0ced88690789/untracked/. .
```
