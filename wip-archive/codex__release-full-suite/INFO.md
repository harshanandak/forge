# codex/release-full-suite

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/release-full-suite
- branch: codex/release-full-suite
- HEAD: 5fbb35217f1259f117aaabde86ca87238bd33472
- last commit: 2026-08-03T11:45:13+05:30 "fix: gate npm publish on full release suite"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__release-full-suite 5fbb35217f12   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__release-full-suite/commits/*.patch
git apply wip-archive/codex__release-full-suite/uncommitted.diff
cp -r wip-archive/codex__release-full-suite/untracked/. .
```
