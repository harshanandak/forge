# Task List: Agent Command Parity — Cleanup & Completion

- **Feature**: agent-command-parity-v2
- **Date**: 2026-03-15
- **Beads**: forge-2w3
- **Branch**: feat/agent-command-parity
- **Worktree**: .worktrees/agent-command-parity
- **Design doc**: docs/plans/2026-03-15-agent-command-parity-v2-design.md

---

## Task 1: Delete dropped-agent files

**File(s)**:
- `.aider.conf.yml` (git rm)
- `lib/agents/continue.plugin.json` (git rm)
- `docs/research/agent-instructions-sync.md` (git rm)
- `docs/README-v1.3.md` (git rm)
- `.agent/` (rm -rf, untracked)
- `.agents/` (rm -rf, untracked)

**What to implement**: Remove all files that are entirely about dropped agents. Git-tracked files use `git rm`. Untracked/gitignored directories use `rm -rf`.

**TDD steps**:
1. Write test: `test/cleanup/dropped-agent-files.test.js` — assert none of these files/dirs exist
2. Run test: fails (files still exist)
3. Implement: `git rm` tracked files, `rm -rf` untracked dirs
4. Run test: passes
5. Commit: `fix: remove dropped-agent files — aider config, continue plugin, stale research docs`

**Expected output**: All 6 paths gone.

---

## Task 2: Remove dropped-agent code from packages/skills

**File(s)**:
- `packages/skills/src/lib/agents.js` — remove aider, antigravity, continue, windsurf entries
- `packages/skills/src/commands/sync.js` — remove Aider updateAiderConfig(), fix help text
- `packages/skills/test/agents.test.js` — remove Aider/Continue detection tests
- `packages/skills/test/sync.test.js` — remove Aider sync test

**What to implement**: Remove all code paths, agent entries, and tests for the 4 dropped agents from the skills package.

**TDD steps**:
1. Write test: `test/cleanup/dropped-agent-code.test.js` — grep these files for dropped agent names, assert zero matches
2. Run test: fails (references still exist)
3. Implement: edit all 4 files
4. Run test: passes
5. Run existing test suite: `bun test` — verify no regressions
6. Commit: `fix: remove dropped-agent code from skills package — aider, antigravity, continue, windsurf`

**Expected output**: No dropped-agent names in skills package source or tests.

---

## Task 3: Remove dropped-agent code from bin/forge.js and lib/

**File(s)**:
- `bin/forge.js` — remove Continue setup function (~40 lines), continueFormat references
- `bin/forge-cmd.js` — remove "OpenSpec" from plan description
- `lib/project-discovery.js` — remove Aider detection logic

**What to implement**: Remove all dead code paths for dropped agents from the CLI and lib modules.

**TDD steps**:
1. Write test: `test/cleanup/dropped-agent-cli.test.js` — grep these files for dropped agent names, assert zero matches (excluding comments about removal)
2. Run test: fails
3. Implement: edit all 3 files
4. Run test: passes
5. Run `bun test` — verify no regressions
6. Commit: `fix: remove dropped-agent code from CLI — continue setup, aider detection, openspec ref`

**Expected output**: No dropped-agent function calls in CLI code.

---

## Task 4: Clean dropped-agent references from docs

**File(s)**:
- `docs/EXAMPLES.md` — delete Example 4 (OpenSpec-based), fix `/research` → `/plan` in examples 1,2,3,5
- `docs/TOOLCHAIN.md` — remove Windsurf mention, Continue MCP setup
- `docs/AGENT_INSTALL_PROMPT.md` — remove Continue detection
- `docs/research/agent-permissions.md` — remove Antigravity/Aider rows from tables
- `docs/research/dependency-chain.md` — fix 1 Continue reference
- `docs/research/test-environment.md` — fix 1 Continue reference
- `lib/agents/README.md` — remove Windsurf, Antigravity, Aider rows

**What to implement**: Fix each doc per the design doc rules — delete sections that are fundamentally about dropped agents, fix minor references in docs that are otherwise valid.

**TDD steps**:
1. Write test: `test/cleanup/dropped-agent-docs.test.js` — grep all doc files for dropped agent names, assert zero matches (allow historical mentions in design docs and CHANGELOG)
2. Run test: fails
3. Implement: edit all files
4. Run test: passes
5. Commit: `docs: remove dropped-agent references from docs — antigravity, windsurf, aider, continue`

**Expected output**: No misleading dropped-agent references in active docs.

---

## Task 5: Clean package.json, CLAUDE.md, QUICKSTART.md, .gitignore, .forge/

**File(s)**:
- `package.json` — description: "7-stage" + 8 agents only, remove dropped keywords
- `CLAUDE.md` — remove Continue MCP reference
- `QUICKSTART.md` — remove Windsurf from examples
- `.gitignore` — remove `.agents/`, `.agent/`, `.aider/skills/`, `.continue/skills/`, `.windsurf/skills/`
- `.forge/pr-body.md` — remove Aider, Antigravity references
- `test-env/validation/agent-validator.test.js` — remove aider from list

**What to implement**: Fix all remaining config and metadata files.

**TDD steps**:
1. Write test: `test/cleanup/dropped-agent-config.test.js` — assert package.json description says "7-stage", keywords don't include dropped agents, .gitignore doesn't have dropped entries
2. Run test: fails
3. Implement: edit all files
4. Run test: passes
5. Commit: `fix: clean dropped-agent refs from package.json, gitignore, quickstart, config`

**Expected output**: All metadata accurate. `bun test` passes.

---

## Task 6: Fix plugin catalog capability flags

**File(s)**:
- `lib/agents/cursor.plugin.json` — `commands: true`, add `"commands": ".cursor/commands"` to directories
- `lib/agents/cline.plugin.json` — `commands: true`, add `"workflows": ".clinerules/workflows"` to directories
- `lib/agents/copilot.plugin.json` — `commands: true`
- `lib/agents/kilocode.plugin.json` — `commands: true`
- `lib/agents/codex.plugin.json` — `commands: true`, add `"skills": ".codex/skills"` to directories
- `lib/agents/claude.plugin.json` — `hooks: true`

**What to implement**: Update each plugin.json to reflect actual capabilities. These flags affect `forge setup` output.

**TDD steps**:
1. Write test: `test/cleanup/plugin-catalog.test.js` — assert each supported agent has `commands: true`, correct directories, no `continue` plugin exists
2. Run test: fails
3. Implement: edit 6 plugin.json files
4. Run test: passes
5. Run `bun test` — verify no regressions (existing plugin tests may need updates)
6. Commit: `fix: update plugin catalog — correct capability flags for all 8 supported agents`

**Expected output**: All 8 plugins have accurate capability flags.

---

## Task 7: Build `forge check-agents` CLI command

**File(s)**:
- `scripts/check-agents.js` (new) — delegates to `sync-commands.js --check` + validates plugin catalog
- `test/scripts/check-agents.test.js` (new)

**What to implement**: CLI command that:
1. Runs `syncCommands({ check: true })` to verify all agent command files are in sync
2. Reads `lib/agents/*.plugin.json` to verify each agent with `commands: true` has its command directory populated
3. Reports: missing files, out-of-sync files, stale files
4. Exits 0 if all clean, non-zero if issues found

Keep it simple — reuse the existing sync infrastructure rather than reimplementing file checks.

**TDD steps**:
1. Write test: `test/scripts/check-agents.test.js` — happy path (all files present → exit 0), missing file (→ exit non-zero), stale file detection
2. Run test: fails (file doesn't exist)
3. Implement: `scripts/check-agents.js`
4. Run test: passes
5. Run manually: `node scripts/check-agents.js` → "All agent command files are in sync."
6. Commit: `feat: add forge check-agents CLI — validates agent configs are complete and in sync`

**Expected output**: `node scripts/check-agents.js` exits 0 on current repo.

---

## Task 8: Integration validation + design doc update

**File(s)**: No new files.

**What to implement**:
1. Run full test suite: `bun test` — all pass
2. Run `node scripts/sync-commands.js --check` — in sync
3. Run `node scripts/check-agents.js` — all clean
4. Grep entire codebase for dropped agent names — zero hits in active code/docs
5. Update design doc status: "Active" → "Complete"
6. Update original design doc (2026-03-04) status: "Draft" → "Superseded by 2026-03-15-agent-command-parity-v2-design.md"

**TDD steps**:
1. Run all checks listed above
2. Verify each passes
3. Commit: `docs: mark agent-command-parity design docs as complete`

**Expected output**: All green. forge-2w3 ready to close after merge.

---

## Ordering Summary

| # | Task | Blocks | Parallelizable |
|---|------|--------|----------------|
| 1 | Delete dropped-agent files | — | Yes (with 2-5) |
| 2 | Remove dropped code from skills package | — | Yes (with 1,3-5) |
| 3 | Remove dropped code from CLI/lib | — | Yes (with 1,2,4,5) |
| 4 | Clean docs | — | Yes (with 1-3,5) |
| 5 | Clean config/metadata | — | Yes (with 1-4) |
| 6 | Fix plugin catalog | — | Yes (with 1-5) |
| 7 | Build check-agents CLI | 6 (reads plugin catalog) | After task 6 |
| 8 | Integration validation | All above | Last |

Tasks 1-6 are independent and can be parallelized.
Task 7 depends on task 6 (needs correct plugin catalog).
Task 8 is the final integration check.
