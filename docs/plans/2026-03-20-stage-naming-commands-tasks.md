# Task List: Stage Naming Consistency + COMMANDS Array Fix

## Task 1: Replace hardcoded COMMANDS with filesystem-derived list

**File(s):** `bin/forge.js`
**What to implement:** Replace `const COMMANDS = ['status', ...]` (L254) with a function `getWorkflowCommands()` that reads `.claude/commands/*.md` and returns command names (filenames without `.md`). Update all 3 usage sites (L1884, L2305, L3509) to call this function. Add a warning when the directory doesn't exist.

**TDD steps:**
1. Write test: `test/forge-commands.test.js` — assert `getWorkflowCommands()` returns array matching `.claude/commands/*.md` filenames
2. Write test: assert missing directory returns empty array + prints warning
3. Write test: assert non-.md files are filtered out
4. Run tests: confirm they fail (function doesn't exist)
5. Implement: `getWorkflowCommands()` function using `fs.readdirSync` + `.filter(f => f.endsWith('.md'))` + `.map(f => f.replace('.md', ''))`
6. Run tests: confirm they pass
7. Commit: `feat: derive workflow commands from filesystem`

## Task 2: Fix stale stage names in CURSOR_RULE string

**File(s):** `bin/forge.js`
**What to implement:** In the CURSOR_RULE template string:
- L476: `/check` -> `/validate`
- L479: `/merge` -> `/premerge`
- Also fix the numbering (8 stages listed but should be 7 + utility)

**TDD steps:**
1. Write test: `test/forge-commands.test.js` — read `bin/forge.js` as string, assert no `/check` as stage name in CURSOR_RULE area
2. Write test: assert no `/merge` as stage name in CURSOR_RULE area
3. Run tests: confirm they fail
4. Implement: edit the CURSOR_RULE string literals
5. Run tests: confirm they pass
6. Commit: `fix: update stale stage names in CURSOR_RULE`

## Task 3: Fix stale stage names in .cursorrules

**File(s):** `.cursorrules`
**What to implement:**
- L12: `/check` -> `/validate` in stage table
- L21: `/check` -> `/validate` in flow diagram
- L41: `/check` -> `/validate` in quick start
- L70: `### 3. Check (\`/check\`)` -> `### 3. Validate (\`/validate\`)`

**TDD steps:**
1. Write test: `test/forge-commands.test.js` — read `.cursorrules`, assert zero occurrences of `` `/check` `` as stage name
2. Run test: confirm it fails
3. Implement: find-and-replace in .cursorrules
4. Run test: confirm it passes
5. Commit: `fix: update stale /check references in .cursorrules`

## Task 4: Fix hardcoded "9 workflow commands" counts

**File(s):** `bin/forge.js`
**What to implement:** Replace hardcoded "9" at L1888, L1933, L2345 with dynamic count from `getWorkflowCommands().length`. Also make copyFile warn (not just DEBUG) when a source file is missing.

**TDD steps:**
1. Write test: assert no hardcoded "9 workflow commands" string in bin/forge.js
2. Write test: assert copyFile logs warning (not just DEBUG) when source missing
3. Run tests: confirm they fail
4. Implement: use template literals with `getWorkflowCommands().length`, update copyFile warning
5. Run tests: confirm they pass
6. Commit: `fix: use dynamic command count, warn on missing sources`

## Task 5: Fix CLAUDE.md placeholder description

**File(s):** `CLAUDE.md`
**What to implement:** Replace the placeholder `This is a [describe what this project does in one sentence].` (L1) with the actual project description: "Forge is a 7-stage TDD-first development workflow for AI coding agents."

**TDD steps:**
1. Write test: `test/forge-commands.test.js` — read `CLAUDE.md`, assert it does not contain `[describe what this project does`
2. Run test: confirm it fails
3. Implement: replace the placeholder line
4. Run test: confirm it passes
5. Commit: `fix: replace CLAUDE.md placeholder with real project description`

## Task 6: Fix README/package.json agent count disagreements

**File(s):** `README.md`, `package.json`
**What to implement:** Audit the agent count claims. The repo supports 8 agents (Claude, Cursor, Cline, Codex, Copilot, Kilo, OpenCode, Roo). Ensure README features list and package.json description agree on the count.

**TDD steps:**
1. Write test: read `package.json` description, assert it mentions correct agent count or "all AI agents"
2. Write test: read `README.md`, assert agent count in features section is consistent
3. Run tests: confirm current state
4. Implement: update any mismatched counts
5. Run tests: confirm they pass
6. Commit: `fix: align agent count across README and package.json`

## Task 7: Grep and fix remaining /check stage refs in docs

**File(s):** `docs/`, `CHANGELOG.md`, `docs/plans/`
**What to implement:** Search all docs for `/check` used as a stage name (not as a verb). Fix any remaining occurrences. Historical plan files can be left as-is (they document past decisions), but active docs (WORKFLOW.md, ROADMAP.md, etc.) must use `/validate`.

**TDD steps:**
1. Write test: grep active docs (docs/WORKFLOW.md, docs/SETUP.md, docs/EXAMPLES.md, docs/VALIDATION.md) for `` `/check` `` as stage name — assert zero matches
2. Run test: confirm current state
3. Implement: fix any matches found
4. Run test: confirm zero matches
5. Commit: `fix: update remaining /check stage refs in active docs`
