# Tasks

## Task 1: Evidence envelope and Kernel append

OWNS: `scripts/lib/eval-evidence.js`, `test/eval/eval-evidence.test.js`

Implement a strict model-neutral envelope, stable content hash, integrity verification, and idempotent Kernel event append.

TDD:
1. Write focused tests for required fields, privacy/unknown-field rejection, stable hashes, corruption, and duplicate appends.
2. Run them and confirm failure because the module is absent.
3. Implement the smallest module using existing Kernel helpers.
4. Run tests to green.

## Task 2: Exact-SHA replay seam

OWNS: `scripts/lib/eval-runner.js`, `scripts/run-command-eval.js`, `test/eval/eval-runner.test.js`, `test/eval/eval-pipeline.test.js`

Allow the existing worktree runner to start from a verified full SHA and let the pipeline validate an evidence replay binding before creating the worktree or executing a command. Preserve existing calls.

TDD:
1. Add tests for exact-SHA worktree creation and fail-closed hash drift before execution.
2. Run them red.
3. Add the minimal optional replay argument and validation call.
4. Run focused and legacy eval tests to green.

## Task 3: Validate and ship draft

OWNS: issue/PR metadata only

Run focused tests, lint, and project validation; record the exact actor/lease evidence; push and open a draft PR dependent on #483. Do not merge or self-grade.
