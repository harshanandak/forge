# Test Infrastructure & TDD Scenarios for CLI Maturity Refactor

## Step 1: Existing Test Inventory

### Test Framework
- **Runner**: `bun:test` (bun's built-in test runner)
- **Run command**: `bun test --timeout 15000` (package.json `scripts.test`)
- **Fixtures**: `test/fixtures/` (context-merge, project-discovery), `test/e2e/fixtures/`
- **Test-env**: `test-env/` — full fixture projects (fresh-project, existing-forge-v1, partial-install, conflicting-configs) with real `.git` dirs; edge-case tests (env-preservation, git-states, invalid-json, rollback-validation)
- **Helpers**: `test/helpers/bash.js`, `test/e2e/helpers/cleanup.js`, `test/e2e/helpers/scaffold.js`
- **Mocking pattern**: `spyOn(console, 'warn')`, temp directories with `fs.mkdtempSync`, `spawnSync` for CLI integration tests

### Test Files Directly Relevant to Migration

| Test File | Module Tested | Cases | Type | Imports from changed files? |
|-----------|--------------|-------|------|----------------------------|
| `test/commands/_registry.test.js` | `lib/commands/_registry.js` | 13 | Unit | YES - `loadCommands` |
| `test/commands/dev.test.js` | `lib/commands/dev.js` | 22 (4 skipped) | Unit | YES - 9 named exports |
| `test/commands/plan.test.js` | `lib/commands/plan.js` | 14 (7 skipped) | Unit | YES - 7 named exports |
| `test/commands/plan.phases.test.js` | `lib/commands/plan.js` | ~30+ | Unit | YES - deeper phase coverage |
| `test/commands/ship.test.js` | `lib/commands/ship.js` | 16 (4 skipped) | Unit | YES - 6 named exports |
| `test/commands/status.test.js` | `lib/commands/status.js` | 16 | Unit | YES - 6 named exports |
| `test/commands/validate.test.js` | `lib/commands/validate.js` | 15 (8 skipped) | Unit | YES - 6 named exports |
| `test/commands/recommend.test.js` | `lib/commands/recommend.js` | 8 | Unit | YES - `handleRecommend`, `formatRecommendations` |
| `test/commands/team.test.js` | `lib/commands/team.js` | 3 | Integration | YES - `handleTeam` + checks forge.js routing |
| `test/cli/forge-cmd.test.js` | `bin/forge-cmd.js` | 14 | Unit+Integration | YES (forge-cmd.js, not forge.js) |
| `test/cli/forge.test.js` | `bin/forge.js` | 9 | Structural | YES - checks function existence in source |
| `test/forge-cli-registry.test.js` | `bin/forge.js` + `_registry.js` | 5 | Integration (spawn) | YES - tests CLI dispatch to registry |
| `test/forge-commands.test.js` | `bin/forge.js` | ~5 | Unit | YES - `getWorkflowCommands` |
| `test/branch-protection.test.js` | `scripts/branch-protection.js` | ~10+ | Unit+Integration | YES - mock git, spawn |
| `test/scripts/dep-guard-analyze.test.js` | `scripts/dep-guard-analyze.js` | 1 | Integration | YES - spawns script |
| `test/lazy-dirs.test.js` | `bin/forge.js` | 2 | Unit | YES - `ensureDirWithNote` |
| `test/setup-summary.test.js` | `bin/forge.js` | ~3 | Unit | YES - `renderSetupSummary` (imported from lib) |
| `test/dev-commit-verify.test.js` | `lib/commands/dev.js` | ~3 | Unit | YES - `verifyTaskCompletion` |

### Other Test Files (not directly impacted but may break if imports shift)

| Test File | Module Tested | Risk |
|-----------|--------------|------|
| `test/commands/push.test.js` | `lib/commands/push.js` | LOW - already registry-compliant |
| `test/commands/verify-cleanup.test.js` | cleanup checks | LOW |
| `test/structural/command-contracts.test.js` | Checks command exports | MEDIUM - may enforce current shape |
| `test/structural/command-files.test.js` | Checks command file existence | MEDIUM |
| `test/structural/command-sync.test.js` | Synced command files | LOW |
| `test/structural/agentic-workflow-sync.test.js` | Workflow sync | LOW |
| `test/plugin-recommend.test.js` | `lib/commands/recommend` | LOW - duplicate of recommend.test.js |

---

## Step 2: Coverage Analysis

### Files Being Modified

| Source File | Has Tests? | Test File(s) | Coverage Quality |
|------------|-----------|-------------|-----------------|
| `lib/commands/dev.js` | YES | `test/commands/dev.test.js`, `test/dev-commit-verify.test.js` | GOOD - 22 cases testing exports |
| `lib/commands/plan.js` | YES | `test/commands/plan.test.js`, `test/commands/plan.phases.test.js` | GOOD - 44+ cases across 2 files |
| `lib/commands/ship.js` | YES | `test/commands/ship.test.js` | GOOD - 16 cases |
| `lib/commands/status.js` | YES | `test/commands/status.test.js` | GOOD - 16 cases |
| `lib/commands/validate.js` | YES | `test/commands/validate.test.js` | MODERATE - 15 cases, 8 skipped |
| `lib/commands/recommend.js` | YES | `test/commands/recommend.test.js`, `test/plugin-recommend.test.js` | GOOD - 8 cases + integration check |
| `lib/commands/team.js` | YES | `test/commands/team.test.js` | THIN - 3 cases (existence + export + forge.js routing) |
| `lib/commands/_registry.js` | YES | `test/commands/_registry.test.js` | EXCELLENT - 13 cases, full unit coverage |
| `bin/forge.js` | YES | `test/cli/forge.test.js`, `test/forge-cli-registry.test.js`, `test/forge-commands.test.js`, `test/lazy-dirs.test.js`, `test/setup-summary.test.js` | MODERATE - structural tests, spawn tests |
| `scripts/branch-protection.js` | YES | `test/branch-protection.test.js` | GOOD - mock git, cross-platform |
| `scripts/dep-guard-analyze.js` | YES | `test/scripts/dep-guard-analyze.test.js` | THIN - 1 integration test |

### Current Registry-Compliant Commands (have `{ name, description, handler }`)
- `sync.js`, `worktree.js`, `push.js`, `test.js`, `clean.js` -- **5 commands**

### Non-Compliant Commands (hardcoded dispatch in forge.js)
- `recommend.js` -- exports `{ handleRecommend, formatRecommendations }`
- `team.js` -- exports `{ handleTeam }`
- `dev.js` -- exports many functions, no `name/description/handler`
- `plan.js` -- exports many functions, no `name/description/handler`
- `ship.js` -- exports many functions, no `name/description/handler`
- `status.js` -- exports many functions, no `name/description/handler`
- `validate.js` -- exports many functions, no `name/description/handler`

### Additional Commands Hardcoded in forge.js (not in lib/commands/)
- `setup` -- inline in forge.js (~200 lines of logic)
- `docs` -- inline in forge.js (~20 lines)
- `reset` -- delegates to `lib/reset.js`
- `reinstall` -- delegates to `lib/reset.js`
- `rollback` -- inline in forge.js (~100 lines)

---

## Step 3: Test Framework Analysis

- **Runner**: `bun:test` (imports: `describe, test, expect, beforeEach, afterEach, spyOn`)
- **Config**: `bun test --timeout 15000` in package.json
- **No separate bun test config file** (uses bun defaults)
- **Test patterns**:
  - Unit tests: direct `require()` of module, test exported functions
  - Integration tests: `spawnSync`/`execFileSync` to run CLI scripts
  - Structural tests: `fs.readFileSync` to check source code structure
  - Fixture tests: `test-env/` with real git repos
- **Mocking**: `spyOn(console, 'warn')`, temp dirs (`fs.mkdtempSync`), dependency injection (`opts._exec`)
- **No formal mock library** (no jest.mock, no testdouble)

---

## Step 4: TDD Scenarios Per Child Issue

### forge-6w1: Registry Migration (Non-compliant commands -> compliant)

**Goal**: Migrate dev, plan, ship, status, validate, recommend, team to registry-compliant `{ name, description, handler }` exports while preserving existing utility exports.

**RED tests to write first:**

1. **Registry loads migrated command**: For each of {dev, plan, ship, status, validate, recommend, team}:
   ```
   test('registry discovers <cmd> with name/description/handler', () => {
     const { commands } = loadCommands(COMMANDS_DIR);
     expect(commands.has('<cmd>')).toBe(true);
     const cmd = commands.get('<cmd>');
     expect(cmd.name).toBe('<cmd>');
     expect(typeof cmd.description).toBe('string');
     expect(typeof cmd.handler).toBe('function');
   });
   ```

2. **Handler receives correct args**: For each migrated command:
   ```
   test('<cmd> handler receives (args, flags, projectRoot)', async () => {
     const mod = require('../../lib/commands/<cmd>');
     expect(typeof mod.handler).toBe('function');
     // handler should accept 3 args without throwing
   });
   ```

3. **Existing utility exports preserved**: For each command with existing exported functions:
   ```
   test('<cmd> still exports utility functions after migration', () => {
     const mod = require('../../lib/commands/<cmd>');
     // dev.js: detectTDDPhase, identifyFilePairs, runTests, etc.
     expect(typeof mod.detectTDDPhase).toBe('function');
     // ... all existing exports
   });
   ```

4. **Cross-command imports still work**:
   ```
   test('dev-commit-verify can still import verifyTaskCompletion', () => {
     const { verifyTaskCompletion } = require('../../lib/commands/dev');
     expect(typeof verifyTaskCompletion).toBe('function');
   });
   ```

5. **Existing test suites pass unchanged**: No existing test should break — the new `name`, `description`, `handler` exports are additive.

**GREEN**: Add `name`, `description`, `handler` to each module's `module.exports` while keeping all existing exports.

**REFACTOR**: Standardize export shape across all commands.

---

### forge-ezno: Importable Scripts (branch-protection, dep-guard-analyze)

**Goal**: Scripts currently execute on `require()`. Make them importable without side effects.

**RED tests to write first:**

1. **require() doesn't trigger execution**:
   ```
   test('require("scripts/branch-protection") does not call process.exit', () => {
     // Currently these scripts run on require()
     // After fix: require should return exports without side effects
     const mod = require('../../scripts/branch-protection');
     expect(typeof mod.runBranchProtection).toBe('function');
     // Test didn't crash = no side-effect execution
   });
   ```

2. **Exported function runs correctly when called**:
   ```
   test('runBranchProtection() returns result object', () => {
     const { runBranchProtection } = require('../../scripts/branch-protection');
     const result = runBranchProtection({ branch: 'feat/test' });
     expect(result.allowed).toBeDefined();
   });
   ```

3. **Module-level guard works (main module detection)**:
   ```
   test('script runs when executed directly (require.main === module)', () => {
     const { status } = spawnSync(process.execPath, [SCRIPT_PATH, ...args]);
     expect(status).toBe(0); // Still works as CLI
   });
   ```

4. **dep-guard-analyze importable**:
   ```
   test('require("scripts/dep-guard-analyze") returns exported functions', () => {
     const mod = require('../../scripts/dep-guard-analyze');
     expect(typeof mod.analyze).toBe('function');
   });
   ```

**GREEN**: Wrap script-level execution in `if (require.main === module) { ... }` guard, export functions.

**REFACTOR**: Standardize DI pattern across scripts.

---

### forge-he3s: Lint Command

**Goal**: Create `lib/commands/lint.js` as registry-compliant command.

**RED tests to write first:**

1. **Lint command loads in registry**:
   ```
   test('registry discovers lint command', () => {
     const { commands } = loadCommands(COMMANDS_DIR);
     expect(commands.has('lint')).toBe(true);
   });
   ```

2. **Lint handler runs eslint and returns results**:
   ```
   test('lint handler returns { success, errors, warnings }', async () => {
     const { handler } = require('../../lib/commands/lint');
     const result = await handler([], {}, projectRoot);
     expect(typeof result.success).toBe('boolean');
   });
   ```

3. **Lint handles missing eslint gracefully**:
   ```
   test('lint returns error when eslint not found', async () => {
     const { handler } = require('../../lib/commands/lint');
     // Test with PATH that excludes eslint
     const result = await handler([], {}, '/nonexistent');
     expect(result.success).toBe(false);
     expect(result.error).toMatch(/eslint/i);
   });
   ```

4. **Lint accepts --fix flag**:
   ```
   test('lint passes --fix to eslint', async () => {
     const { handler } = require('../../lib/commands/lint');
     const result = await handler([], { fix: true }, projectRoot);
     expect(result).toBeDefined();
   });
   ```

5. **Lint module has correct export shape**:
   ```
   test('lint exports { name, description, handler }', () => {
     const mod = require('../../lib/commands/lint');
     expect(mod.name).toBe('lint');
     expect(typeof mod.description).toBe('string');
     expect(typeof mod.handler).toBe('function');
   });
   ```

**GREEN**: Create `lib/commands/lint.js` wrapping eslint execution.

**REFACTOR**: Extract shared CLI-tool-runner pattern if lint/test/push share logic.

---

### forge-p01t: Thin Bootstrap (Extract setup/rollback from forge.js)

**Goal**: Extract setup, docs, reset, reinstall, rollback from forge.js into importable command modules. Make forge.js a thin dispatcher.

**RED tests to write first:**

1. **bin/forge.js dispatches ALL commands through registry**:
   ```
   test('forge.js main() only uses registry for command dispatch', () => {
     const source = fs.readFileSync(forgePath, 'utf8');
     // After extraction, there should be no hardcoded command === 'setup' etc.
     // All dispatch goes through registry.commands.has(command)
     expect(source).not.toContain("command === 'setup'");
     expect(source).not.toContain("command === 'recommend'");
     expect(source).not.toContain("command === 'team'");
     expect(source).not.toContain("command === 'rollback'");
   });
   ```

2. **Setup command works from extracted module**:
   ```
   test('lib/commands/setup.js exports registry-compliant shape', () => {
     const mod = require('../../lib/commands/setup');
     expect(mod.name).toBe('setup');
     expect(typeof mod.handler).toBe('function');
   });
   ```

3. **Rollback command works from extracted module**:
   ```
   test('lib/commands/rollback.js exports registry-compliant shape', () => {
     const mod = require('../../lib/commands/rollback');
     expect(mod.name).toBe('rollback');
     expect(typeof mod.handler).toBe('function');
   });
   ```

4. **Utility functions work from new locations**:
   ```
   test('ensureDirWithNote still accessible after extraction', () => {
     // This function is currently in bin/forge.js
     // After extraction it should be in a lib/ module
     const { ensureDirWithNote } = require('../../lib/fs-utils');
     expect(typeof ensureDirWithNote).toBe('function');
   });
   ```

5. **forge.js line count reduced**:
   ```
   test('bin/forge.js is under 500 lines (thin bootstrap)', () => {
     const source = fs.readFileSync(forgePath, 'utf8');
     const lines = source.split('\n').length;
     expect(lines).toBeLessThan(500);
   });
   ```

6. **CLI integration still works end-to-end**:
   ```
   test('forge setup --help still works', () => {
     const { status } = spawnSync(process.execPath, [forgePath, 'setup', '--help']);
     expect(status).toBe(0);
   });

   test('forge recommend still works', () => {
     const { status } = spawnSync(process.execPath, [forgePath, 'recommend']);
     expect(status).toBe(0);
   });
   ```

**GREEN**: Extract command logic into `lib/commands/setup.js`, `lib/commands/rollback.js`, `lib/commands/docs.js`, `lib/commands/reset.js`. Make forge.js a thin bootstrap (parse args, load registry, dispatch).

**REFACTOR**: Deduplicate flag parsing, consolidate error handling.

---

## Risk Matrix

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Existing tests break on import path changes | HIGH | Migration is additive (new exports), not destructive |
| test/cli/forge.test.js checks function names in source | MEDIUM | Update structural tests in same PR |
| test/commands/team.test.js checks forge.js contains 'handleTeam' | MEDIUM | Update integration assertion after migration |
| test/commands/recommend.test.js checks forge.js contains 'recommend' | LOW | Registry dispatch still references the name |
| test-env/ fixture tests fail during git push | LOW | Known issue, fix root cause |
| Structural command-contracts.test.js enforces current shape | MEDIUM | Verify what it checks, update if needed |

## Execution Order

1. **forge-6w1** (registry migration) first -- foundational, unblocks all others
2. **forge-ezno** (importable scripts) second -- independent, no dependencies
3. **forge-he3s** (lint command) third -- depends on registry being stable
4. **forge-p01t** (thin bootstrap) last -- depends on ALL commands being registry-compliant
