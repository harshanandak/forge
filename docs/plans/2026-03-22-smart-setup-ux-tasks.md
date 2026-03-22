# Smart Setup UX — Task List

- **Epic**: forge-iv8b
- **Design**: [2026-03-22-smart-setup-ux-design.md](2026-03-22-smart-setup-ux-design.md)
- **Branch**: feat/smart-setup-ux

---

## Parallel Wave Structure

```
Wave 1 (independent):
  Task 1: Remove WORKFLOW.md + clean refs
  Task 2: Fix detectProjectStatus() feature gate
  Task 3: Lazy directory creation

Wave 2 (depends on Wave 1):
  Task 4: Agent auto-detection module

Wave 3 (depends on Wave 1):
  Task 5: Centralized action log
  Task 6: Content-hash file comparison utility

Wave 4 (depends on Waves 2, 3):
  Task 7: Incremental setup + --force flag
  Task 8: Clean summary output (progressive, from action log)

Wave 5 (independent):
  Task 9: Worktree detection utility

Wave 6 (final):
  Task 10: Smart-status.sh bug fix (already done — commit into branch)
  Task 11: Integration test + sync commands
```

**Dependency graph:**
```
T1 ──┐
T2 ──┤──> T7 ──> T8
T3 ──┘         /
T5 ──> T8 ────/
T6 ──> T7
T4 ──> T7
T9 (independent)
T10 (independent, already implemented)
T11 (depends on all)
```

---

## Task 1: Remove docs/WORKFLOW.md and clean all references

**File(s):** `docs/WORKFLOW.md`, `bin/forge.js`, `lib/agents-config.js`, `install.sh`, `AGENTS.md`, `README.md`, `QUICKSTART.md`, `DEVELOPMENT.md`, `docs/SETUP.md`, `docs/EXAMPLES.md`, `docs/ENHANCED_ONBOARDING.md`, `docs/VALIDATION.md`, `docs/ROADMAP.md`, `docs/AGENT_INSTALL_PROMPT.md`, `.cursorrules`, `test/stage-naming.test.js`, and all 7 agent command directories (rollback, premerge files)

**What to implement:**
1. Delete `docs/WORKFLOW.md`
2. In `bin/forge.js`:
   - Remove WORKFLOW.md copy logic (line ~1789)
   - Remove `hasDocsWorkflow` from `detectProjectStatus()` (line ~781)
   - Remove all `console.log` lines referencing WORKFLOW.md (lines ~2053, 2333, 3365, 3475)
3. In `lib/agents-config.js`: Remove WORKFLOW.md references from agent config templates (3 refs)
4. In `install.sh`: Remove curl download (line ~288), file list entry (line ~726), output message (line ~1052)
5. In all doc files: Replace `docs/WORKFLOW.md` links with `AGENTS.md` or remove the reference
6. In `.cursorrules`: Remove from directory tree and reference
7. In `test/stage-naming.test.js`: Remove WORKFLOW.md from test assertions (line ~40)
8. Run `node scripts/sync-commands.js` to sync all 7 agent directories

**TDD steps:**
1. Write test: `test/setup-workflow-removal.test.js` -- assert `docs/WORKFLOW.md` is NOT in the file copy list, assert no source file (excluding historical plans/changelogs) contains `docs/WORKFLOW.md` as a live reference
2. Run test: confirm it fails (WORKFLOW.md still exists and is referenced)
3. Implement: Delete file, clean all references
4. Run test: confirm it passes
5. Commit: `feat: remove docs/WORKFLOW.md and clean all references`

**Expected output:** grep for `WORKFLOW.md` in active files returns zero matches (historical plan/changelog files excluded)

---

## Task 2: Fix detectProjectStatus() feature gate

**File(s):** `bin/forge.js`

**What to implement:**
Update the project status detection at line ~814 that checks `status.hasDocsWorkflow` as part of the "fully set up" condition. Remove `hasDocsWorkflow` from the condition so removing WORKFLOW.md doesn't make projects appear as "partial setup."

**TDD steps:**
1. Write test: `test/detect-project-status.test.js` -- assert `detectProjectStatus()` returns correct status for a project without `docs/WORKFLOW.md` but with `AGENTS.md` and `.claude/commands/`
2. Run test: confirm it fails (current code requires hasDocsWorkflow)
3. Implement: Remove `hasDocsWorkflow` from the feature gate condition
4. Run test: confirm it passes
5. Commit: `fix: remove hasDocsWorkflow from project status feature gate`

**Expected output:** A project with AGENTS.md + .claude/commands/ (but no WORKFLOW.md) is detected as fully set up

---

## Task 3: Lazy directory creation

**File(s):** `bin/forge.js`

**What to implement:**
Remove the eager `ensureDir('docs/planning')` (line ~1784) and `ensureDir('docs/research')` (line ~1785) calls from `setupCoreDocs()`. These directories will be created on first use by `/plan` Phase 1 and Phase 2 respectively. Add a helper `ensureDirWithNote(dir, purpose)` that creates the directory and prints a one-time purpose note.

**TDD steps:**
1. Write test: `test/lazy-dirs.test.js` -- assert `setupCoreDocs()` does NOT create `docs/planning/` or `docs/research/`; assert `ensureDirWithNote()` creates dir and returns purpose message on first call, returns null on subsequent calls
2. Run test: confirm it fails (setupCoreDocs still creates dirs eagerly)
3. Implement: Remove eager ensureDir calls, add `ensureDirWithNote()` helper
4. Run test: confirm it passes
5. Commit: `feat: lazy directory creation -- docs/planning/ and docs/research/ on first use`

**Expected output:** After setup, `docs/planning/` and `docs/research/` do not exist. After `/plan`, they exist.

---

## Task 4: Agent auto-detection module

**File(s):** `lib/detect-agent.js` (new), `bin/forge.js`

**What to implement:**
Create `lib/detect-agent.js` with 4-layer detection:
- Layer 1: `AI_AGENT` env var (universal standard)
- Layer 2: Agent-specific env vars (`CLAUDECODE`/`CLAUDE_CODE`, `CURSOR_TRACE_ID`, `CODEX_SANDBOX`, `GEMINI_CLI`, `OPENCODE_CLIENT`, `AUGMENT_AGENT`, `COPILOT_MODEL`, `REPL_ID`)
- Layer 3: VSCode path parsing (`VSCODE_CODE_CACHE_PATH` for Cursor/Windsurf)
- Layer 4: Config file signatures (`.claude/settings.json`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.roo/rules/`, `.kilocode/`, etc.)

Returns `{ activeAgent, activeAgentSource, confidence, configuredAgents }`.

Wire into `bin/forge.js` `promptForAgentSelection()` to pre-select detected agent.

**TDD steps:**
1. Write test: `test/detect-agent.test.js` --
   - Assert `CLAUDE_CODE=1` env returns `{ activeAgent: 'claude', confidence: 'high' }`
   - Assert `CURSOR_TRACE_ID=xxx` env returns `{ activeAgent: 'cursor', confidence: 'high' }`
   - Assert `VSCODE_CODE_CACHE_PATH=.../Cursor/...` returns `{ activeAgent: 'cursor', confidence: 'medium' }`
   - Assert `.cursorrules` exists returns `{ configuredAgents: ['cursor'] }`
   - Assert no signals returns `{ activeAgent: null, configuredAgents: [] }`
   - Assert `AI_AGENT=my-custom-agent` returns `{ activeAgent: 'my-custom-agent', confidence: 'high' }`
   - Assert `TERM_PROGRAM=vscode` without cursor vars does NOT detect cursor
2. Run test: confirm it fails (module doesn't exist)
3. Implement: Create `lib/detect-agent.js` with all 4 layers
4. Run test: confirm it passes
5. Commit: `feat: add 4-layer agent auto-detection module`

**Expected output:** Running from Claude Code terminal returns "Detected: claude (env)" with high confidence

---

## Task 5: Centralized action log

**File(s):** `lib/setup-action-log.js` (new), `bin/forge.js`

**What to implement:**
Create a simple action log collector:
- `add(file, action, detail)` -- action: 'created' | 'skipped' | 'merged' | 'conflict' | 'removed'
- `getSummary()` -- returns grouped counts by action
- `getVerbose()` -- returns full list with file paths and details
- `getAgentSummary()` -- groups files by agent for the summary line

Wire into `bin/forge.js`: replace scattered `console.log('  Created: ...')` calls with `actionLog.add(file, 'created')`.

**TDD steps:**
1. Write test: `test/setup-action-log.test.js` -- assert `add()` collects entries, `getSummary()` returns grouped counts, `getVerbose()` returns full list with file paths
2. Run test: confirm it fails (module doesn't exist)
3. Implement: Create `lib/setup-action-log.js`
4. Run test: confirm it passes
5. Commit: `feat: add centralized setup action log`

**Expected output:** `getSummary()` returns `{ created: 4, skipped: 2, merged: 1 }` etc.

---

## Task 6: Content-hash file comparison utility

**File(s):** `lib/file-hash.js` (new)

**What to implement:**
Create a utility that compares an existing file's content hash with what would be generated:
- `contentHash(content)` -- returns SHA-256 hex digest
- `fileMatchesContent(filePath, newContent)` -- returns true if file exists and content matches

Uses Node.js built-in `crypto` module (no new dependencies).

**TDD steps:**
1. Write test: `test/file-hash.test.js` -- assert identical content returns true, different content returns false, non-existent file returns false
2. Run test: confirm it fails
3. Implement: Create `lib/file-hash.js`
4. Run test: confirm it passes
5. Commit: `feat: add content-hash file comparison utility`

**Expected output:** `fileMatchesContent('existing.md', sameContent)` returns `true`

---

## Task 7: Incremental setup with content-hash + --force flag

**File(s):** `bin/forge.js`

**What to implement:**
Modify the setup flow to use the smart tiered strategy:

1. Parse `--force` flag in argument handling
2. Before each file operation, check:
   - If `--force`: always overwrite, log action as 'force-created'
   - If file doesn't exist: create, log 'created'
   - If file exists and content-hash matches: skip silently, log 'skipped (identical)'
   - If file is agent-specific and exists: skip, log 'skipped (agent config)'
   - If file is shared with markers: replace between markers, log 'merged'
   - If file is shared without markers and differs: show diff info, log 'conflict'
   - If file is JSON config: key-merge, log 'merged'
3. Wire in `lib/file-hash.js` for content comparison
4. Wire in `lib/detect-agent.js` for pre-selecting agent
5. Wire in action log for all file operations

**TDD steps:**
1. Write test: `test/incremental-setup.test.js` --
   - Assert first run creates all files
   - Assert second run with identical files skips all (content-hash match)
   - Assert second run with different agent adds new files, skips existing
   - Assert `--force` overwrites existing files
   - Assert marker-based merge replaces only between markers
   - Assert JSON merge adds missing keys, preserves existing
   - Assert corrupted JSON warns and skips
2. Run test: confirm it fails
3. Implement: Modify setup flow with tiered strategy
4. Run test: confirm it passes
5. Commit: `feat: incremental setup with content-hash, markers, and --force flag`

**Expected output:** Running setup twice -- second run shows "Skipped: N files (identical)" instead of re-creating

---

## Task 8: Clean summary output (progressive)

**File(s):** `bin/forge.js`

**What to implement:**
Replace all scattered `console.log('  Created: ...')` calls in setup with action log collection. At end of setup, render summary from action log:

Default output (3 lines max):
```
Forge setup complete -- 2 agents configured (Claude Code, Cursor)
  Run forge setup --verbose to see all files
```

With `--verbose` flag, show file-by-file detail grouped by agent and action.

**TDD steps:**
1. Write test: `test/setup-summary.test.js` -- assert default output is <= 3 lines, assert `--verbose` includes file-by-file detail, assert output mentions detected agent and count
2. Run test: confirm it fails
3. Implement: Replace console.logs with action log, add summary renderer
4. Run test: confirm it passes
5. Commit: `feat: progressive setup summary -- minimal default, --verbose for detail`

**Expected output:** Clean one-line summary on default, full detail on --verbose

---

## Task 9: Worktree detection utility

**File(s):** `lib/detect-worktree.js` (new)

**What to implement:**
Create a utility to detect if the current directory is inside a git worktree. Uses `child_process.execFileSync` (not exec, to prevent command injection per OWASP A03):
- `detectWorktree()` -- returns `{ inWorktree: boolean, superproject?: string, branch?: string }`

Uses `git rev-parse --show-superproject-working-tree` and `git branch --show-current` via `execFileSync`.

This is used by `/plan` entry gate to avoid creating nested worktrees.

**TDD steps:**
1. Write test: `test/detect-worktree.test.js` -- assert returns `{ inWorktree: false }` when not in worktree; assert returns `{ inWorktree: true, branch }` when inside one (mock `execFileSync`)
2. Run test: confirm it fails
3. Implement: Create `lib/detect-worktree.js`
4. Run test: confirm it passes
5. Commit: `feat: add worktree detection utility`

**Expected output:** Inside `.worktrees/smart-setup-ux/` returns `{ inWorktree: true, branch: 'feat/smart-setup-ux' }`

---

## Task 10: Commit smart-status.sh bug fix

**File(s):** `scripts/smart-status.sh`

**What to implement:**
The jq date parsing bug is already fixed in the main repo. Cherry-pick or re-apply the fix to the worktree branch. The fix replaces fragile regex-based date stripping with `[:19] + "Z"` truncation for `fromdateiso8601`.

**TDD steps:**
1. Write test: `test/smart-status.test.js` -- assert smart-status.sh exits 0 with real beads data (no jq date parsing errors)
2. Run test: confirm it passes (fix already applied)
3. Commit: `fix: smart-status.sh jq date parsing for fractional seconds + timezone offsets`

**Expected output:** `bash scripts/smart-status.sh` runs without errors

---

## Task 11: Integration test + sync commands

**File(s):** `test/smart-setup-ux-integration.test.js` (new), all agent directories

**What to implement:**
1. Run `node scripts/sync-commands.js` to sync all 7 agent directories (any premerge/rollback changes from WORKFLOW.md removal)
2. Write integration test that validates the full setup flow end-to-end:
   - Fresh project setup: all files created, no WORKFLOW.md, clean summary
   - Re-run with same agent: all files skipped (identical)
   - Re-run with new agent: new files created, existing untouched
   - Agent detection with mocked env vars: correct agent pre-selected
3. Run full test suite to confirm no regressions

**TDD steps:**
1. Write test: `test/smart-setup-ux-integration.test.js`
2. Run test: confirm it passes
3. Run `node scripts/sync-commands.js` -- confirm all agent dirs in sync
4. Run full `bun test` -- confirm no new failures
5. Commit: `test: add integration tests for smart setup UX`

**Expected output:** All tests pass, `sync-commands.js --check` shows no drift
