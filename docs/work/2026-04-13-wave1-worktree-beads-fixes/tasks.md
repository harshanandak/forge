## Plan Summary

- **Feature:** `wave1-worktree-beads-fixes`
- **Branch:** `feat/wave1-worktree-beads-fixes`
- **Worktree:** `C:\Users\harsha_befach\Downloads\forge\.worktrees\wave1-worktree-beads-fixes`
- **Execution model:** one feature branch, three sequential bug-fix commits
- **YAGNI check:** no tasks were flagged as scope creep; each task maps directly to one requested bug and the verified current code paths.

## Task 1: Bootstrap Beads for external worktrees (`forge-epkw`)

**File(s):** `lib/beads-bootstrap.js`, `lib/commands/worktree.js`, `lib/beads-health-check.js`, `test/commands/worktree.test.js`, `test/beads-health-check.test.js`  
**OWNS:** `lib/beads-bootstrap.js`, `lib/commands/worktree.js`, `lib/beads-health-check.js`, `test/commands/worktree.test.js`, `test/beads-health-check.test.js`

**What to implement:** Extract the current worktree-local `.beads` linking behavior into a new internal helper that can detect missing or unusable Beads state in external worktrees and attempt three-tier recovery: shared `.beads` link first, backup restore second, fresh init with warning last. Wire the helper into the existing Forge-owned worktree/bootstrap and health-check flow without introducing any new public wrapper/API layer.

**TDD steps:**
1. **Write test:** add cases in `test/commands/worktree.test.js` and `test/beads-health-check.test.js` for external worktrees with missing `.beads`, `EPERM` symlink failure, backup-restore fallback, and fresh-init warning behavior.
2. **Run test:** confirm the new cases fail because no shared bootstrap helper exists and the current health check does not recover worktree state.
3. **Implement:** add `lib/beads-bootstrap.js`, migrate `setupBeads()` usage in `lib/commands/worktree.js`, and extend `lib/beads-health-check.js` to consume the helper for Forge-owned recovery checks.
4. **Run test:** confirm the targeted worktree/bootstrap tests pass.
5. **Commit:** `fix: bootstrap beads for external worktrees`

**Expected output:** Forge-owned worktree recovery paths repair a missing external-worktree `.beads` state with explicit tiered warnings instead of failing immediately.

## Task 2: Restore worktree `lefthook` safety (`forge-ujq.2`)

**File(s):** `lib/commands/setup.js`, `test/setup-lefthook-repair.test.js`, `test/runtime-health.test.js`  
**OWNS:** `lib/commands/setup.js`, `test/setup-lefthook-repair.test.js`, `test/runtime-health.test.js`

**What to implement:** Harden the setup/runtime repair path so a worktree with a declared `lefthook` dependency but missing local binary is treated as a recoverable safety failure. The implementation should repair the binary in the worktree-local environment when possible, preserve hook restoration behavior, and emit a hard actionable warning when auto-repair is not possible.

**TDD steps:**
1. **Write test:** extend `test/setup-lefthook-repair.test.js` and `test/runtime-health.test.js` for a worktree-local project that has `lefthook` declared but missing in `node_modules/.bin`, including a case where repair is impossible and must warn.
2. **Run test:** confirm the new cases fail because the current setup/runtime path does not fully enforce worktree-local `lefthook` recovery semantics for this scenario.
3. **Implement:** update `lib/commands/setup.js` to verify and repair `lefthook` in the worktree-local context while preserving existing hook snapshot/restore behavior.
4. **Run test:** confirm the targeted `lefthook` repair and runtime-health tests pass.
5. **Commit:** `fix: restore lefthook safety in worktrees`

**Expected output:** A worktree with missing `lefthook` no longer silently loses pre-push safety; Forge repair paths either restore the binary or emit an explicit warning.

## Task 3: Read Beads recovery identity from metadata (`forge-9ats`)

**File(s):** `lib/beads-setup.js`, `scripts/smart-status.sh`, `test/beads-setup.test.js`, `test/scripts/smart-status.test.js`  
**OWNS:** `lib/beads-setup.js`, `scripts/smart-status.sh`, `test/beads-setup.test.js`, `test/scripts/smart-status.test.js`

**What to implement:** Add metadata-driven recovery helpers that read `.beads/metadata.json` and prefer `dolt_database` over basename-derived inference. Apply the logic to the existing JS recovery helpers and to `scripts/smart-status.sh` so auto-recovery uses configured metadata first and only falls back through explicit, conservative rules when metadata is missing or malformed.

**TDD steps:**
1. **Write test:** add JS and shell-level cases proving recovery reads `dolt_database` from `.beads/metadata.json`, ignores mismatched folder basenames, and handles missing/malformed metadata with an explicit fallback path.
2. **Run test:** confirm the new cases fail because current recovery still depends on basename inference.
3. **Implement:** add metadata readers in `lib/beads-setup.js` and update `scripts/smart-status.sh` recovery to consume the metadata-derived value.
4. **Run test:** confirm the targeted metadata/recovery tests pass.
5. **Commit:** `fix: read beads database from metadata during recovery`

**Expected output:** Recovery behavior matches the configured Beads metadata even when the worktree folder name does not match the real database name.

## Validation Focus For `/dev`

- Run the targeted test files for each task before and after implementation.
- Re-run the four baseline suites after Task 3.
- Watch for overlap with the parallel wrapper track and keep changes internal-only.
