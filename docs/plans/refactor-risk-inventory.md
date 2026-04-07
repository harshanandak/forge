# Forge CLI Refactoring: Risk Inventory

Ranked by severity * likelihood (highest first).

---

## RISK 1: Two command modules have incompatible exports -- recommend.js and team.js will fail registry validation

**Severity: HIGH | Likelihood: HIGH**

Files affected:
- `lib/commands/recommend.js` (line 119: exports `{ formatRecommendations, handleRecommend }` -- no `name`, `description`, or `handler`)
- `lib/commands/team.js` (line 37: exports `{ handleTeam }` -- no `name`, `description`, or `handler`)

Evidence: The registry (`_registry.js`) validates that every module exports `{ name, description, handler }` (all required). These two files export bare functions. The registry's `validateCommand()` will reject them, and they will silently disappear from the command map.

Currently, `recommend` is dispatched by hardcoded logic in `bin/forge.js` (not via the registry), and `team` calls a shell script. If the refactoring moves ALL command dispatch to the registry, both break.

Mitigation: Before refactoring, convert both modules to the `{ name, description, handler }` export shape. Verify tests import the new shape.

---

## RISK 2: Bogus `name` exports in existing command files will cause silent routing failures

**Severity: HIGH | Likelihood: HIGH**

Files affected:
- `lib/commands/dev.js` exports `name: 'feature-a'` (should be `'dev'`)
- `lib/commands/status.js` exports `name: 'Fresh Start'` (should be `'status'`)
- `lib/commands/plan.js`, `lib/commands/ship.js` -- grep found NO `name:` export at all

Evidence: The `duplicate-name-values` scan shows these anomalous names. The registry builds its Map keyed by `mod.name`. If `dev.js` registers as `'feature-a'`, then `forge dev` will not find it. `status.js` registering as `'Fresh Start'` (with a space) means `forge status` fails.

Currently this works because `bin/forge.js` at line 4141 calls `loadCommands()` but also has hardcoded fallback dispatch for setup/docs/recommend/reset/rollback. The registry is only used for the newer commands (push, clean, sync, worktree, test, team). But if `status`, `plan`, `dev`, `validate`, `ship` move to registry-only dispatch, the bogus names will break them.

Mitigation: Audit and fix ALL `name` exports before migration. Add a test: `for each .js in lib/commands/, require it and assert name matches filename`.

---

## RISK 3: branch-protection.js calls main() unconditionally at top level -- require() will execute it

**Severity: HIGH | Likelihood: HIGH**

Files affected:
- `scripts/branch-protection.js` (line 183: bare `main()` call, no `require.main` guard)
- `scripts/branch-protection.js` (lines 154, 175, 179: `process.exit()` calls inside `main()`)

Evidence: The script has `main()` at line 183 with no conditional guard. If any module does `require('./branch-protection.js')`, it will immediately execute `main()` and may `process.exit(1)`, killing the entire process.

Mitigation: Wrap `main()` in `if (require.main === module) { main(); }` and export individual functions for programmatic use.

---

## RISK 4: dep-guard-analyze.js has conditional main() but process.exit inside -- unsafe for require()

**Severity: MEDIUM | Likelihood: HIGH**

Files affected:
- `scripts/dep-guard-analyze.js` (line 67: `main()` call appears conditional, line 70: `process.exit(1)` inside `main()`)

Evidence: Even with a guard, the `process.exit(1)` on error in `main()` means if someone calls the exported `main()` programmatically, it kills the process. The script's actual logic lives in `../lib/dep-guard/analyzer.js` (the `analyzePhase3Dependencies` function), but the CLI wrapper has process-killing side effects.

Mitigation: Have `main()` throw instead of `process.exit()`. Only call `process.exit()` in the `require.main` guard block.

---

## RISK 5: bin/forge.js has ~4765 lines with ~70+ functions and mutable global state -- extraction will break closures

**Severity: HIGH | Likelihood: MEDIUM**

Files affected:
- `bin/forge.js` (4765 lines, 70+ function definitions)
- Global mutable state: `projectRoot` (line 81, `let`), `FORCE_MODE`, `VERBOSE_MODE`, `NON_INTERACTIVE`, `SYMLINK_ONLY`, `SYNC_ENABLED`, `PKG_MANAGER`, `actionLog` (lines 85-93)

Evidence: Many functions in forge.js read/write these globals (e.g., `projectRoot` is reassigned by `handlePathSetup`, `FORCE_MODE` is set inside `main()`). When extracting functions to `lib/` modules, they lose access to these globals. You must either:
1. Thread them as parameters (large refactor of every function signature), or
2. Create a shared state module (risk: introduces coupling)

Mitigation: Identify which globals each function group depends on. Start by extracting pure functions (no global reads). For stateful functions, create a `ForgeContext` object passed as parameter.

---

## RISK 6: forge-cmd.js hardcodes only 5 commands in HANDLERS but VALID_COMMANDS lists 9 -- dual registry

**Severity: MEDIUM | Likelihood: MEDIUM**

Files affected:
- `bin/forge-cmd.js` (lines 13-18: HANDLERS has status/plan/dev/validate/ship; lines 20-30: VALID_COMMANDS has 9 including review/merge/verify/check)

Evidence: `forge-cmd.js` is a SEPARATE entry point from `forge.js`. It has its own hardcoded `HANDLERS` map that only covers 5 commands, completely separate from the auto-discovery registry. If the refactoring changes command exports, `forge-cmd.js` will break independently. Tests in `test/commands/` import directly from `lib/commands/` using `require('../../lib/commands/...')`.

Mitigation: Either deprecate `forge-cmd.js` or have it use the same `_registry.js` auto-discovery. Ensure the test suite covers both entry points.

---

## RISK 7: process.exit() in lib/commands/team.js -- library code should not exit the process

**Severity: MEDIUM | Likelihood: MEDIUM**

Files affected:
- `lib/commands/team.js` (line 33: `process.exit(err.status || 1)`)

Evidence: This is inside a catch block. When called via the registry dispatch in `bin/forge.js` (which has its own try/catch at lines 4163-4171), the `process.exit()` in team.js will fire BEFORE the caller's catch block can handle the error. This prevents graceful error handling.

Mitigation: Replace `process.exit()` with `throw` or return `{ success: false }`. Let the caller decide to exit.

---

## RISK 8: 20+ process.exit() calls in bin/forge.js will be trapped inside extracted lib/ modules

**Severity: MEDIUM | Likelihood: MEDIUM**

Files affected:
- `bin/forge.js` lines: 406, 2422, 2429, 2634, 2674, 2680, 2702, 2708, 3738, 3745, 3825, 3832, 3842, 3860, 4089, 4156, 4167, 4171, 4222, 4242, 4254

Evidence: When extracting ~2500 lines of setup/rollback/utilities from bin/forge.js into lib/ modules, these `process.exit()` calls come along. Library modules should return error codes or throw -- not kill the process. But changing them requires updating EVERY call site.

Mitigation: Create an `ExitError` class. Library functions throw `ExitError(code)`. The top-level `main()` catches it and calls `process.exit(code)`.

---

## RISK 9: Test imports use destructured named exports -- changing export shape breaks tests

**Severity: MEDIUM | Likelihood: MEDIUM**

Files affected:
- `test/commands/validate.test.js` line 9: `const { executeValidate, ... } = require('../../lib/commands/validate.js')`
- `test/commands/status.test.js` line 10: `const { detectStage, analyzeBranch, ... } = require('../../lib/commands/status.js')`
- `test/commands/plan.phases.test.js` line 44: destructured imports of multiple functions
- `test/commands/dev.test.js` line 12: destructured imports
- `test/commands/ship.test.js` line 9: destructured imports
- `test/commands/recommend.test.js` line 5: `const { formatRecommendations, handleRecommend }`
- `test/commands/team.test.js` line 11: `const { handleTeam }`

Evidence: If utility functions are extracted from validate.js to validate-utils.js, the test file still does `require('../../lib/commands/validate.js')`. The functions won't be there anymore. Every test import path must be updated.

Mitigation: Keep re-exports in the original module (e.g., `validate.js` re-exports from `validate-utils.js`) for backward compatibility. Or update all test imports simultaneously.

---

## RISK 10: __dirname in bin/forge.js resolves to bin/ -- extracted functions will get wrong paths

**Severity: MEDIUM | Likelihood: MEDIUM**

Files affected:
- `bin/forge.js` line 44: `const packageDir = path.dirname(__dirname)`
- `bin/forge.js` line 45: `require(path.join(packageDir, 'package.json'))`
- `bin/forge.js` lines 57-65: Multiple `require(path.join(packageDir, 'lib', ...))`
- `bin/forge.js` lines 2787, 4141: `loadCommands(path.join(__dirname, '..', 'lib', 'commands'))`

Evidence: When functions move from `bin/forge.js` to `lib/some-module.js`, `__dirname` changes from `bin/` to `lib/`. Any code using `path.join(__dirname, '..', 'lib', 'commands')` would resolve to `../lib/commands` relative to `lib/`, which is `commands/` (wrong). Must change to `path.join(__dirname, 'commands')` or use `packageDir`.

Mitigation: Replace all `__dirname`-relative paths with an explicit `PACKAGE_ROOT` constant passed in or computed once.

---

## RISK 11: No worktree-aware root discovery in lib/commands/team.js

**Severity: LOW | Likelihood: MEDIUM**

Files affected:
- `lib/commands/team.js` (line 25: `path.join(__dirname, '..', '..', 'scripts', 'forge-team', 'index.sh')`)

Evidence: This constructs a path relative to the file's location. From a worktree at `.worktrees/<slug>/`, `__dirname` would be `.worktrees/<slug>/lib/commands/`, so `../../scripts/forge-team/index.sh` resolves to `.worktrees/<slug>/scripts/forge-team/index.sh`. If scripts/ is not copied into worktrees, this breaks.

Mitigation: Use the `projectRoot` parameter (passed by the registry dispatch) or resolve against the package installation root.

---

## RISK 12: No lint command exists yet -- adding it may collide with existing "lint" references

**Severity: LOW | Likelihood: MEDIUM**

Files affected:
- `package.json` script: `"lint": "eslint . --max-warnings 0"`
- `lib/commands/push.js` already calls lint internally via `runLint()`
- `lib/commands/validate.js` also runs lint

Evidence: A new `lib/commands/lint.js` with `name: 'lint'` would register via the registry. But `forge lint` might confuse users who expect it to behave exactly like `bun run lint`. Also, push.js and validate.js have their own lint logic -- the new lint command could diverge.

Mitigation: Decide if `forge lint` wraps `bun run lint` or has its own logic. If wrapping, ensure push.js and validate.js call the same shared function.

---

## RISK 13: Registry silently skips broken modules -- no user-visible feedback

**Severity: LOW | Likelihood: MEDIUM**

Files affected:
- `lib/commands/_registry.js` line 79: `mod = require(filePath)` inside try/catch
- Registry `loadCommands()` logs a warning but continues

Evidence: If a command module throws during `require()` (syntax error, missing dependency), the registry logs `warn: skipping <file>: <reason>` but the command simply doesn't appear. The user gets "Unknown command" instead of a helpful error about the broken module.

Mitigation: In development/debug mode, make registry errors fatal or at least print them prominently. Consider a `--verbose` flag that shows skipped modules.

---

## RISK 14: No process.on('SIGINT'/'SIGTERM') handlers anywhere

**Severity: LOW | Likelihood: LOW**

Files affected:
- All of `bin/forge.js`, `bin/forge-cmd.js`, `bin/forge-preflight.js`

Evidence: `grep -rn 'process.on(' ` returned empty results. There are no signal handlers. During long-running operations (setup, tests), Ctrl+C will leave partial state (half-written files, partial git operations). The readline `close` handler in setup (line ~2422) handles the readline case specifically but nothing else.

Mitigation: Low priority for this refactoring. Note as future improvement.

---

## Summary

| # | Risk | Sev | Like | Priority |
|---|------|-----|------|----------|
| 1 | recommend.js/team.js incompatible exports | HIGH | HIGH | P0 |
| 2 | Bogus name exports (dev='feature-a', status='Fresh Start') | HIGH | HIGH | P0 |
| 3 | branch-protection.js unconditional main() | HIGH | HIGH | P0 |
| 4 | dep-guard-analyze.js process.exit in main | MED | HIGH | P1 |
| 5 | bin/forge.js global mutable state extraction | HIGH | MED | P1 |
| 6 | Dual registry (forge-cmd.js vs forge.js) | MED | MED | P1 |
| 7 | process.exit in team.js library code | MED | MED | P1 |
| 8 | 20+ process.exit in forge.js functions to extract | MED | MED | P1 |
| 9 | Test imports use destructured exports | MED | MED | P1 |
| 10 | __dirname resolution changes when code moves | MED | MED | P1 |
| 11 | team.js worktree-incompatible path | LOW | MED | P2 |
| 12 | New lint command may collide | LOW | MED | P2 |
| 13 | Registry silently skips broken modules | LOW | MED | P2 |
| 14 | No SIGINT/SIGTERM handlers | LOW | LOW | P3 |
