# Feature: forge-vvhz test-env bun:test import migration

**Date**: 2026-04-26
**Status**: Planned
**Issue**: forge-vvhz

## Purpose

Finish the `test-env/` test runner migration so the tests use `bun:test` APIs directly and consistently.

## Verified Current State

The requested `forge worktree create vvhz` command was run. It reported an existing path error while linking `.beads`, but Git already has a usable worktree at `.worktrees/vvhz` on branch `feat/vvhz`.

The current source does not match the prompt exactly:

- Verified branch: `feat/vvhz`
- Verified `test-env/**/*.test.js` count: 19 files
- Verified `node:test` imports in `test-env/**/*.test.js`: 0 files
- Verified current test API style: CommonJS `require('bun:test')`
- Verified assertion style: 18 files still use `node:assert/strict`; 1 file already uses `expect`

## Success Criteria

- All `test-env/**/*.test.js` files import test helpers from `bun:test`.
- Node test lifecycle aliasing is removed where present:
  - `beforeAll: before` becomes direct `beforeAll`
  - `afterAll: after` becomes direct `afterAll`
  - `before(...)` calls become `beforeAll(...)`
  - `after(...)` calls become `afterAll(...)`
- `node:assert/strict` imports are removed from migrated test files.
- Assertion calls are migrated to `expect(...)` equivalents.
- Each `test-env/**/*.test.js` file is verified with `bun test <file>`.

## Out Of Scope

- No production behavior changes.
- No changes outside `test-env/**/*.test.js` and the plan artifacts unless verification proves a local test support bug is blocking the migration.
- No broad cleanup of unrelated worktree, Beads, or Forge state.

## Approach Selected

Use a mechanical migration followed by per-file Bun test verification. The test files are independent enough to validate in waves, but the edits are consistent enough to apply mechanically:

- Convert Bun test requires to Bun test imports.
- Add `expect` to the Bun test import when assertions are migrated.
- Convert known `assert` forms:
  - `assert.strictEqual(actual, expected)` to `expect(actual).toBe(expected)`
  - `assert.deepStrictEqual(actual, expected)` to `expect(actual).toEqual(expected)`
  - `assert.ok(value)` to `expect(value).toBeTruthy()`
  - `assert.match(value, pattern)` to `expect(value).toMatch(pattern)`
  - `assert.fail(message)` to `throw new Error(message)`

## Ambiguity Policy

Use the `/dev` 7-dimension decision rubric for any spec gap. For this migration, the verified count mismatch is low risk because the actual source of truth is the worktree. Proceed with all 19 verified test files rather than leaving one `test-env` test file inconsistent.
