# feat/single-source-skills

- source: (local branch, no worktree)
- branch: feat/single-source-skills
- HEAD: 6e6c464cfc4511df7e9d98d7f96795e061f9f190
- last commit: 2026-07-11T16:04:36+05:30 "test(skills): assert /validate note synced to committed .agents/skills, not gitignored .codex"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__single-source-skills 6e6c464cfc45   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__single-source-skills/commits/*.patch
git apply wip-archive/feat__single-source-skills/uncommitted.diff
cp -r wip-archive/feat__single-source-skills/untracked/. .
```
