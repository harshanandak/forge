# codex/wave1-full-suite-receipt

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/wave1-full-suite-receipt
- branch: codex/wave1-full-suite-receipt
- HEAD: 604dc22283d19607524c778bb5006b53a773b915
- last commit: 2026-08-07T16:18:17+05:30 "fix(test): harden timeout receipt evidence"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/codex__wave1-full-suite-receipt 604dc22283d1   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__wave1-full-suite-receipt/commits/*.patch
git apply wip-archive/codex__wave1-full-suite-receipt/uncommitted.diff
cp -r wip-archive/codex__wave1-full-suite-receipt/untracked/. .
```
