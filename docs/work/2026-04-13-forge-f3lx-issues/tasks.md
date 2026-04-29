# Task List

Task 1: Lock The Forge Issue Backend Contract
File(s): `test/forge-issues.test.js`
OWNS: `test/forge-issues.test.js`
What to implement: Define the service-level contract for `create`, `list`, `show`, `close`, and `update` before any production code exists. The tests should require a pluggable backend, stable operation routing, clear unknown-operation failures, and dependency injection for shell execution and initialization checks.
TDD steps:
  1. Write test: add coverage for `createIssueService()` and `runIssueOperation()` with a fake backend and injected dependencies.
  2. Run test: confirm it fails because `lib/forge-issues.js` does not exist yet.
  3. Implement: no production code in this task; tests only.
  4. Run test: confirm the failures are for the missing service implementation, not test harness mistakes.
  5. Commit: `test: add forge issues service contract coverage`
Expected output: a stable failing test suite that defines the Forge-owned issue service boundary before the Beads wrapper is written.

Task 2: Implement The Pluggable Forge Issue Service And Default Beads Backend
File(s): `lib/forge-issues.js`, `test/forge-issues.test.js`
OWNS: `lib/forge-issues.js`, `test/forge-issues.test.js`
What to implement: Add the new Forge issue service with a default Beads-backed backend. The service should own operation dispatch, dependency injection, backend selection for this wave, and Forge-level error translation. The Beads path should use `bd` through injected execution helpers and may consume `isBeadsInitialized()` from `lib/beads-setup.js` through its public export only.
TDD steps:
  1. Write test: use `test/forge-issues.test.js` to require exact routing, init checks, and `ENOENT` translation behavior.
  2. Run test: confirm it fails because the service implementation does not exist.
  3. Implement: add `lib/forge-issues.js` with the backend contract, default backend factory, and Beads command mapping for `create`, `list`, `show`, `close`, and `update`.
  4. Run test: confirm the new service contract tests pass.
  5. Commit: `feat: add forge issues service and beads backend`
Expected output: one Forge-owned module that turns issue operations into backend calls and makes Beads an implementation detail instead of the command surface.

Task 3: Add The New `forge issues` Command Module
File(s): `lib/commands/issues.js`, `test/commands/issues.test.js`
OWNS: `lib/commands/issues.js`, `test/commands/issues.test.js`
What to implement: Create the plural `forge issues` command as a thin wrapper over `lib/forge-issues.js`. It must parse subcommands, return stable help output, dispatch supported operations through the service, and avoid direct `bd` argv construction in the command module.
TDD steps:
  1. Write test: add `test/commands/issues.test.js` covering help output, invalid subcommands, and dispatch for `create`, `list`, `show`, and `close`.
  2. Run test: confirm it fails because `lib/commands/issues.js` does not exist.
  3. Implement: add `lib/commands/issues.js` using the standard command export shape required by the registry.
  4. Run test: confirm the command tests pass.
  5. Commit: `feat: add forge issues command`
Expected output: `forge issues ...` becomes a first-class command surface without modifying `bin/forge.js`.

Task 4: Prove Auto-Discovery And Coexistence With The Legacy Surface
File(s): `test/forge-cli-registry.test.js`, `test/commands/issues.test.js`
OWNS: `test/forge-cli-registry.test.js`, `test/commands/issues.test.js`
What to implement: Extend registry and command coverage so the new plural command is auto-discovered and can coexist with the existing singular `issue` and top-level alias commands without replacing them in this wave.
TDD steps:
  1. Write test: require the registry to load `issues` from `lib/commands/` and verify that both `issue` and `issues` are present.
  2. Run test: confirm it fails until the new module exists and exports the correct shape.
  3. Implement: adjust tests only if Task 3 already satisfies the registry contract; otherwise refine the command module until discovery passes.
  4. Run test: confirm registry coverage passes alongside the new command tests.
  5. Commit: `test: cover forge issues auto-discovery`
Expected output: proof that no `bin/forge.js` wiring is needed and that the new v2 command can land without destabilizing the existing issue entrypoints.

## YAGNI Filter

- Task 1 maps to success criteria 2 and 6.
- Task 2 maps to success criteria 2, 3, and 5.
- Task 3 maps to success criteria 1, 3, and 4.
- Task 4 maps to success criteria 1 and 6.

No task depends on sync queues, GitHub reconciliation, Linear/Jira adapters, or legacy command replacement.
