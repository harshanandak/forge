# chore/standards-and-gitignore

- source: C:/tmp/forge-std2
- branch: chore/standards-and-gitignore
- HEAD: e65ede538b74a3e5025d04afc92ecaf1bd9fe644
- last commit: 2026-08-16T14:31:10+05:30 "test(lane): map CODING_STANDARDS.md to the docs lane"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/chore__standards-and-gitignore e65ede538b74   # if the sha still exists locally; else start from origin/master
git am wip-archive/chore__standards-and-gitignore/commits/*.patch
git apply wip-archive/chore__standards-and-gitignore/uncommitted.diff
cp -r wip-archive/chore__standards-and-gitignore/untracked/. .
```
