# feat/97e6a146-6c79-4b05-aa30-b7e5402adf38

- source: (local branch, no worktree)
- branch: feat/97e6a146-6c79-4b05-aa30-b7e5402adf38
- HEAD: 0bc22d394b8d2395c318a55c6b90d4c2328ba406
- last commit: 2026-07-15T23:34:36+05:30 "fix(ci): harden pr-monitor sticky upsert error handling (CodeRabbit #394)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__97e6a146-6c79-4b05-aa30-b7e5402adf38 0bc22d394b8d   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__97e6a146-6c79-4b05-aa30-b7e5402adf38/commits/*.patch
git apply wip-archive/feat__97e6a146-6c79-4b05-aa30-b7e5402adf38/uncommitted.diff
cp -r wip-archive/feat__97e6a146-6c79-4b05-aa30-b7e5402adf38/untracked/. .
```
