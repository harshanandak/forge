# feat/agent-harness-architecture

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/agent-harness-architecture
- branch: feat/agent-harness-architecture
- HEAD: bc13377c53130908ce7008b992119e84bc1dad5f
- last commit: 2026-08-30T17:01:26+05:30 "docs: finalize multi-harness architecture research"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0 (tip is on origin as origin/feat/agent-harness-architecture; not patch-archived)
- uncommitted: 6 entries (6 untracked); untracked copied: 2
- excluded: none
- untracked not copied (4):
  - tmp/pdfs/cordis-page-1.png (binary)
  - tmp/pdfs/cordis-page-29.png (301KB > 256KB)
  - tmp/pdfs/cordis-page-55.png (binary)
  - tmp/pdfs/cordis-spatiotemporal-composability.pdf (2091KB > 256KB)

## restore

```
git switch -c restore/feat__agent-harness-architecture bc13377c5313   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__agent-harness-architecture/commits/*.patch
git apply wip-archive/feat__agent-harness-architecture/uncommitted.diff
cp -r wip-archive/feat__agent-harness-architecture/untracked/. .
```
