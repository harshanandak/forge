# feat/memory-projection

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/t2-memory-proj
- branch: feat/memory-projection
- HEAD: a271aea5a2bac56ea3437fb5638b1ca91a9558b4
- last commit: 2026-07-06T18:23:14+05:30 "fix(agents): full rule parity across all harnesses — one canonical source, drift-enforced (#311)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0
- uncommitted: 6 entries (2 untracked); untracked copied: 2
- excluded: none

## restore

```
git switch -c restore/feat__memory-projection a271aea5a2ba   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__memory-projection/commits/*.patch
git apply wip-archive/feat__memory-projection/uncommitted.diff
cp -r wip-archive/feat__memory-projection/untracked/. .
```
