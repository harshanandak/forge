# CLI Maturity — Task List

**Epic**: forge-vi7v
**Branch**: feat/cli-maturity
**Design doc**: docs/plans/2026-03-30-cli-maturity-design.md
**Baseline**: 2484 pass / 31 skip / 12 fail (pre-existing) / 9 errors (pre-existing)

---

## Wave 1: Foundation (parallel — no shared files)

### Task 1: forge-6w1 — Fix P0 bogus name exports and incompatible modules
**File(s)**: `lib/commands/dev.js`, `lib/commands/status.js`, `lib/commands/recommend.js`, `lib/commands/team.js`
**OWNS**: lib/commands/dev.js, lib/commands/status.js, lib/commands/recommend.js, lib/commands/team.js
**What to implement**: Fix P0 blockers before registry migration:
- `dev.js`: Change `name: 'feature-a'` → `name: 'dev'`
- `status.js`: Change `name: 'Fresh Start'` → `name: 'status'`
- `recommend.js`: Add `name: 'recommend'`, `description`, `handler` wrapping `handleRecommend`
- `team.js`: Add `name: 'team'`, `description`, `handler` wrapping `handleTeam`; replace `process.exit(err.status || 1)` with `throw err`
**TDD steps**:
  1. Write test: `test/commands/registry-compliance.test.js` — for each of {dev, status, recommend, team}: assert `mod.name === '<cmd>'`, `typeof mod.handler === 'function'`
  2. Run test: confirm RED — dev has wrong name, status has wrong name, recommend/team have no handler
  3. Implement: Fix name exports, add handler wrappers
  4. Run test: confirm GREEN
  5. Run existing tests: confirm no regressions
  6. Commit: `fix: correct P0 name exports and add handler wrappers for 4 commands`
**Expected output**: All 4 commands load in registry with correct names

### Task 2: forge-6w1 — Migrate remaining 3 commands (plan, ship, validate) to registry
**File(s)**: `lib/commands/plan.js`, `lib/commands/ship.js`, `lib/commands/validate.js`
**OWNS**: lib/commands/plan.js, lib/commands/ship.js, lib/commands/validate.js
**What to implement**: Add `name`, `description`, `handler` exports to each. All 3 already have `execute*()` orchestrator functions — handler wraps these.
- `plan.js`: `handler` calls existing orchestration logic with (args, flags, projectRoot)
- `ship.js`: `handler` wraps ship orchestration
- `validate.js`: `handler` wraps `executeValidate`
**TDD steps**:
  1. Write test: Extend `registry-compliance.test.js` — for {plan, ship, validate}: assert registry discovers them, handler is callable
  2. Run test: confirm RED — no handler exported
  3. Implement: Add handler + name + description to each module's exports
  4. Run test: confirm GREEN
  5. Run existing tests: confirm all existing destructured imports still work
  6. Commit: `feat: migrate plan, ship, validate to registry pattern`
**Expected output**: All 12 commands now registry-compliant

### Task 3: forge-6w1 — Remove hard-coded dispatch from bin/forge.js
**File(s)**: `bin/forge.js`
**OWNS**: bin/forge.js (dispatch section only, ~lines 4200-4350)
**What to implement**: Remove the hard-coded `if (command === 'recommend')` and `if (command === 'team')` dispatch blocks. These now route through registry. Also verify registry dispatch is the ONLY path for all 12 commands.
**TDD steps**:
  1. Write test: `test/cli/forge-dispatch.test.js` — structural test: bin/forge.js source should NOT contain `command === 'recommend'` or `command === 'team'` dispatch
  2. Run test: confirm RED — hard-coded blocks exist
  3. Implement: Remove the dispatch blocks
  4. Run test: confirm GREEN
  5. Run integration test: `forge recommend` and `forge team` still work (routed via registry)
  6. Commit: `refactor: remove hard-coded recommend/team dispatch — all commands use registry`
**Expected output**: bin/forge.js only dispatches through registry for these commands

### Task 4: forge-6w1 — Migrate forge-cmd.js to use registry
**File(s)**: `bin/forge-cmd.js`
**OWNS**: bin/forge-cmd.js
**What to implement**: Replace hardcoded `HANDLERS` map (5 commands) with registry import. `forge-cmd.js` should `require('../lib/commands/_registry')`, call `loadCommands()`, and dispatch via `commands.get(command).handler()`.
**TDD steps**:
  1. Write test: `test/cli/forge-cmd-registry.test.js` — structural test: forge-cmd.js should NOT contain hardcoded HANDLERS object
  2. Run test: confirm RED
  3. Implement: Replace HANDLERS with registry dispatch
  4. Run test: confirm GREEN
  5. Run existing `test/cli/forge-cmd.test.js`: confirm 14 tests still pass
  6. Commit: `refactor: migrate forge-cmd.js from hardcoded HANDLERS to registry dispatch`
**Expected output**: Single dispatch path for all entry points

---

### Task 5: forge-ezno — Guard branch-protection.js
**File(s)**: `scripts/branch-protection.js`
**OWNS**: scripts/branch-protection.js
**What to implement**: Wrap bare `main()` call (line 183) in `if (require.main === module) { main(); }`. Export `runBranchProtection()` function for programmatic use. Move `process.exit()` calls from inside `main()` to the guard block — `main()` returns exit code instead.
**TDD steps**:
  1. Write test: `test/scripts/branch-protection-import.test.js` — `require()` does NOT trigger execution, returns exported function
  2. Run test: confirm RED — require triggers main() and potentially exits
  3. Implement: Add require.main guard, export function, return exit codes instead of process.exit
  4. Run test: confirm GREEN
  5. Run existing `test/branch-protection.test.js`: confirm all tests pass
  6. Commit: `refactor: guard branch-protection.js for safe require()`
**Expected output**: Script importable without side effects

### Task 6: forge-ezno — Guard dep-guard-analyze.js
**File(s)**: `scripts/dep-guard-analyze.js`
**OWNS**: scripts/dep-guard-analyze.js
**What to implement**: Wrap `main()` call (line 67) in `if (require.main === module)` guard. Export `analyze()` function. Move `process.exit(1)` to guard block — `main()` throws on error instead.
**TDD steps**:
  1. Write test: `test/scripts/dep-guard-analyze-import.test.js` — `require()` returns exports without execution
  2. Run test: confirm RED
  3. Implement: Add guard, export function, throw instead of exit
  4. Run test: confirm GREEN
  5. Run existing test: `test/scripts/dep-guard-analyze.test.js` passes
  6. Commit: `refactor: guard dep-guard-analyze.js for safe require()`
**Expected output**: Script importable without side effects

---

## Wave 2: New command + thin bootstrap prep (after Wave 1 complete)

### Task 7: forge-he3s — Create lib/commands/lint.js
**File(s)**: `lib/commands/lint.js` (new file)
**OWNS**: lib/commands/lint.js
**What to implement**: Create registry-compliant lint command. Handler runs eslint via the project's configured lint command (from package.json scripts or fallback to `eslint . --max-warnings 0`). Supports `--fix` flag. Returns `{ success, errors, warnings }`.
**TDD steps**:
  1. Write test: `test/commands/lint.test.js` — registry discovers lint, handler returns result object, handles --fix flag, handles missing eslint gracefully
  2. Run test: confirm RED — lint.js doesn't exist
  3. Implement: Create lint.js with `{name: 'lint', description, handler, usage, flags}`
  4. Run test: confirm GREEN
  5. Run registry tests: confirm 13th command loads
  6. Commit: `feat: add forge lint command (lib/commands/lint.js)`
**Expected output**: `forge lint` works, returns structured results

### Task 8: forge-p01t — Extract shell-utils, validation-utils, ui-utils from bin/forge.js
**File(s)**: `lib/shell-utils.js` (new), `lib/validation-utils.js` (new), `lib/ui-utils.js` (new), `bin/forge.js`
**OWNS**: lib/shell-utils.js, lib/validation-utils.js, lib/ui-utils.js
**What to implement**: Extract zero-dependency utility functions from bin/forge.js (Wave 1 of extraction map):
- `lib/shell-utils.js`: `secureExecFileSync`, shell execution wrappers
- `lib/validation-utils.js`: `validateUserInput`, `validatePathInput`, `validateAgentInput`, `validateHashInput`
- `lib/ui-utils.js`: `askYesNo`, display/formatting functions
Update bin/forge.js to import from these modules.
**TDD steps**:
  1. Write test: `test/lib/shell-utils.test.js`, `test/lib/validation-utils.test.js`, `test/lib/ui-utils.test.js` — each function works when imported from new location
  2. Run test: confirm RED — files don't exist
  3. Implement: Extract functions, update imports in bin/forge.js
  4. Run test: confirm GREEN
  5. Run full suite: confirm no regressions
  6. Commit: `refactor: extract shell, validation, UI utilities from bin/forge.js`
**Expected output**: Utility functions importable from lib/, bin/forge.js shrinks

### Task 9: forge-p01t — Extract file-utils and detection-utils from bin/forge.js
**File(s)**: `lib/file-utils.js` (new), `lib/detection-utils.js` (new), `bin/forge.js`
**OWNS**: lib/file-utils.js, lib/detection-utils.js
**What to implement**: Extract Wave 2 of extraction map:
- `lib/file-utils.js`: `readFile`, `writeFile`, `copyFile`, `createSymlinkOrCopy`, `ensureDir`, `ensureDirWithNote`, `stripFrontmatter`, env file operations
- `lib/detection-utils.js`: `detectPackageManager`, `detectProjectStatus`, `detectTestFramework`, `detectLanguageFeatures`, `detectNextJs`, `detectNestJs`, etc.
Update bin/forge.js to import. Update test/lazy-dirs.test.js to import `ensureDirWithNote` from new location.
**TDD steps**:
  1. Write test: `test/lib/file-utils.test.js`, `test/lib/detection-utils.test.js`
  2. Run test: confirm RED
  3. Implement: Extract functions, update imports
  4. Run test: confirm GREEN
  5. Run full suite + `test/lazy-dirs.test.js` specifically
  6. Commit: `refactor: extract file and detection utilities from bin/forge.js`
**Expected output**: bin/forge.js shrinks further, utilities independently testable

### Task 10: forge-p01t — Create ForgeContext and extract rollback command
**File(s)**: `lib/forge-context.js` (new), `lib/commands/rollback.js` (new), `bin/forge.js`
**OWNS**: lib/forge-context.js, lib/commands/rollback.js
**What to implement**:
- Create `ForgeContext` class holding mutable state: `projectRoot`, `FORCE_MODE`, `VERBOSE_MODE`, `NON_INTERACTIVE`, `SYMLINK_ONLY`, `SYNC_ENABLED`, `PKG_MANAGER`, `actionLog`
- Extract rollback functions (17 functions, self-contained) from bin/forge.js into `lib/commands/rollback.js` as registry-compliant command
- `showRollbackMenu` calls `main()` → replace with callback pattern
- Replace `process.exit()` calls with `throw ExitError`
**TDD steps**:
  1. Write test: `test/lib/forge-context.test.js` — context holds state, provides defaults; `test/commands/rollback.test.js` — handler is callable, returns result object
  2. Run test: confirm RED
  3. Implement: Create ForgeContext, extract rollback, update bin/forge.js
  4. Run test: confirm GREEN
  5. Run full suite
  6. Commit: `refactor: extract ForgeContext and rollback command from bin/forge.js`
**Expected output**: Rollback routes through registry, ForgeContext replaces globals

### Task 11: forge-p01t — Extract setup command from bin/forge.js
**File(s)**: `lib/commands/setup.js` (new — full implementation, not just the existing stub), `bin/forge.js`
**OWNS**: lib/commands/setup.js (replaces any existing stub)
**What to implement**: Extract setup functions (~95 functions, ~3400 lines) from bin/forge.js. This is the largest extraction. Setup handler receives ForgeContext. Extract in sub-groups:
- Core setup: `_interactiveSetup`, `checkPrerequisites`
- Agent setup: `setupAgent`, agent-specific functions
- Docs setup: `setupCoreDocs`, `displaySetupSummary`
- Config setup: `setupClaudeMcpConfig`, env handling
All `process.exit()` → `throw ExitError`. All `__dirname` → `PACKAGE_ROOT` from ForgeContext.
**TDD steps**:
  1. Write test: `test/commands/setup.test.js` — handler callable, exports registry shape, setup functions return results instead of exiting
  2. Run test: confirm RED
  3. Implement: Extract in logical sub-groups, update bin/forge.js to import
  4. Run test: confirm GREEN
  5. Run full suite including `test/setup-summary.test.js`
  6. Commit: `refactor: extract setup command from bin/forge.js (~3400 lines)`
**Expected output**: Setup routes through registry, bin/forge.js dramatically smaller

### Task 12: forge-p01t — Extract remaining commands (docs, reset, reinstall) and slim bootstrap
**File(s)**: `lib/commands/docs.js` (new), `lib/commands/reset.js` (new or updated), `bin/forge.js`
**OWNS**: lib/commands/docs.js, lib/commands/reset.js, bin/forge.js (final slim)
**What to implement**:
- Extract `docs` command (small, ~20 lines) into registry-compliant module
- Extract `reset`/`reinstall` into registry-compliant modules (currently delegates to lib/reset.js)
- Remove ALL remaining hard-coded dispatch from bin/forge.js
- bin/forge.js becomes thin bootstrap: parse args → create ForgeContext → load registry → dispatch → handle ExitError
- Target: ~300-350 lines
**TDD steps**:
  1. Write test: Extend `test/cli/forge-dispatch.test.js` — source should NOT contain any `command ===` dispatch; line count < 500
  2. Run test: confirm RED
  3. Implement: Extract remaining commands, slim down bootstrap
  4. Run test: confirm GREEN
  5. Run FULL test suite: all 2484+ tests pass
  6. Commit: `refactor: slim bin/forge.js to ~300-line bootstrap — all commands via registry`
**Expected output**: bin/forge.js is thin bootstrap, zero hard-coded dispatch

---

## Wave 3: Cleanup and validation

### Task 13: Update structural tests and test imports
**File(s)**: `test/cli/forge.test.js`, `test/commands/team.test.js`, `test/forge-commands.test.js`, `test/structural/command-contracts.test.js`
**OWNS**: test/cli/forge.test.js, test/commands/team.test.js, test/forge-commands.test.js, test/structural/command-contracts.test.js
**What to implement**: Update tests that check source text of bin/forge.js (function existence, routing). Update test imports that destructure from command files — point them to new utility module paths. Update `test/forge-commands.test.js` to import `getWorkflowCommands` from its new location.
**TDD steps**:
  1. Run failing tests to identify all structural test breaks
  2. Update each test to reflect new architecture
  3. Run tests: confirm GREEN
  4. Commit: `test: update structural tests and imports for new architecture`
**Expected output**: All structural/import tests pass with new module locations

### Task 14: End-to-end CLI integration verification
**File(s)**: No new files — test-only task
**OWNS**: (none — read-only verification)
**What to implement**: Run every forge CLI command to verify end-to-end:
- `forge setup --help`
- `forge test --help`
- `forge lint`
- `forge status`
- `forge recommend`
- `forge push --help`
- `forge clean --help`
- `forge worktree --help`
- `forge sync --help`
- `forge rollback --help`
- `forge docs --help`
- `forge reset --help`
Verify each command dispatches through registry and produces expected output.
**TDD steps**:
  1. Run each command, capture output
  2. Verify no "Unknown command" errors
  3. Verify no crashes or stack traces
  4. Document any issues found
  5. Commit: `test: verify end-to-end CLI integration for all registry commands`
**Expected output**: All 15+ CLI commands work through registry

---

## Parallel Wave Structure

```
Wave 1 (no shared files — fully parallel):
  ├─ Task 1: Fix P0 name/export issues (dev, status, recommend, team)
  ├─ Task 2: Migrate plan, ship, validate to registry
  ├─ Task 5: Guard branch-protection.js
  └─ Task 6: Guard dep-guard-analyze.js

Wave 1b (depends on Tasks 1+2):
  ├─ Task 3: Remove hard-coded dispatch from bin/forge.js
  └─ Task 4: Migrate forge-cmd.js to registry

Wave 2 (depends on Wave 1b — sequential within wave):
  ├─ Task 7:  Create lint command
  ├─ Task 8:  Extract shell/validation/UI utils
  ├─ Task 9:  Extract file/detection utils
  ├─ Task 10: Create ForgeContext + extract rollback
  ├─ Task 11: Extract setup command (~3400 lines)
  └─ Task 12: Extract docs/reset/reinstall + slim bootstrap

Wave 3 (depends on Wave 2):
  ├─ Task 13: Update structural tests
  └─ Task 14: End-to-end verification
```

## File Ownership Matrix

| File | Task |
|------|------|
| lib/commands/dev.js | Task 1 |
| lib/commands/status.js | Task 1 |
| lib/commands/recommend.js | Task 1 |
| lib/commands/team.js | Task 1 |
| lib/commands/plan.js | Task 2 |
| lib/commands/ship.js | Task 2 |
| lib/commands/validate.js | Task 2 |
| bin/forge.js (dispatch) | Task 3 |
| bin/forge-cmd.js | Task 4 |
| scripts/branch-protection.js | Task 5 |
| scripts/dep-guard-analyze.js | Task 6 |
| lib/commands/lint.js | Task 7 |
| lib/shell-utils.js | Task 8 |
| lib/validation-utils.js | Task 8 |
| lib/ui-utils.js | Task 8 |
| lib/file-utils.js | Task 9 |
| lib/detection-utils.js | Task 9 |
| lib/forge-context.js | Task 10 |
| lib/commands/rollback.js | Task 10 |
| lib/commands/setup.js | Task 11 |
| lib/commands/docs.js | Task 12 |
| lib/commands/reset.js | Task 12 |
| bin/forge.js (slim) | Task 12 |
| test/cli/forge.test.js | Task 13 |
| test/commands/team.test.js | Task 13 |
| test/forge-commands.test.js | Task 13 |

## Risk Mitigations Built Into Tasks

| Risk | Mitigation | Task |
|------|-----------|------|
| P0: Bogus name exports | Fixed first in Task 1 | 1 |
| P0: Incompatible exports | Fixed first in Task 1 | 1 |
| P0: Unguarded main() | Fixed in Task 5 | 5 |
| P1: Mutable globals | ForgeContext in Task 10 | 10 |
| P1: Dual registry | forge-cmd.js migrated in Task 4 | 4 |
| P1: process.exit in lib/ | ExitError pattern in Task 10 | 10 |
| P1: Test import breaks | Structural test update in Task 13 | 13 |
| P1: __dirname changes | PACKAGE_ROOT via ForgeContext in Task 10 | 10 |
| P1: Circular showRollbackMenu→main | Callback pattern in Task 10 | 10 |
| A03: Injection risk | secureExecFileSync to shared lib/shell-utils.js in Task 8 | 8 |
