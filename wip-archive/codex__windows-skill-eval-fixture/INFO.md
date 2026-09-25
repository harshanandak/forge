# codex/windows-skill-eval-fixture

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/windows-skill-eval-fixture
- branch: codex/windows-skill-eval-fixture
- HEAD: 4dcfc95cb91480acf280fff19411820c7a5253ee
- last commit: 2026-08-10T21:48:41+05:30 "test: make skill eval fixture deterministic on windows"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/codex__windows-skill-eval-fixture 4dcfc95cb914   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__windows-skill-eval-fixture/commits/*.patch
git apply wip-archive/codex__windows-skill-eval-fixture/uncommitted.diff
cp -r wip-archive/codex__windows-skill-eval-fixture/untracked/. .
```
