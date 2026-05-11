# Tasks: 0.0.12 Runtime Graph Contract

Issue: forge-besw.1

## Task 1: Runtime graph contract module

OWNS: `lib/core/runtime-graph.js`, `test/runtime-graph.test.js`

File(s): `lib/core/runtime-graph.js`, `test/runtime-graph.test.js`

What to implement: Define Phase, Action, Artifact, EvaluatorRegion, Gate, and Evidence primitives; publish a versioned JSON schema/envelope; export a resolved graph for the current command flow.

TDD steps:
1. Write test: `test/runtime-graph.test.js` asserts the exported graph includes all six primitive collections and the plan/dev/validate/ship flow.
2. Run test: confirm it fails because `lib/core/runtime-graph.js` does not exist.
3. Implement: add `lib/core/runtime-graph.js`.
4. Run test: confirm it passes.
5. Commit: `feat: add runtime graph contract`

Expected output: targeted runtime graph tests pass.

## Task 2: Command-doc compatibility tests

OWNS: `test/runtime-graph.test.js`

File(s): `test/runtime-graph.test.js`

What to implement: Prove every command node represented in the graph has a matching command doc in `.claude/commands/`.

TDD steps:
1. Write test: assert command action IDs map to existing `.claude/commands/<command>.md` files.
2. Run test: confirm it fails before graph command actions exist.
3. Implement: include command actions in the resolved graph.
4. Run test: confirm it passes.
5. Commit: `test: cover runtime graph command docs`

Expected output: command-doc compatibility test passes.

## Task 3: Migrate dry-run runtime graph proof

OWNS: `lib/migrate-dry-run.js`, `test/migrate-dry-run.test.js`

File(s): `lib/migrate-dry-run.js`, `test/migrate-dry-run.test.js`

What to implement: Reuse the existing migrate dry-run report path to print the resolved runtime graph without side effects.

TDD steps:
1. Write test: assert `renderMigrationDryRunReport(buildMigrationDryRunReport(...))` contains runtime graph phases/actions/artifacts/evaluator regions/gates/evidence.
2. Run test: confirm it fails before dry-run rendering includes the graph.
3. Implement: attach the runtime graph envelope to the dry-run report and render a compact graph summary.
4. Run test: confirm it passes and existing dry-run tests still pass.
5. Commit: `feat: print runtime graph in migrate dry-run`

Expected output: migrate dry-run tests pass and output includes the graph summary.
