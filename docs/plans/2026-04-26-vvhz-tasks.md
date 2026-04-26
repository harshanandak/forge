# Tasks: forge-vvhz test-env bun:test import migration

## Task 1: Automation and helper tests

Files:

- `test-env/automation/setup-fixtures.test.js`: `describe`, `test`; `assert.ok`, `assert.strictEqual`, `assert.match`
- `test-env/helpers/fixtures.test.js`: `afterEach`, `describe`, `expect`, `test`; already uses `expect`

TDD verification:

- Run `bun test test-env/automation/setup-fixtures.test.js`
- Run `bun test test-env/helpers/fixtures.test.js`

## Task 2: Edge-case tests, wave A

Files:

- `test-env/edge-cases/auth-security.test.js`: `describe`, `test`; `assert.ok`, `assert.strictEqual`
- `test-env/edge-cases/crypto-security.test.js`: `describe`, `test`; `assert.ok`, `assert.strictEqual`
- `test-env/edge-cases/env-preservation.test.js`: `describe`, `beforeAll` currently aliased as `before`, `afterAll` currently aliased as `after`, `test`; `assert.ok`, `assert.strictEqual`
- `test-env/edge-cases/file-limits.test.js`: `describe`, `beforeAll` currently aliased as `before`, `afterAll` currently aliased as `after`, `test`; `assert.ok`, `assert.strictEqual`
- `test-env/edge-cases/git-states.test.js`: `describe`, `test`; `assert.ok`, `assert.strictEqual`

TDD verification:

- Run `bun test` for each file listed above.

## Task 3: Edge-case tests, wave B

Files:

- `test-env/edge-cases/invalid-json.test.js`: `describe`, `test`; `assert.ok`, `assert.strictEqual`
- `test-env/edge-cases/network-failures.test.js`: `describe`, `test`; `assert.ok`, `assert.strictEqual`, `assert.deepStrictEqual`
- `test-env/edge-cases/permission-errors.test.js`: `describe`, `beforeAll` currently aliased as `before`, `afterAll` currently aliased as `after`, `test`; `assert.ok`, `assert.strictEqual`, `assert.fail`
- `test-env/edge-cases/prerequisites.test.js`: `describe`, `test`; `assert.ok`, `assert.strictEqual`

TDD verification:

- Run `bun test` for each file listed above.

## Task 4: Rollback and security edge-case tests

Files:

- `test-env/edge-cases/rollback-edge-cases.test.js`: `describe`, `test`; `assert.strictEqual`
- `test-env/edge-cases/rollback-user-sections.test.js`: `describe`, `beforeAll` currently aliased as `before`, `afterAll` currently aliased as `after`, `test`; `assert.ok`, `assert.strictEqual`
- `test-env/edge-cases/rollback-validation.test.js`: `describe`, `test`; `assert.ok`, `assert.strictEqual`
- `test-env/edge-cases/security.test.js`: `describe`, `test`; `assert.ok`, `assert.strictEqual`

TDD verification:

- Run `bun test` for each file listed above.

## Task 5: Validation tests

Files:

- `test-env/validation/agent-validator.test.js`: `describe`, `beforeAll` currently aliased as `before`, `afterAll` currently aliased as `after`, `test`; `assert.ok`, `assert.strictEqual`
- `test-env/validation/env-validator.test.js`: `describe`, `beforeAll` currently aliased as `before`, `afterAll` currently aliased as `after`, `test`; `assert.ok`, `assert.strictEqual`, `assert.match`
- `test-env/validation/file-checker.test.js`: `describe`, `beforeAll` currently aliased as `before`, `afterAll` currently aliased as `after`, `test`; `assert.ok`, `assert.strictEqual`, `assert.match`
- `test-env/validation/git-state-checker.test.js`: `describe`, `beforeAll` currently aliased as `before`, `afterAll` currently aliased as `after`, `setDefaultTimeout`, `test`; `assert.ok`, `assert.strictEqual`, `assert.match`

TDD verification:

- Run `bun test` for each file listed above.

## Task 6: Final consistency check

- Confirm no `node:test` imports remain under `test-env/`.
- Confirm no `node:assert/strict` imports remain in `test-env/**/*.test.js`.
- Confirm all `test-env/**/*.test.js` files use `import { ... } from 'bun:test'`.
- Run `bun test test-env`.
