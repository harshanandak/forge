# Coding standards

Diff-checkable standards, read at review time. Turn-shaping rules stay in [AGENTS.md](AGENTS.md). CI is the gate: a rule marked **guard** is enforced by `test/structure/**` and fails the pull request; the rest are checked in review. When review catches something a guard could have caught, add the guard.

These govern this repository and Forge's shipped behaviour. They are not imposed on user projects.

## Language

- TypeScript with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions` and `module: nodenext`. ESM only. **Guard:** `package-shape`.
- Erasable syntax only, so Node can run the sources: no enums, namespaces, parameter properties or decorators. **Guard:** `package-shape`.
- Import siblings with their real `.ts` extension; the build rewrites it.
- No `any` anywhere; use `unknown` at boundaries, then narrow. Prefix unused parameters with `_`.
- The published package never uses Bun APIs: `tsconfig.build.json` loads Node types only and `bun:*` imports are allowed only inside adapters. **Guard:** `dependency-boundary`.

## Boundaries

- **B1. Core knows no workflow.** `src/core`, `src/surface`, `src/ports`, `src/contract`, `src/generated` and `schemas/` name no stage, TDD, pull request, issue, workflow or delivery concept. Move it to a block or template. **Guard:** `boundary-words`.
- **B2. One state owner.** Accepted state is written only through `src/core/state`. There is no backend selector, compatibility projection or second store.
- **B3. Bind each write to the context its operation declares** (stateless, device, project, leased). Refuse only what the declared variant requires.
- **B4. Reads never write.** `show`, `list`, `detect`, `explain` and `status` mutate nothing, including lazily creating homes.
- **B5. Core reaches the OS only through ports.** `src/core`, `src/contract` and `src/ports` import no platform module (`fs`, `path`, `os`, `child_process`, `worker_threads`, `net`, `http(s)`, `process`, `url`, any `bun:*`, or any Node built-in not on the pure list), with or without `node:`, statically or by `import()` and `require()`, and read no `process.cwd`, `process.env` or Bun global. Pure modules such as `node:crypto` (hashing), `node:util`, `node:events` and `node:buffer` are fine. Take paths and environment as arguments or through a port implemented under `src/adapters`. **Guard:** `platform-boundary`.

- **B6. Declare each operation once.** An operation is declared in its block; the CLI command and MCP tool are generated from that catalog. No hand-written command, alias or per-harness copy.
- **B7. Demand before breadth.** A block enters with a named consumer and a contract test.

## Dependencies and external tools

- **R1. One adapter per dependency.** Every third-party package, external executable and owned platform builtin is reached through exactly one `src/adapters/<name>/`, implementing a typed port from `src/ports/`. The adapter declares what it wraps in `adapter.json` with `package`, `executable` or `builtin` and its `port`. Core, blocks and other adapters import the port type, never the package or another adapter's internals. **Guard:** `dependency-boundary`.
- **R2. No import of a dependency outside its adapter.** `node:child_process` is allowed only in `src/adapters/process/` and `node:sqlite` only in `src/adapters/store-sqlite/`. Build scripts under `tools/` and tests may import development dependencies. **Guard:** `dependency-boundary`.
- **R3. Missing is a result, not a crash.** An adapter reports `Unavailable { reason, remedy }`. Only `git` and the Node runtime may be required.
- **R4. Our toolchain is not the user's.** No package manager, test runner, linter or hook runner is named outside adapters and project detectors. User commands come from the project's own declared scripts and config. **Guard:** `toolchain-names`.
- **R5. Every dependency has a ledger entry** in `docs/dependencies.md` (what it saves, maintenance, transitive packages, fit, licence, trust, swap proof, and the adapter for runtime ones). Each `overrides` entry cites an issue and an expiry date. The package has no `peerDependencies`, `optionalDependencies` or `bundledDependencies`, and no `preinstall`, `install`, `postinstall` or `prepare` script. **Guard:** `dependency-ledger`, `package-shape`.
- **R6. Prefer the platform.** Check Node 24 built-ins before adding a package for shipped code, and Bun built-ins for our tooling.
- **R7. Swap test.** Each port has a contract suite that every adapter, including an in-memory fake, passes. Replacing a dependency changes nothing outside its adapter.

## Retirement

- Removing a feature removes its names, shims and docs in the same pull request. Names, commands, modules, infrastructure and shapes on the DROP list never come back outside `src/blocks/migrate/legacy/`, detectors and test fixtures. **Guard:** `retired-names`.
- No committed generated files, agent mirrors, hand-kept manifests or shell scripts. Generated catalog output is never committed.
- No local git hooks and no hook runner configuration in this repository. **Guard:** `retired-names`.

## Tests

- Every test declares an explicit timeout: a third argument, a `{ timeout }` option, or `setDefaultTimeout(<ms>)` at the top of the file. A configured default alone is not enough. **Guard:** `test-timeouts`.
- Unit tests use an injected clock and fake process ports. Real git and subprocesses run only in a labelled integration lane. A flaky test is quarantined with an issue, never retried.
- Every guard ships with a test that it fails on its motivating bad input. A concurrency or authority fix has a fault-injection test and a check that the journey fails with the fix removed.
- Acceptance is an end-to-end outcome on the real artifact (the packed package, the installed host), never test counts. `bun run pack:smoke` is the minimum: pack once, install with npm on Node without Bun, run `forge --version`.
- Gates judge outcomes and return `PASS`, `FAIL`, `INCOMPLETE` or `NOT_EXECUTED`. Nothing checked is never `PASS`.

## Platform

- Durable file operations in adapters go through shared helpers that create private files and directories and fsync the parent directory after create, rename and unlink.
- Paths, executables and processes go through the process and OS adapters. CI runs Ubuntu, macOS and Windows.
- Spawn with argument arrays only, never shell strings. Resolve executables with a PATH and PATHEXT walk.
- Worktrees base on the fetched remote default branch.

## Documents and reviews

- `AGENTS.md` loads every turn and this file loads at review, so both stay lean: each has a byte cap in `test/structure/budget.json`. Prune before growing; raise a cap deliberately in that one file. **Guard:** `budget`.
- One decision record namespace (`ADR-NNN`) with a title; refer to a decision by name. Records hold durable choices only.
- Reports lead with the answer in plain language, then evidence and what would change it.
- Review is done when there are no P0 or P1 findings and your own regressions are fixed; adjacent findings become issues. After three review rounds, escalate as a design issue instead of iterating; the budget never waives a P0 or P1.
- The pull request title is a conventional commit title; it becomes the changelog line. Do not edit the changelog by hand.
- PR CI should stay around 2 minutes wall; a change that adds more than ~30 s states why in its pull request. The CI Gate prints the run's wall time.
