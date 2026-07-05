# Design: W0 v2 Fixture Corpus

## Feature

- Slug: `w0-fixture-corpus`
- Date: 2026-05-05
- Status: implementation
- Beads issue: `forge-c11n`

## Purpose

Create a small synthetic v2 repository corpus that can be materialized into real Git repositories for pre-W0 derisking of `forge migrate`, embedded Dolt state handling, and L1 rail preservation.

## Success Criteria

1. Five fixtures exist for clean v2 install, broken Beads state, stale worktrees, non-master default branch, and no Lefthook installed.
2. Fixtures are stored as test assets and can be materialized into temporary repositories with real `.git` directories.
3. Validation verifies the expected branch, Beads, Lefthook, and stale-worktree shape without touching migration implementation.
4. Fixture validation runs with a direct command and a Bun test.

## Out of Scope

- Implementing or changing `forge migrate`.
- Running destructive migration behavior against the current repo.
- Changing production setup, Beads migration, or L1 rail implementation.

## Approach Selected

Use manifest-backed fixture directories under `test/fixtures/v2-corpus/repos/*` plus a minimal CommonJS materializer at `test/fixtures/v2-corpus/index.js`.

This keeps checked-in fixture data reviewable while still allowing tests to generate runtime-only `.git` internals that Git cannot safely track as static fixture files.

## Constraints

- Keep ownership limited to docs, fixture/test assets, and the fixture runner.
- Do not modify migration code unless a missing runner blocks fixture validation.
- Preserve the main checkout's existing Beads metadata changes by working only in the requested isolated worktree.

## Edge Cases

- Broken Beads state includes malformed JSONL and stale SQLite residue.
- Stale worktrees are represented in `.git/worktrees/*` during materialization, not as checked-in files.
- The non-master default fixture uses `trunk` and intentionally does not create `master`.
- The no-Lefthook fixture omits both `lefthook.yml` and installed hook shims.

## Ambiguity Policy

If future migration tests need behavior beyond materialized fixture shape, extend the manifests and runner first. Stop before editing migration implementation unless a concrete migrate bug is proven by validation.

## Technical Research

### Codebase Conventions

- The repo already stores fixture data under `test/fixtures/*` and uses temporary directories for migration-style tests that need mutable state.
- Existing Beads migration tests seed legacy state into temp directories instead of committing generated database/runtime state.
- The setup flow creates `AGENTS.md`, command assets, runtime workflow assets, Beads setup, and Lefthook hooks; the corpus should therefore include both scenario-specific files and a common v2 generated-workflow baseline.

### External Tool Behavior

- Git linked worktrees store per-worktree administrative state under `$GIT_DIR/worktrees/<id>`.
- Git reports missing linked worktree paths as prunable stale state, so runtime materialization is the right way to create a realistic stale-worktree fixture.

### Approach Evaluation

- Static nested repos were rejected because checked-in `.git` internals are brittle and hard to review.
- Shell scripts per fixture were rejected because they would duplicate setup logic and make future tests slower to compose.
- Manifest-backed fixtures plus one materializer are the best fit: scenario data remains reviewable, runtime Git state is real, and future `forge migrate --dry-run` tests can reuse the same corpus without migration-code changes.

### TDD Scenarios

1. All five fixture names are discoverable and stable.
2. Every fixture materializes into a real Git repo with v2 workflow assets.
3. Stale worktree metadata is created only at runtime under `.git/worktrees`.
4. The non-master fixture uses `trunk` and has no `master` ref.
