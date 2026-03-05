# Task List: forge-uto — Agent Config Cleanup + Codex CLI

- **Feature**: forge-uto
- **Date**: 2026-03-05
- **Design doc**: docs/plans/2026-03-05-forge-uto-design.md
- **Beads**: forge-uto

---

## Task 1: Remove Antigravity plugin + files
**File(s)**:
- `lib/agents/antigravity.plugin.json` (delete)
- `GEMINI.md` (delete)
- `.agent/` directory (delete)

**What to implement**:
Delete the Antigravity plugin JSON, the GEMINI.md root config, and the entire `.agent/` directory tree. These contain Antigravity-specific workflows, rules, and skills that are no longer supported.

**TDD steps**:
1. Write test in `test/agent-detection.test.js`: assert that `lib/agents/antigravity.plugin.json` does not exist (file system check) and that loading the plugin list does not include `antigravity`
2. Run test: confirm it fails — plugin file exists
3. Delete `lib/agents/antigravity.plugin.json`, `GEMINI.md`, `.agent/`
4. Run test: confirm it passes
5. Commit: `feat: remove Antigravity plugin and files`

**Expected output**: No Antigravity plugin file, no GEMINI.md, no `.agent/` directory.

---

## Task 2: Remove Windsurf plugin + files
**File(s)**:
- `lib/agents/windsurf.plugin.json` (delete)
- `.windsurfrules` (delete)
- `.windsurf/` directory (delete)

**What to implement**:
Delete the Windsurf plugin JSON, the `.windsurfrules` root config file, and the `.windsurf/` directory. Windsurf has been deprecated in favour of Antigravity (now also dropped).

**TDD steps**:
1. Write test: assert `lib/agents/windsurf.plugin.json` does not exist and plugin list does not include `windsurf`
2. Run test: confirm it fails — plugin file exists
3. Delete `lib/agents/windsurf.plugin.json`, `.windsurfrules`, `.windsurf/`
4. Run test: confirm it passes
5. Commit: `feat: remove Windsurf plugin and files`

**Expected output**: No Windsurf plugin file, no `.windsurfrules`, no `.windsurf/` directory.

---

## Task 3: Remove Aider plugin + setup logic from bin/forge.js
**File(s)**:
- `lib/agents/aider.plugin.json` (delete)
- `bin/forge.js` (remove `setupAiderAgent()` function at ~line 1938 and `customSetup === 'aider'` branch at ~line 2100)
- `test/other-agents-config-generation.test.js` (remove Aider tests)
- `test/agent-detection.test.js` (remove Aider detection tests)

**What to implement**:
Delete the Aider plugin JSON. Remove `setupAiderAgent()` function definition from `bin/forge.js`. Remove the `if (agent.customSetup === 'aider') { setupAiderAgent(); }` branch. Remove all Aider tests from test files.

**TDD steps**:
1. Write test: assert `lib/agents/aider.plugin.json` does not exist and setup flow never creates `.aider.conf.yml`
2. Run test: confirm it fails — plugin and setup logic exist
3. Delete plugin file; remove function + call site from `bin/forge.js`; remove Aider tests
4. Run test + `bun run lint`: confirm passes with 0 ESLint warnings
5. Commit: `feat: drop Aider support — remove plugin and setup logic`

**Expected output**: No Aider plugin, no `.aider.conf.yml` created, no Aider references in setup flow.

---

## Task 4: Remove OpenSpec from bin/forge.js
**File(s)**:
- `bin/forge.js` (remove 4 functions + all call sites)

**What to implement**:
Remove these 4 functions entirely from `bin/forge.js`:
- `checkForOpenSpec()` (~line 2972)
- `isOpenSpecInitialized()` (~line 3011)
- `initializeOpenSpec()` (~line 3038)
- `promptOpenSpecSetup()` (~line 3244)

Also remove all call sites:
- `openspecInstallType: checkForOpenSpec()` in project status object (~line 811)
- `hasOpenSpec: isOpenSpecInitialized()` (~line 808)
- OpenSpec status display block (~lines 2485–2491)
- `await promptOpenSpecSetup(question)` (~line 3438)
- `const openspecStatus = checkForOpenSpec()` + `if (openspecStatus && !isOpenSpecInitialized())` block (~lines 3524–3529)
- Stage listing line: `| 3 | \`/plan\` | Create implementation plan, branch, OpenSpec if strategic |` (~line 442) — update to remove OpenSpec mention

**TDD steps**:
1. Write test: `grep` the compiled/source `bin/forge.js` and assert strings `promptOpenSpecSetup`, `checkForOpenSpec`, `initializeOpenSpec`, `isOpenSpecInitialized` are absent
2. Run test: confirm it fails — functions exist
3. Remove all 4 functions and call sites from `bin/forge.js`
4. Run test + `bun run lint`: 0 errors, 0 warnings
5. Commit: `feat: remove OpenSpec from setup CLI`

**Expected output**: `bin/forge.js` has no OpenSpec logic. `bun run lint` passes clean.

---

## Task 5: Update 9-stage → 7-stage listing in bin/forge.js
**File(s)**:
- `bin/forge.js` (~line 418 and surrounding stage table)

**What to implement**:
Find the description string `"9-stage TDD-first workflow"` at ~line 418 and any inline stage listing table that shows 9 stages (including the old `/research` stage). Update to say `"7-stage TDD-first workflow"` and align the stage table with the current 7 stages: `/plan`, `/dev`, `/validate`, `/ship`, `/review`, `/premerge`, `/verify`.

**TDD steps**:
1. Write test: parse `bin/forge.js` source and assert the string `9-stage` is absent and `7-stage` is present
2. Run test: confirm it fails — `9-stage` string exists
3. Update the description string and stage table
4. Run test: confirm passes
5. Commit: `docs: update stage count from 9 to 7 in forge setup description`

**Expected output**: `bin/forge.js` says `7-stage`, stage table matches current workflow.

---

## Task 6: Add Codex CLI plugin
**File(s)**:
- `lib/agents/codex.plugin.json` (create)

**What to implement**:
Create a new plugin JSON for Codex CLI following the established schema. Codex uses `AGENTS.md` for instructions (already installed by forge setup — no extra step needed) and `.codex/config.toml` for tool config.

Plugin JSON structure:
```json
{
  "id": "codex",
  "name": "OpenAI Codex CLI",
  "version": "1.0.0",
  "description": "OpenAI's terminal coding agent",
  "homepage": "https://github.com/openai/codex",
  "capabilities": {
    "commands": false,
    "skills": false,
    "hooks": false
  },
  "directories": {},
  "files": {
    "rootConfig": "AGENTS.md"
  },
  "setup": {
    "copyRules": false,
    "createSkill": false
  }
}
```

**TDD steps**:
1. Write test: assert `lib/agents/codex.plugin.json` exists and parses as valid JSON with `id === "codex"` and `files.rootConfig === "AGENTS.md"`
2. Run test: confirm it fails — file does not exist
3. Create `lib/agents/codex.plugin.json`
4. Run test: confirm passes
5. Commit: `feat: add Codex CLI agent plugin`

**Expected output**: `lib/agents/codex.plugin.json` exists with correct schema.

---

## Task 7: Fix OpenCode plugin homepage URL
**File(s)**:
- `lib/agents/opencode.plugin.json`

**What to implement**:
Fix the incorrect `homepage` field. Current value: `"https://github.com/opencode"` (does not exist). Correct value: `"https://opencode.ai"`.

**TDD steps**:
1. Write test: parse `lib/agents/opencode.plugin.json` and assert `homepage` does not contain `github.com/opencode` and equals `https://opencode.ai`
2. Run test: confirm it fails — wrong URL exists
3. Update the `homepage` field in `lib/agents/opencode.plugin.json`
4. Run test: confirm passes
5. Commit: `fix: correct OpenCode plugin homepage URL`

**Expected output**: `lib/agents/opencode.plugin.json` has `homepage: "https://opencode.ai"`.

---

## Task 8: Make CLAUDE.md a symlink to AGENTS.md in setup flow
**File(s)**:
- `bin/forge.js` (modify `_createClaudeReference()` → replace write with symlink, handle EPERM gracefully)

**What to implement**:
The function `_createClaudeReference()` at ~line 1486 currently writes a stub text file. Replace it with symlink creation:
1. Use `fs.symlinkSync('AGENTS.md', destPath)` (relative target, so symlink points to sibling AGENTS.md)
2. Catch `EPERM` (Windows without Developer Mode) — fall back to writing the stub with a console warning
3. Remove `@private - Currently unused` comment — this function should now be wired into the active setup flow

Also wire it: where `createClaudeMd: true` is set in `createInstructionFilesResult` flows, ensure `_createClaudeReference()` (renamed to `createClaudeSymlink()`) is called rather than creating a full copy.

**TDD steps**:
1. Write test: mock `fs.symlinkSync` to succeed → assert `createClaudeSymlink(destPath)` calls `symlinkSync('AGENTS.md', destPath)`; second test: mock `symlinkSync` to throw `EPERM` → assert fallback stub file is written and warning is logged
2. Run tests: confirm they fail — function doesn't exist yet
3. Rename `_createClaudeReference` to `createClaudeSymlink`, replace body, add EPERM catch
4. Run tests: confirm passes
5. Commit: `feat: CLAUDE.md created as symlink to AGENTS.md`

**Expected output**: On supported filesystems, `CLAUDE.md` is a symlink pointing to `AGENTS.md`. On EPERM, a redirect stub is written with a warning.

---

## Task 9: Clean up doc references (clinerules, windsurfrules, SETUP.md)
**File(s)**:
- `.clinerules` (remove Antigravity row, Windsurf row, Aider row from agent table; remove GEMINI.md, `.agent/`, `.windsurf/` from directory tree)
- `.windsurfrules` — **delete entirely** (Windsurf dropped)
- `docs/SETUP.md` (remove `### Google Antigravity`, `### Windsurf`, Aider mention in `### Kilo Code, OpenCode...` heading; remove directory tree entries)
- `docs/TOOLCHAIN.md` if it has Antigravity/Windsurf/Aider references

**What to implement**:
Pure doc cleanup — remove all references to dropped agents from rule files and documentation. Update agent support tables to reflect current supported agents only.

**TDD steps**:
1. Write test: `grep` `.clinerules` and `docs/SETUP.md` for strings `Antigravity`, `Windsurf`, `GEMINI.md`, `aider` — assert none found
2. Run test: confirm fails — references exist
3. Edit all files to remove dropped agent references
4. Run test: confirm passes
5. Commit: `docs: remove Antigravity, Windsurf, Aider references from docs`

**Expected output**: No dropped agent references in any doc file. `.windsurfrules` deleted.

---

## Task 10: Update tests — remove deleted agent test coverage, add Codex test
**File(s)**:
- `test/agent-detection.test.js`
- `test/other-agents-config-generation.test.js`
- `test/cli/forge.test.js`
- `test/cross-platform-install.test.js`
- `test/e2e/setup-workflow.test.js`

**What to implement**:
- Remove any remaining test cases that reference Antigravity, Windsurf, or Aider (Tasks 1–3 may have done this partially — verify none remain)
- Remove any `openspec`-related test cases
- Add a test that `lib/agents/codex.plugin.json` loads correctly in the plugin registry
- Verify `bun test` reports 0 failures

**TDD steps**:
1. Write test: load all plugin JSONs from `lib/agents/` — assert `codex` is present, `antigravity`/`windsurf`/`aider` are absent
2. Run test: confirm it fails — codex missing, others present
3. Clean up remaining stale tests across all affected files
4. Run `bun test`: 0 failures
5. Commit: `test: update agent test suite for removed and added agents`

**Expected output**: `bun test` passes with 0 failures. No stale tests for dropped agents.
