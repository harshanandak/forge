# v2 Fixture Corpus

Synthetic v2 repository fixtures for Wave 0 migration derisking.

The fixture manifests are checked in under `repos/*/manifest.json`. The runner in `index.js` materializes them into temporary real Git repositories because nested `.git` internals and stale worktree metadata should not be stored directly in Git.

Validation commands:

```bash
node test/fixtures/v2-corpus/index.js
bun test test/v2-fixture-corpus.test.js
```
