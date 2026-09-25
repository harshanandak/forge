# feat/dist-install

- source: (local branch, no worktree)
- branch: feat/dist-install
- HEAD: 5fb9b546c4e52bda7d208bac34f4e8010dfa4ce4
- last commit: 2026-07-13T18:01:53+05:30 "fix(install): add explicit HTTP timeouts to prevent indefinite hangs"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__dist-install 5fb9b546c4e5   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__dist-install/commits/*.patch
git apply wip-archive/feat__dist-install/uncommitted.diff
cp -r wip-archive/feat__dist-install/untracked/. .
```
