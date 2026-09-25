# feat/codex-agents-skills

- source: (local branch, no worktree)
- branch: feat/codex-agents-skills
- HEAD: 5a0e115fbbb1b014e896b7ea83fd9380fda41cef
- last commit: 2026-07-06T19:34:33+05:30 "chore(skills): re-sync .agents/skills dev|plan mirror after #313 rebase"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__codex-agents-skills 5a0e115fbbb1   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__codex-agents-skills/commits/*.patch
git apply wip-archive/feat__codex-agents-skills/uncommitted.diff
cp -r wip-archive/feat__codex-agents-skills/untracked/. .
```
