# Task List: P2 Bug Fixes

**Design**: docs/plans/2026-03-20-p2-bug-fixes-design.md
**Branch**: feat/p2-bug-fixes
**Baseline**: 1676 pass, 0 fail, 31 skip (113 files)
**Beads**: forge-cpnj, forge-iv1p, forge-8u6q, forge-zs2u

---

## Parallel Wave Structure

```
Wave 1 (independent — can run in parallel):
  Task 1: forge-8u6q — Remove dead config
  Task 2: forge-zs2u — Fix lint.js

Wave 2 (depends on understanding bin/forge.js structure from Wave 1):
  Task 3: forge-iv1p — Remove postinstall + add first-run detection
  Task 4: forge-iv1p — Add --yes flag to setup command

Wave 3 (depends on Tasks 3-4):
  Task 5: forge-cpnj — Extract shared setup helper

Wave 4 (final):
  Task 6: Integration tests for all changes
```

---

## Task 1: Remove dead config objects (forge-8u6q)

**File(s)**: `bin/forge.js`
**What to implement**: Delete `_CODE_REVIEW_TOOLS` constant (line ~275) and `_CODE_QUALITY_TOOLS` constant (line ~295). Remove any comments referencing them. Grep for any remaining references and clean up.

**TDD steps**:
1. Write test: `test/dead-config-removal.test.js` — assert that bin/forge.js source does not contain `_CODE_REVIEW_TOOLS` or `_CODE_QUALITY_TOOLS` strings (except in test itself)
2. Run test: confirm it fails (strings still exist)
3. Implement: delete the two const blocks from bin/forge.js
4. Run test: confirm it passes
5. Commit: `fix: remove dead _CODE_REVIEW_TOOLS and _CODE_QUALITY_TOOLS config (forge-8u6q)`

**Expected output**: Test passes. No runtime errors. Existing tests still pass (1676).

---

## Task 2: Fix lint.js to use package manager delegation (forge-zs2u)

**File(s)**: `scripts/lint.js`
**What to implement**: Replace `npx --yes eslint . --max-warnings 0` with package manager detection (reuse pattern from `scripts/test.js`) + `<pkg> run lint`. Fail with clear error if package manager not found.

**TDD steps**:
1. Write test: `test/lint-script.test.js`
   - Assert: lint.js source does not contain `npx --yes`
   - Assert: lint.js contains `detectPackageManager` function
   - Assert: lint.js uses `run`, `lint` in its spawnSync args
   - Assert: lint.js has error handling for missing package manager
2. Run test: confirm it fails
3. Implement: rewrite scripts/lint.js
   - Copy `detectPackageManager()` from scripts/test.js
   - Replace spawnSync call: `spawnSync(pkgManager, ['run', 'lint'], ...)`
   - Update error messages to reference `<pkg> run lint`
4. Run test: confirm it passes
5. Commit: `fix: replace npx --yes with pkg-manager delegation in lint.js (forge-zs2u)`

**Expected output**: `scripts/lint.js` delegates to `bun run lint`. No network dependency. Same eslint binary and config as manual `bun run lint`.

---

## Task 3: Remove postinstall + add first-run detection (forge-iv1p)

**File(s)**: `package.json`, `bin/forge.js`
**What to implement**:
1. Remove `"postinstall": "node ./bin/forge.js"` line from package.json
2. Add first-run detection at CLI entry point in bin/forge.js: when any forge command runs (except `setup` and `--help`), check if AGENTS.md exists. If not, print `[FORGE_SETUP_REQUIRED]` message and exit with code 1.

**TDD steps**:
1. Write test: `test/postinstall-removal.test.js`
   - Assert: package.json does not contain `"postinstall"` key
   - Assert: bin/forge.js contains `FORGE_SETUP_REQUIRED` string
   - Assert: first-run check skips for `setup` and `--help` commands
2. Run test: confirm it fails
3. Implement:
   - Delete postinstall line from package.json
   - Add first-run detection function in bin/forge.js before command dispatch
   - Message format:
     ```
     [FORGE_SETUP_REQUIRED] Forge is not configured in this project.

       Run:  npx forge setup
       Or:   npx forge setup --yes  (non-interactive)
     ```
   - Exit with code 1
   - Skip check for: `setup`, `--help`, `-h`, `--version`, `-V`
4. Run test: confirm it passes
5. Commit: `fix: remove postinstall, add first-run detection (forge-iv1p)`

**Expected output**: `npm install` produces zero side effects. Running forge without setup prints clear guidance.

---

## Task 4: Add --yes / -y flag to setup command (forge-iv1p)

**File(s)**: `bin/forge.js`
**What to implement**: Parse `--yes` / `-y` flag in setup command argument handling. When present, skip all interactive prompts and use sensible defaults (claude as default agent). Explicit flags (e.g., `--agents cursor`) override --yes defaults.

**TDD steps**:
1. Write test: `test/setup-yes-flag.test.js`
   - Assert: bin/forge.js recognizes `--yes` and `-y` flags
   - Assert: --yes mode skips readline/prompt creation
   - Assert: --yes defaults to claude agent if no --agents specified
   - Assert: `--yes --agents cursor` uses cursor, not claude
2. Run test: confirm it fails
3. Implement:
   - Add `--yes` / `-y` to flag parsing in CLI entry point
   - When --yes is set: skip `readline.createInterface`, use default agent list
   - Precedence: explicit `--agents` > --yes defaults > interactive prompts
   - Same output in both modes — print choices made, skip prompt pauses
4. Run test: confirm it passes
5. Commit: `feat: add --yes/-y flag for non-interactive setup (forge-iv1p)`

**Expected output**: `npx forge setup --yes` runs full setup with no prompts. `npx forge setup --yes --agents cursor` sets up only cursor.

---

## Task 5: Extract shared setup helper (forge-cpnj)

**File(s)**: `bin/forge.js`
**What to implement**: Extract `executeSetup(config)` function that both `handleSetupCommand` and the interactive path call. Config object: `{ agents: string[], skipExternal: boolean, yes: boolean }`. The function: (1) calls setupCoreDocs(), (2) if claude in agents: uses loadAndSetupClaudeCommands (seeds + reads), (3) calls setupAgent for each selected agent, (4) optionally installs git hooks, (5) optionally handles external services.

**TDD steps**:
1. Write test: `test/setup-shared-helper.test.js`
   - Assert: bin/forge.js exports or contains `executeSetup` function
   - Assert: `handleSetupCommand` calls `executeSetup`
   - Assert: interactive path calls `executeSetup`
   - Assert: when agents includes 'claude', loadAndSetupClaudeCommands is called (not loadClaudeCommands)
   - Assert: when agents is ['cursor'] (no claude), setupAgent('cursor') is called without claude seeding
2. Run test: confirm it fails
3. Implement:
   - Create `executeSetup(config)` function
   - Refactor `handleSetupCommand` to: parse flags → build config → call executeSetup
   - Refactor interactive path to: collect prompts → build config → call executeSetup
   - Remove the `if (agentKey !== 'claude')` guard (line ~3734) — now handled by executeSetup
   - Use `loadAndSetupClaudeCommands` (not `loadClaudeCommands`) when claude is in agents
4. Run test: confirm it passes
5. Commit: `fix: extract shared executeSetup helper, fix claude agent skipping (forge-cpnj)`

**Expected output**: `forge setup --agents claude,cursor` and interactive setup produce identical file sets. Claude is no longer skipped in CLI path.

---

## Task 6: Integration tests

**File(s)**: `test/p2-integration.test.js`
**What to implement**: End-to-end verification that all 4 fixes work together. Tests run in isolated temp directories.

**TDD steps**:
1. Write test: `test/p2-integration.test.js`
   - Assert: no `_CODE_REVIEW_TOOLS` or `_CODE_QUALITY_TOOLS` in bin/forge.js
   - Assert: no `npx --yes` in scripts/lint.js
   - Assert: no `"postinstall"` in package.json
   - Assert: scripts/lint.js contains detectPackageManager
   - Assert: bin/forge.js contains FORGE_SETUP_REQUIRED
   - Assert: bin/forge.js contains `--yes` flag handling
   - Assert: bin/forge.js contains executeSetup function
   - Assert: all 1676+ baseline tests still pass (run bun test, check exit code)
2. Run test: confirm it passes (all changes already implemented)
3. Commit: `test: add integration tests for p2 bug fixes`

**Expected output**: All assertions pass. Baseline test count >= 1676.
