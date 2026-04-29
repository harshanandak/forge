# Setup Fixes — Task List

## Dependency Graph

```
Wave 1: [Task 1, Task 2]  (parallel — independent features)
Wave 2: [Task 3]           (depends on nothing, but Wave 2 groups lifecycle foundation)
Wave 3: [Task 4, Task 5]   (parallel — both depend on Task 3)
Wave 4: [Task 6]           (depends on Task 5)
Wave 5: [Task 7]           (depends on all above — wires CLI)
```

---

## Wave 1: Docs Copy (forge-fizb)

### Task 1: Add docs copy to setup flow

**File(s):** `bin/forge.js` (setupCoreDocs function area)

**What:** After existing doc scaffolding, copy TOOLCHAIN.md and VALIDATION.md from the package's `docs/` directory to the consumer project's `docs/forge/`. Create `docs/forge/` if it does not exist. Skip if the file already exists (idempotent).

**TDD:**
1. Write test: `test/setup-docs-copy.test.js` — assert setupCoreDocs copies TOOLCHAIN.md to `test-env/docs/forge/TOOLCHAIN.md`
2. Run test: expect FAIL (function does not copy yet)
3. Implement: Add `fs.copyFileSync` calls in setupCoreDocs, create `docs/forge/` with `fs.mkdirSync({ recursive: true })`
4. Run test: expect PASS
5. Commit: `"feat: copy essential docs during setup"`

### Task 2: Add `forge docs` CLI command

**File(s):** `bin/forge.js` (CLI command handling area)

**What:** Add `forge docs [topic]` command. No topic = list available topics. With topic = print content to stdout. Topics: toolchain, validation, setup, examples, roadmap. Read from the package's `docs/` directory using `__dirname/../docs/`.

**TDD:**
1. Write test: `test/forge-docs-command.test.js` — assert `forge docs toolchain` outputs TOOLCHAIN.md content, `forge docs` lists topics, `forge docs bad` shows error with available topics
2. Run test: expect FAIL
3. Implement: Add docs command handler with topic allowlist map `{ topic: filename }` + `fs.readFileSync` from `path.join(__dirname, '..', 'docs', filename)`
4. Run test: expect PASS
5. Commit: `"feat: add forge docs CLI command"`

---

## Wave 2: Lifecycle Foundation (forge-npza)

### Task 3: Implement file inventory for reset

**File(s):** `lib/reset.js` (new), `bin/forge.js`

**What:** Create `getForgeFiles(projectRoot)` that returns categorized lists of Forge-created files:
- **config**: `.forge/`
- **commands**: `.claude/commands/*.md` that match Forge template names
- **rules**: `.claude/rules/workflow.md`
- **scripts**: `.claude/scripts/`
- **agentDirs**: `.cursor/`, `.cline/`, `.windsurf/`, `.roo/`, `.aider/`, `.codex/`, `.junie/`
- **workflows**: `.github/workflows/beads-*.yml`
- **syncScripts**: `scripts/github-beads-sync/`

Must distinguish Forge-created files from user-created files by comparing against known template file names.

**TDD:**
1. Write test: `test/reset-inventory.test.js` — scaffold a test-env with Forge files + a custom user file in `.claude/rules/`, assert `getForgeFiles()` returns correct categories and does NOT include user files
2. Run test: expect FAIL
3. Implement: `getForgeFiles()` with `fs.existsSync` checks per category, template name matching for commands/rules
4. Run test: expect PASS
5. Commit: `"feat: add forge file inventory for reset"`

---

## Wave 3: Reset Commands (forge-npza)

### Task 4: Implement forge reset --soft

**File(s):** `lib/reset.js`, `bin/forge.js`

**What:** `--soft` removes only `.forge/` directory (setup state/config). Preserves all other Forge and user files. Requires `--force` or interactive confirmation (yes/no prompt).

**TDD:**
1. Write test: `test/reset-soft.test.js` — scaffold test-env with `.forge/` and `.claude/`, assert `--soft --force` removes `.forge/` but `.claude/` still exists
2. Run test: expect FAIL
3. Implement: Add `resetSoft(projectRoot, { force })` that calls `fs.rmSync('.forge/', { recursive: true, force: true })` with confirmation gate
4. Run test: expect PASS
5. Commit: `"feat: implement forge reset --soft"`

### Task 5: Implement forge reset --hard

**File(s):** `lib/reset.js`, `bin/forge.js`

**What:** `--hard` removes ALL Forge-created files (everything from `getForgeFiles()` inventory). Warns about user-modified files in `.claude/rules/`. Requires `--force` or interactive confirmation with explicit "type RESET to confirm" prompt.

**TDD:**
1. Write test: `test/reset-hard.test.js` — scaffold test-env with all Forge files + a custom user rule, assert `--hard --force` removes all Forge files, preserves user-created rule file
2. Run test: expect FAIL
3. Implement: Add `resetHard(projectRoot, { force })` that iterates `getForgeFiles()` categories and removes each with appropriate warnings
4. Run test: expect PASS
5. Commit: `"feat: implement forge reset --hard"`

---

## Wave 4: Reinstall (forge-npza)

### Task 6: Implement forge reinstall

**File(s):** `lib/reset.js`, `bin/forge.js`

**What:** `forge reinstall` = `resetHard()` + `runSetup()`. Atomic convenience command. Requires `--force` or interactive confirmation. If hard reset succeeds but setup fails, report partial state clearly.

**TDD:**
1. Write test: `test/reinstall.test.js` — scaffold test-env, run reinstall with `--force`, assert end state matches a fresh `forge setup` (same files exist, same content)
2. Run test: expect FAIL
3. Implement: Add `reinstall(projectRoot, { force })` that chains `resetHard` then calls setup entry point
4. Run test: expect PASS
5. Commit: `"feat: implement forge reinstall"`

---

## Wave 5: CLI Wiring (forge-npza)

### Task 7: Wire CLI commands

**File(s):** `bin/forge.js`

**What:** Add `reset` and `reinstall` to CLI argument parsing. `forge reset` (no flag) shows help text explaining `--soft` and `--hard` options. `forge reset --soft`, `forge reset --hard`, `forge reinstall`. All accept `--force` flag. Invalid flags show help.

**TDD:**
1. Write test: `test/cli-lifecycle.test.js` — assert CLI routing: `reset` with no flags shows help, `reset --soft` calls resetSoft, `reset --hard` calls resetHard, `reinstall` calls reinstall, all accept `--force`
2. Run test: expect FAIL
3. Implement: Add command routing in `bin/forge.js` for reset/reinstall, parse `--soft`/`--hard`/`--force` flags
4. Run test: expect PASS
5. Commit: `"feat: wire lifecycle commands to CLI"`
