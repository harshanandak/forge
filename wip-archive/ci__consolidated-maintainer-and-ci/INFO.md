# ci/consolidated-maintainer-and-ci

- source: C:/tmp/forge-consolidate
- branch: ci/consolidated-maintainer-and-ci
- HEAD: 55178853d65eac9b61346d485d3c150e8859fae7
- last commit: 2026-08-16T12:11:01+05:30 "fix(test): harden the docs-bleed guard and fix the USER/FORGE boundary wording"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 11
- uncommitted: none
- also covers (their unique commits are a subset of this one): ci/speed-and-reliability
- excluded: none

## restore

```
git switch -c restore/ci__consolidated-maintainer-and-ci 55178853d65e   # if the sha still exists locally; else start from origin/master
git am wip-archive/ci__consolidated-maintainer-and-ci/commits/*.patch
git apply wip-archive/ci__consolidated-maintainer-and-ci/uncommitted.diff
cp -r wip-archive/ci__consolidated-maintainer-and-ci/untracked/. .
```
