# feat/skill-invocation-metadata

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/s0-skill-invocation
- branch: feat/skill-invocation-metadata
- HEAD: 8e4dbaf62a0725abd5a00e310e333f346b00e904
- last commit: 2026-07-30T20:36:00+05:30 "docs(skills): own release documentation outputs"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 14
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- also covers (their unique commits are a subset of this one): eval-1785414029983-30124
- excluded: none

## restore

```
git switch -c restore/feat__skill-invocation-metadata 8e4dbaf62a07   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__skill-invocation-metadata/commits/*.patch
git apply wip-archive/feat__skill-invocation-metadata/uncommitted.diff
cp -r wip-archive/feat__skill-invocation-metadata/untracked/. .
```
