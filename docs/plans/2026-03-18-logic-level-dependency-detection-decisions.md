# Decisions Log: logic-level-dependency-detection

This file records `/dev` decision gates for `forge-9zv`.

## Decision 1
**Date**: 2026-03-18
**Task**: Task 1 — Scaffold the Phase 3 analyzer and structured result contract
**Gap**: The task list named `test/lib/dep-guard/analyzer.test.js`, but the repo's enforced TDD hook mirrors `lib/...` source files to `test/...` paths, so the hook rejected the commit even with real Task 1 tests present.
**Score**: 1 / 14
**Route**: PROCEED
**Choice made**: Moved the Task 1 tests to `test/dep-guard/` and split parser coverage into `task-parser.test.js` so the implementation follows the existing repo test-mirroring convention and passes the pre-commit TDD enforcement without bypassing hooks.
**Status**: RESOLVED

## Decision 2
**Date**: 2026-03-18
**Task**: Task 2 — Implement import and call-chain dependency detection
**Gap**: The repo's TDD hook also expects `lib/dep-guard/import-detector.js` to have a mirrored `test/dep-guard/import-detector.test.js`, while the initial Task 2 coverage was only inside `analyzer.test.js`.
**Score**: 1 / 14
**Route**: PROCEED
**Choice made**: Split the direct detector assertions into `test/dep-guard/import-detector.test.js` and kept analyzer-level integration assertions in `test/dep-guard/analyzer.test.js` so the repo's existing hook can validate the source-to-test mapping without reducing coverage.
**Status**: RESOLVED
