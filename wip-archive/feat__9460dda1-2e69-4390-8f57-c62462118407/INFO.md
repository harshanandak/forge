# feat/9460dda1-2e69-4390-8f57-c62462118407

- source: (local branch, no worktree)
- branch: feat/9460dda1-2e69-4390-8f57-c62462118407
- HEAD: 7392deb155ec75a5d5419bbe73f72fee068561c9
- last commit: 2026-07-12T20:09:13+05:30 "fix(dist): address CodeRabbit review — extraction safety, fail-closed gen, docs"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__9460dda1-2e69-4390-8f57-c62462118407 7392deb155ec   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__9460dda1-2e69-4390-8f57-c62462118407/commits/*.patch
git apply wip-archive/feat__9460dda1-2e69-4390-8f57-c62462118407/uncommitted.diff
cp -r wip-archive/feat__9460dda1-2e69-4390-8f57-c62462118407/untracked/. .
```
