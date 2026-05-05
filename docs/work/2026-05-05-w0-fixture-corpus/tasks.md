# Tasks: W0 v2 Fixture Corpus

## Task 1: Inspect Existing Fixture Conventions

- Confirm current branch/worktree state.
- Inspect package scripts and fixture/test layout.
- Read migration-adjacent fixture tests for style.

## Task 2: Add Manifest-Backed v2 Corpus

- Add five fixture manifests under `test/fixtures/v2-corpus/repos/*`.
- Cover clean v2 install, broken Beads state, stale worktrees, non-master default branch, and no Lefthook installed.
- Include minimal v2 command, Beads, Dolt, and L1 rail files where relevant.

## Task 3: Add Minimal Materializer and Validation

- Add `test/fixtures/v2-corpus/index.js`.
- Materialize fixture manifests into temporary real Git repositories.
- Validate expected branch, Beads, Lefthook, and stale worktree state.

## Task 4: Add Focused Tests

- Add Bun tests that materialize all fixtures.
- Verify all five expected scenarios and runtime-only Git state.

## Task 5: Validate and Commit

- Run fixture validator.
- Run focused Bun test.
- Run lint on touched JS.
- Update `forge-c11n` context if Beads supports it.
- Commit on `codex/w0-fixture-corpus`.
