## Plan Summary

- **Feature:** `windows-worktree-hooks-health`
- **Design doc:** `docs/plans/2026-04-25-windows-worktree-hooks-health-design.md`
- **Execution model:** sequential TDD tasks with isolated file ownership per task.
- **YAGNI check:** each task maps directly to stated success criteria and reported user impact.

## Task 1: Reproduce Windows/worktree false negatives in tests

**File(s):** `test/runtime-health.test.js`  
**OWNS:** `test/runtime-health.test.js`

**What to implement:** Add explicit regression coverage for worktree-valid hook states that currently fail due to `core.hooksPath`-only validation and for Lefthook binary-resolution edge cases.

**TDD steps:**
1. **Write test:** add failing tests for:
   - unset/empty `core.hooksPath` + valid resolved hooks dir,
   - `git config` failure + fallback resolution success,
   - Windows path variant with worktree-style hooks location.
2. **Run test:** confirm failures show current false-negative behavior (`HOOKS_NOT_ACTIVE` and/or `LEFTHOOK_MISSING`).
3. **Implement:** no production code changes in this task.
4. **Run test:** confirm new tests fail for expected reasons while existing tests stay stable.
5. **Commit:** `test: add windows worktree runtime-health regressions`

**Expected output:** Deterministic failing tests that capture the bug report’s runtime-health failure modes.

---

## Task 2: Implement layered hook verification in runtime health

**File(s):** `lib/runtime-health.js`, `test/runtime-health.test.js`  
**OWNS:** `lib/runtime-health.js`, `test/runtime-health.test.js`

**What to implement:** Extend `checkHookInstallation()` to validate effective hook activation beyond `core.hooksPath` by using Git-resolved hooks directory and file-based hook presence checks, with structured states/messages.

**TDD steps:**
1. **Write test:** add assertions for active fallback states and precise diagnostics.
2. **Run test:** confirm failures before implementation.
3. **Implement:**
   - add helper(s) to resolve hooks dir (`git rev-parse --git-path hooks`),
   - verify required hook files (`pre-commit`, `pre-push`) exist in resolved location,
   - return richer `state/message` values consumed by diagnostics.
4. **Run test:** confirm all runtime-health tests pass, including new regressions.
5. **Commit:** `fix: validate effective hook state in worktrees`

**Expected output:** Valid Windows worktree repos are recognized as hook-active even without explicit `.lefthook/hooks` config.

---

## Task 3: Harden Lefthook installation detection for worktree toolchains

**File(s):** `lib/lefthook-check.js`, `lib/runtime-health.js`, `test/runtime-health.test.js`  
**OWNS:** `lib/lefthook-check.js`, `lib/runtime-health.js`, `test/runtime-health.test.js`

**What to implement:** Improve Lefthook health logic to avoid false `LEFTHOOK_MISSING` when Lefthook is available through valid execution paths in Windows/worktree setups.

**TDD steps:**
1. **Write test:** add failing cases for declared dependency + executable Lefthook via command probe despite atypical `.bin` layout.
2. **Run test:** confirm current implementation flags `missing-binary` incorrectly.
3. **Implement:** add cautious executable probing fallback while preserving strict `missing-dependency` behavior.
4. **Run test:** confirm corrected Lefthook state behavior and no regression of true missing cases.
5. **Commit:** `fix: improve lefthook detection for worktree environments`

**Expected output:** Runtime health only reports `LEFTHOOK_MISSING` for real missing installs, not valid worktree environments.

---

## Task 4: Remove command-registry warning noise for recommend/team

**File(s):** `lib/commands/recommend.js`, `lib/commands/team.js`, `test/commands/_registry.test.js` (or nearest registry coverage file)  
**OWNS:** `lib/commands/recommend.js`, `lib/commands/team.js`, `test/commands/_registry.test.js`

**What to implement:** Export standard command metadata (`name`, `description`, `handler`) for `recommend` and `team` so startup diagnostics no longer emit irrelevant warning noise.

**TDD steps:**
1. **Write test:** add/extend registry-loading test asserting these commands are accepted and no invalid-export warning is emitted.
2. **Run test:** confirm failure with current exports.
3. **Implement:** wrap existing handlers with registry-compatible exports.
4. **Run test:** confirm registry tests pass and warnings are removed.
5. **Commit:** `fix: register recommend and team command metadata`

**Expected output:** `forge ready` output is cleaner, improving trust in runtime prerequisite diagnostics.

---

## Validation focus for `/dev`

- Prioritize `test/runtime-health.test.js` and stage-enforcement contract checks.
- Add targeted tests for new helper logic instead of broad integration-only coverage.
- Re-run command-registry tests after Task 4 to ensure no command-loading regressions.
