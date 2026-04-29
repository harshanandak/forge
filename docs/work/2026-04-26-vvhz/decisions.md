# Decisions: forge-vvhz test-env bun:test import migration

## Decision 1

**Date**: 2026-04-26
**Task**: Planning catalog
**Gap**: Prompt said 18 `test-env/` files use `node:test`, but the verified worktree has 19 `test-env/**/*.test.js` files, all already using CommonJS `require('bun:test')`.
**Score**: 1/14
**Route**: PROCEED
**Choice made**: Treat the worktree as source of truth and migrate all 19 verified test files so `test-env/` stays internally consistent.
**Status**: RESOLVED

## Decision 2

**Date**: 2026-04-26
**Task**: Final consistency check
**Gap**: Static `import { ... } from 'bun:test'` made migrated `test-env/**/*.test.js` files fail ESLint parsing because `eslint.config.js` classified `test-env/**/*.js` as CommonJS.
**Score**: 3/14
**Route**: PROCEED
**Choice made**: Add only `test-env/**/*.test.js` to the existing ES module ESLint override and exclude those files from the CommonJS override. Leave non-test `test-env/**/*.js` files unchanged.
**Status**: RESOLVED
