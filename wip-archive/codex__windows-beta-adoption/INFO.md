# codex/windows-beta-adoption

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/windows-beta-adoption
- branch: codex/windows-beta-adoption
- HEAD: eb0734580632832ccea864caa09dfbed6a81e2dd
- last commit: 2026-08-11T05:32:25+05:30 "docs(plan): define Windows beta adoption stack"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__windows-beta-adoption eb0734580632   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__windows-beta-adoption/commits/*.patch
git apply wip-archive/codex__windows-beta-adoption/uncommitted.diff
cp -r wip-archive/codex__windows-beta-adoption/untracked/. .
```
