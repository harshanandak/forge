# codex/pr4b-trace-resume

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr4b-trace-resume
- branch: codex/pr4b-trace-resume
- HEAD: 8ebe8de61f9230f2371494bddd4e71875f230b5d
- last commit: 2026-08-11T02:53:19+05:30 "fix(memory): preserve legacy monitor history reads"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 9
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/codex__pr4b-trace-resume 8ebe8de61f92   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr4b-trace-resume/commits/*.patch
git apply wip-archive/codex__pr4b-trace-resume/uncommitted.diff
cp -r wip-archive/codex__pr4b-trace-resume/untracked/. .
```
