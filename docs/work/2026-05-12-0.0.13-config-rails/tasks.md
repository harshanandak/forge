# 0.0.13 Config Rails And Graph Introspection Tasks

## Task 1: Config Resolution And Locked Rails

**OWNS**: `lib/core/runtime-graph.js`, `test/runtime-graph-config.test.js`

**What to implement**: Load optional `.forge/config.yaml`, merge supported config into graph primitives, track provenance, preserve disabled primitives, and reject disabled locked L1 rails.

**TDD steps**:
1. Write failing tests for valid config resolution, unknown primitive IDs, malformed YAML, and locked rail disable errors.
2. Run `bun test test/runtime-graph-config.test.js` and confirm failures.
3. Implement graph config loading and validation.
4. Run `bun test test/runtime-graph-config.test.js` and confirm pass.
5. Commit: `feat: resolve runtime graph config rails`

## Task 2: Options Introspection Command

**OWNS**: `lib/commands/options.js`, `test/options-command.test.js`

**What to implement**: Add `forge options stages|gates|adapters|diff|why <id>|lint` with human and `--json` output over graph primitives.

**TDD steps**:
1. Write failing tests for stages/gates/adapters/diff/why/lint JSON and human output.
2. Run `bun test test/options-command.test.js` and confirm failures.
3. Implement the registry command using runtime graph APIs.
4. Run `bun test test/options-command.test.js` and confirm pass.
5. Commit: `feat: add graph options introspection`

## Task 3: Protected Path Policy Validation

**OWNS**: `lib/core/runtime-graph.js`, `test/runtime-graph-config.test.js`, `test/options-command.test.js`

**What to implement**: Validate `protectedPaths` entries in config and expose policy errors through `forge options lint`.

**TDD steps**:
1. Add failing tests for invalid protected path entries and broad catch-all patterns.
2. Run targeted tests and confirm failures.
3. Implement protected path validation.
4. Run targeted tests and confirm pass.
5. Commit: `feat: validate graph protected paths`

## Task 4: Workflow Docs And Final Validation

**OWNS**: `docs/work/2026-05-12-0.0.13-config-rails/decisions.md`

**What to implement**: Record resolved implementation decisions and run validation.

**TDD steps**:
1. Create decisions log.
2. Run targeted graph/options tests.
3. Run `/validate` checks.
4. Commit documentation if changed.
