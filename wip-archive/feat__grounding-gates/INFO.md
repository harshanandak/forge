# feat/grounding-gates

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/grounding-gates
- branch: feat/grounding-gates
- HEAD: bd8eeb4745b312fce98c26b4231b0a091749ee65
- last commit: 2026-07-16T17:16:20+05:30 "docs: grounding-enforcement design (gate.read_first + gate.cite, wrap-not-separate)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__grounding-gates bd8eeb4745b3   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__grounding-gates/commits/*.patch
git apply wip-archive/feat__grounding-gates/uncommitted.diff
cp -r wip-archive/feat__grounding-gates/untracked/. .
```
