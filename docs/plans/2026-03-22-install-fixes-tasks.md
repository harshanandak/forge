# Task List: Fix All Forge Installation Issues

- **Feature**: install-fixes
- **Epic**: forge-on7a
- **Branch**: feat/install-fixes
- **Baseline**: 1970 pass, 31 skip, 12 fail (pre-existing)
- **Total tasks**: 18
- **Design doc**: docs/plans/2026-03-22-install-fixes-design.md

## Dependency Graph

```
Wave 1 (foundations — no dependencies):
  Task 1: ActionCollector + isNonInteractive() utilities
  Task 2: Fix smartMergeAgentsMd() for missing markers
  Task 3: Package distribution — add scripts to files array

Wave 2 (depends on Wave 1):
  Task 4: --dry-run flag (depends on Task 1: ActionCollector)
  Task 5: --non-interactive + CI detection (depends on Task 1: isNonInteractive)
  Task 6: --symlink flag
  Task 7: Lefthook prerequisite check (binary existence)

Wave 3 (depends on Wave 2):
  Task 8: Husky detection + migration (depends on Task 5: non-interactive, Task 7: lefthook check)
  Task 9: Deprecate install.sh to thin bootstrapper

Wave 4 (Beads setup — depends on Wave 2):
  Task 10: Beads config writer (prefix, gitignore, config.yaml)
  Task 11: Defensive bd init wrapper (save/restore hooks)
  Task 12: Beads health check smoke test

Wave 5 (Beads sync — depends on Wave 4):
  Task 13: Sync scripts distribution + scaffolding
  Task 14: Default branch detection + workflow templating
  Task 15: PAT guided setup via gh CLI

Wave 6 (docs + integration — depends on all above):
  Task 16: README + docs updates (dev dependency, install.sh deprecation)
  Task 17: npm pack integration test
  Task 18: Upstream Beads issue filing
```

---

## Wave 1: Foundations (no dependencies)

### Task 1: ActionCollector utility + isNonInteractive() helper

**File(s)**: `lib/setup-utils.js` (new), `test/setup-utils.test.js` (new)

**What to implement**: Two foundational utilities used by multiple downstream tasks:

1. `ActionCollector` class — collects `{ type: 'create'|'modify'|'skip', path, description }` entries. Methods: `add(type, path, description)`, `list()` returns array, `print()` outputs formatted list to stdout. Used by `--dry-run` to collect planned actions and by normal mode to log what was done.

2. `isNonInteractive()` function — returns `true` if any of: `process.env.CI` is truthy, `process.env.GITHUB_ACTIONS` exists, `process.env.GITLAB_CI` exists, `!process.stdin.isTTY`, or `--non-interactive` flag was passed. Used by all interactive prompts to decide whether to ask or use defaults.

**TDD steps**:
1. Write test: `test/setup-utils.test.js` — ActionCollector: add 3 actions, verify `list()` returns them, verify `print()` output format
2. Write test: isNonInteractive returns true when CI=true, when GITHUB_ACTIONS set, when stdin not TTY
3. Write test: isNonInteractive returns false when none of the above
4. Run tests: confirm they fail (modules don't exist)
5. Implement: `lib/setup-utils.js` with both exports
6. Run tests: confirm they pass
7. Commit: `feat: add ActionCollector and isNonInteractive utilities`

**Expected output**: All tests pass. Module exports `{ ActionCollector, isNonInteractive }`.

---

### Task 2: Fix smartMergeAgentsMd() for missing markers

**File(s)**: `bin/forge.js` (line 734-774), `test/smart-merge.test.js` (new)

**What to implement**: Fix the bug where `smartMergeAgentsMd()` returns empty string when existing CLAUDE.md has no USER/FORGE markers, causing the caller to overwrite the file.

New behavior:
- **No markers at all**: Wrap entire existing content in `<!-- USER:START -->` / `<!-- USER:END -->`, append new FORGE section
- **USER markers but no FORGE markers**: Keep USER section, insert FORGE section
- **Both markers present**: Current behavior (update FORGE, preserve USER) — already works

**TDD steps**:
1. Write test: CLAUDE.md with no markers → existing content preserved inside USER markers, FORGE section appended
2. Write test: CLAUDE.md with USER markers only → USER preserved, FORGE inserted
3. Write test: CLAUDE.md with both markers → USER preserved, FORGE updated (existing behavior)
4. Write test: empty CLAUDE.md → only FORGE section written (no empty USER block)
5. Run tests: confirm they fail
6. Implement: modify `smartMergeAgentsMd()` in `bin/forge.js:734-774`
7. Run tests: confirm they pass
8. Commit: `fix: smartMergeAgentsMd preserves existing CLAUDE.md without markers`

**Expected output**: All merge scenarios produce correct output. Existing user content never lost.

---

### Task 3: Package distribution — add missing scripts to files array

**File(s)**: `package.json`

**What to implement**: Verify and fix the `files` array to ensure all required scripts are distributed in the npm package:

1. Verify `scripts/` glob in files array captures: `commitlint.js`, `branch-protection.js`, `lint.js`, `test.js`, `sync-utils.sh`, `file-index.sh`, `conflict-detect.sh`
2. Add `scripts/github-beads-sync/` to files array (sync modules)
3. Add `.github/workflows/github-to-beads.yml` and `.github/workflows/beads-to-github.yml` as templates (or under a templates/ directory)

**TDD steps**:
1. Write test: `test/package-distribution.test.js` — run `npm pack --dry-run` and verify expected files appear in tarball listing
2. Run test: confirm it identifies missing files
3. Implement: update `package.json` `files` array
4. Run test: confirm all required files present
5. Commit: `fix: add sync scripts and workflow templates to npm package`

**Expected output**: `npm pack --dry-run` shows all hook scripts, multi-dev scripts, and sync modules.

---

## Wave 2: Core Flags (depends on Wave 1)

### Task 4: --dry-run flag

**File(s)**: `bin/forge.js`, `test/dry-run.test.js` (new)

**What to implement**: Add `--dry-run` flag that collects all planned actions using ActionCollector (Task 1) and prints them without modifying any files.

1. Parse `--dry-run` flag in CLI args section (~line 2577)
2. Pass `dryRun` boolean through setup flow
3. Before each file write/copy/mkdir, call `collector.add(type, path, description)`
4. If `dryRun`, print collector output and exit 0 without executing any actions
5. If not `dryRun`, execute actions AND log them (for transparency)

**TDD steps**:
1. Write test: `--dry-run` produces "Would create" lines for expected files, exit 0
2. Write test: `--dry-run` does not create any files (tmpdir is empty after run)
3. Write test: `--dry-run` + `--agents=claude` only lists Claude-related files
4. Write test: `--agents=claude,cursor` in normal mode installs ONLY .claude/ and .cursor/ dirs (verifies existing --agents logic works end-to-end)
5. Write test: `--agents=invalid` exits with error listing valid agent names
6. Run tests: confirm they fail
7. Implement: wire ActionCollector into bin/forge.js setup flow
8. Run tests: confirm they pass
9. Commit: `feat: add --dry-run flag for setup preview`

**Expected output**: `bunx forge setup --dry-run` prints file list, creates nothing. `--agents` filtering verified.

---

### Task 5: --non-interactive flag + CI auto-detection

**File(s)**: `bin/forge.js`, `test/non-interactive.test.js` (new)

**What to implement**: Add `--non-interactive` flag and CI environment detection so setup completes without any prompts. Also fix `--quick` mode to fully skip external service prompts.

1. Parse `--non-interactive` flag in CLI args section
2. At the top of setup, call `isNonInteractive()` (Task 1)
3. Wrap every `askYesNo()`, `question()`, and `readline` prompt with a check: if non-interactive, use the default value silently
4. Log which defaults were chosen: "Non-interactive mode: using default agent selection (all)"
5. Fix `--quick` mode: it should imply `--non-interactive` (currently still prompts for external services)
6. `.env.local` security: after writing API keys, set file permissions to 0600 (OWASP A02). On Windows, skip chmod (not applicable).
7. Mask API key input during prompts (use readline with `muted` option or replace with asterisks)

**TDD steps**:
1. Write test: CI=true → setup completes with no stdin, uses defaults
2. Write test: --non-interactive → same behavior as CI=true
3. Write test: --quick → skips ALL prompts including external services
4. Write test: interactive mode (TTY) still prompts (mock readline)
5. Write test: .env.local has 0600 permissions after write (Unix only)
6. Run tests: confirm they fail
7. Implement: add flag parsing + wrap all prompts + chmod + quick fix
8. Run tests: confirm they pass
9. Commit: `feat: add --non-interactive flag, CI detection, fix --quick, secure .env.local`

**Expected output**: `CI=true bunx forge setup` completes silently with defaults. `.env.local` is owner-only readable.

---

### Task 6: --symlink flag

**File(s)**: `bin/forge.js`, `test/symlink-flag.test.js` (new)

**What to implement**: Add `--symlink` flag that creates CLAUDE.md as a symlink to AGENTS.md instead of a separate file.

1. Parse `--symlink` flag
2. When creating CLAUDE.md and `--symlink` is set:
   - On Unix: `fs.symlinkSync('AGENTS.md', 'CLAUDE.md')` (relative path)
   - On Windows: try symlink first, catch EPERM, fall back to file copy with header comment: `<!-- This file is a copy of AGENTS.md. Keep in sync manually or use: bunx forge setup --symlink -->`
3. Skip CLAUDE.md creation in normal flow when `--symlink` is active

**TDD steps**:
1. Write test: `--symlink` creates symlink on Unix (check `fs.lstatSync().isSymbolicLink()`)
2. Write test: symlink target resolves to AGENTS.md content
3. Write test: Windows fallback creates copy with header comment
4. Run tests: confirm they fail
5. Implement: add flag + symlink logic
6. Run tests: confirm they pass
7. Commit: `feat: add --symlink flag for CLAUDE.md → AGENTS.md`

**Expected output**: CLAUDE.md is a symlink (or annotated copy on Windows).

---

### Task 7: Lefthook prerequisite check

**File(s)**: `bin/forge.js` (~line 2844), `test/lefthook-check.test.js` (new)

**What to implement**: Improve `checkForLefthook()` to verify the binary actually exists, not just the package.json entry.

1. Check `package.json` devDependencies (existing)
2. Also check: `npx lefthook --version` or `which lefthook` to verify binary is available
3. If package.json has it but binary missing: "lefthook is in package.json but not installed. Run: bun install"
4. If neither: "lefthook not found. Run: bun add -D lefthook && bun install"
5. If binary missing, **don't create lefthook.yml** — warn and skip

**TDD steps**:
1. Write test: lefthook binary found → proceed with lefthook.yml creation
2. Write test: lefthook in package.json but no binary → warn "run bun install", skip yml
3. Write test: lefthook not in package.json at all → warn "run bun add -D lefthook", skip yml
4. Run tests: confirm they fail
5. Implement: enhance `checkForLefthook()` at bin/forge.js:2844
6. Run tests: confirm they pass
7. Commit: `fix: lefthook check verifies binary existence, not just package.json`

**Expected output**: Clear warning when lefthook missing, no broken lefthook.yml created.

---

## Wave 3: Complex Features (depends on Wave 2)

### Task 8: Husky detection + migration

**File(s)**: `lib/husky-migration.js` (new), `test/husky-migration.test.js` (new)

**What to implement**: Detect Husky installation and offer automated migration to Lefthook.

1. `detectHusky()` — check for `.husky/` directory and `core.hooksPath` git config
2. `mapHuskyHooks(huskyDir)` — read `.husky/pre-commit`, `.husky/commit-msg`, etc. Parse shell commands. Map to lefthook.yml format. Return `{ mapped: [...], unmapped: [...] }`.
3. `migrateHusky(projectRoot, options)` — orchestrate:
   a. Validate `.husky/` files are regular files (not symlinks — OWASP A08)
   b. Parse and map hooks
   c. Warn about unmapped hooks
   d. If user confirms (or non-interactive): remove `.husky/`, `git config --unset core.hooksPath`, merge mapped hooks into lefthook.yml
4. Integrate into setup flow: after agent selection, before lefthook setup

**TDD steps**:
1. Write test: `.husky/pre-commit` with `npx lint-staged` → maps to lefthook pre-commit command
2. Write test: `.husky/commit-msg` with custom script → maps to lefthook commit-msg command
3. Write test: symlink in `.husky/` → rejected with security warning
4. Write test: unmappable hook → listed in warnings, not silently dropped
5. Write test: full migration removes `.husky/`, unsets `core.hooksPath`
6. Write test: non-interactive mode auto-migrates without prompting
7. Run tests: confirm they fail
8. Implement: `lib/husky-migration.js`
9. Wire into `bin/forge.js` setup flow
10. Run tests: confirm they pass
11. Commit: `feat: Husky detection and automated migration to Lefthook`

**Expected output**: Husky detected → hooks mapped → `.husky/` removed → lefthook.yml updated.

---

### Task 9: Deprecate install.sh to thin bootstrapper

**File(s)**: `install.sh`, `test/install-sh.test.js` (new)

**What to implement**: Replace the 1,056-line install.sh with a ~30-line bootstrapper that installs the npm package and delegates to `bunx forge setup`.

1. Detect package manager: check for `bun`, fall back to `npx`
2. Install package: `bun add -D forge-workflow` or `npm install -D forge-workflow`
3. Delegate: `bunx forge setup "$@"` or `npx forge setup "$@"` (passthrough all args)
4. Error handling: if no package manager found, print install instructions and exit 1
5. Add deprecation notice at top: "This script is a bootstrapper. For full control, use: bunx forge setup"

**TDD steps**:
1. Write test: install.sh with bun available → installs package + calls bunx forge setup
2. Write test: install.sh with only npm available → installs package + calls npx forge setup
3. Write test: install.sh with no package manager → error with instructions
4. Write test: install.sh passes through all args (e.g., --agents=claude)
5. Run tests: confirm they fail
6. Implement: rewrite install.sh
7. Run tests: confirm they pass
8. Commit: `refactor: deprecate install.sh to thin bootstrapper`

**Expected output**: `curl ... | bash` installs package and delegates to `bunx forge setup`.

---

## Wave 4: Beads Setup (depends on Wave 2)

### Task 10: Beads config writer

**File(s)**: `lib/beads-setup.js` (new), `test/beads-setup.test.js` (new)

**What to implement**: Utilities for configuring Beads correctly during forge setup.

1. `sanitizePrefix(repoName)` — lowercase, replace non-alphanumeric with hyphens, trim hyphens: `"My-Project_v2!"` → `"my-project-v2"`
2. `writeBeadsConfig(projectRoot, options)` — write `.beads/config.yaml` with:
   - `issue-prefix: <sanitized-repo-name>`
   - Database config appropriate for Dolt backend
3. `writeBeadsGitignore(projectRoot)` — create `.beads/.gitignore` with entries for Dolt binary files: `dolt/`, `*.db`, `*.lock`
4. `isBeadsInitialized(projectRoot)` — check if `.beads/` exists with valid `config.yaml` and issues (for idempotent re-runs)
5. `preSeedJsonl(projectRoot)` — ensure `issues.jsonl` exists (create empty file if missing, so `bd create` doesn't fail)

**TDD steps**:
1. Write test: sanitizePrefix with various inputs (spaces, special chars, mixed case)
2. Write test: writeBeadsConfig creates valid YAML with correct prefix
3. Write test: writeBeadsGitignore creates correct ignore patterns
4. Write test: isBeadsInitialized returns false for empty dir, true for configured dir
5. Write test: preSeedJsonl creates file if missing, leaves existing file alone
6. Run tests: confirm they fail
7. Implement: `lib/beads-setup.js`
8. Run tests: confirm they pass
9. Commit: `feat: add Beads config writer utilities`

**Expected output**: All Beads config utilities work correctly in isolation.

---

### Task 11: Defensive bd init wrapper

**File(s)**: `lib/beads-setup.js` (extend), `test/beads-setup.test.js` (extend)

**What to implement**: Wrapper that runs `bd init` safely, protecting hooks and fixing known issues.

1. `safeBeadsInit(projectRoot, options)` — orchestrate:
   a. Check if already initialized (idempotent — skip if `.beads/` has issues)
   b. Write config.yaml with correct prefix (Task 10)
   c. Write `.beads/.gitignore` (Task 10)
   d. Snapshot current `.git/hooks/` directory (save file contents + permissions)
   e. Run `bd init` with appropriate flags
   f. Restore `.git/hooks/` from snapshot (undo bd init's hook overwrite)
   g. Re-run `lefthook install` if lefthook is available (restore lefthook's hooks)
   h. Pre-seed JSONL if empty (Task 10)
   i. Return `{ success, warnings, errors }`
2. Handle `bd init` failure gracefully — report error, offer to continue without Beads
3. In non-interactive mode: auto-initialize, report results

**TDD steps**:
1. Write test: full init flow — config written, bd init called, hooks restored
2. Write test: hooks are identical before and after safeBeadsInit
3. Write test: idempotent — second run skips init, returns early
4. Write test: bd init failure → graceful error, setup continues
5. Write test: non-interactive mode → no prompts, auto-init
6. Run tests: confirm they fail
7. Implement: extend `lib/beads-setup.js`
8. Run tests: confirm they pass
9. Commit: `feat: defensive bd init wrapper with hook preservation`

**Expected output**: Beads initialized correctly, hooks untouched, idempotent on re-run.

---

### Task 12: Beads health check smoke test

**File(s)**: `lib/beads-setup.js` (extend), `test/beads-setup.test.js` (extend)

**What to implement**: After Beads init, run a smoke test to verify it's working.

1. `beadsHealthCheck(projectRoot)` — orchestrate:
   a. `bd create --title="Setup verification" --type=task --priority=4` → capture issue ID
   b. `bd close <id> --reason="Setup smoke test"` → verify close works
   c. `bd sync` → verify sync works
   d. Remove the test issue from JSONL (clean up)
   e. Return `{ healthy: true/false, failedStep, error }`
2. If health check fails: report which step failed, suggest manual fix, don't block rest of setup
3. In non-interactive mode: run silently, report pass/fail

**TDD steps**:
1. Write test: healthy Beads → create/close/sync all succeed, test issue cleaned up
2. Write test: bd create fails → reports failedStep='create', healthy=false
3. Write test: bd close fails → reports failedStep='close', healthy=false
4. Write test: cleanup removes test issue from JSONL
5. Run tests: confirm they fail
6. Implement: extend `lib/beads-setup.js`
7. Run tests: confirm they pass
8. Commit: `feat: Beads health check smoke test after initialization`

**Expected output**: Smoke test runs silently, reports pass/fail.

---

## Wave 5: Beads Sync (depends on Wave 4)

### Task 13: Sync scripts distribution + scaffolding

**File(s)**: `bin/forge.js`, `lib/beads-sync-scaffold.js` (new), `test/beads-sync-scaffold.test.js` (new)

**What to implement**: Scaffold Beads sync workflows and scripts to the user's project during setup.

1. `scaffoldBeadsSync(projectRoot, packageDir, options)` — orchestrate:
   a. Copy workflow templates to `.github/workflows/` (github-to-beads.yml, beads-to-github.yml)
   b. Copy sync modules to `.github/scripts/beads-sync/` (from package's scripts/github-beads-sync/)
   c. Create `.github/beads-sync-config.json` with default config
   d. Create `.github/beads-mapping.json` if not exists (empty `{}`)
   e. Template workflow files: replace branch name, Beads version
2. Integrate into setup: detect `.beads/`, prompt "Enable GitHub ↔ Beads sync?", or `--sync` flag
3. In non-interactive mode: skip sync setup unless `--sync` explicitly passed

**TDD steps**:
1. Write test: scaffolding creates all expected files in `.github/`
2. Write test: workflow files contain detected branch name (not `master`)
3. Write test: existing `.github/beads-mapping.json` is preserved
4. Write test: `--sync` flag triggers scaffolding without prompt
5. Write test: non-interactive without `--sync` skips sync setup
6. Run tests: confirm they fail
7. Implement: `lib/beads-sync-scaffold.js` + wire into bin/forge.js
8. Run tests: confirm they pass
9. Commit: `feat: Beads sync scaffolding during forge setup`

**Expected output**: `.github/workflows/` has templated Beads sync workflows.

---

### Task 14: Default branch detection + workflow templating

**File(s)**: `lib/beads-sync-scaffold.js` (extend), `test/beads-sync-scaffold.test.js` (extend)

**What to implement**: Auto-detect the repo's default branch AND Beads version, then write both into workflow templates.

1. `detectDefaultBranch(projectRoot)` — try in order:
   a. `git symbolic-ref refs/remotes/origin/HEAD` → parse branch name
   b. `git remote show origin` → parse "HEAD branch" line
   c. Fall back to `main`
2. `detectBeadsVersion(projectRoot)` — try in order:
   a. Run `bd --version` → parse version string
   b. Fall back to known-good default (currently `0.49.1`)
3. In interactive mode: show detected branch + Beads version, ask "Use these? (y/n)", allow override
4. In non-interactive mode: use detected values silently
5. Template replacement in workflow YAML:
   - Replace `branches: [master]` with detected branch
   - Replace `BD_VERSION="0.49.1"` with detected Beads version

**TDD steps**:
1. Write test: origin/HEAD set to main → detects `main`
2. Write test: origin/HEAD not set, remote show returns develop → detects `develop`
3. Write test: no remote at all → falls back to `main`
4. Write test: `bd --version` returns "0.52.0" → writes `BD_VERSION="0.52.0"` to workflow
5. Write test: `bd` not installed → falls back to `BD_VERSION="0.49.1"`
6. Write test: interactive mode shows confirmation prompt with both values
7. Write test: non-interactive uses detected silently
8. Run tests: confirm they fail
9. Implement: extend `lib/beads-sync-scaffold.js`
10. Run tests: confirm they pass
11. Commit: `feat: auto-detect default branch and Beads version for sync workflows`

**Expected output**: Workflow YAML uses the correct branch name and matching Beads version.

---

### Task 15: PAT guided setup via gh CLI

**File(s)**: `lib/beads-sync-scaffold.js` (extend), `test/beads-sync-scaffold.test.js` (extend)

**What to implement**: Guide the user through PAT creation and save it as a repo secret.

1. `setupPAT(projectRoot, options)` — orchestrate:
   a. Check `gh auth status` — is gh authenticated?
   b. If yes: explain PAT requirements (repo scope), link to GitHub PAT page, prompt user to paste token
   c. Validate token is non-empty, looks like a GitHub token (starts with `ghp_` or `github_pat_`)
   d. Run `gh secret set BEADS_SYNC_TOKEN` with the token
   e. Verify: `gh secret list` includes BEADS_SYNC_TOKEN
   f. If gh not authed: print manual instructions (secret name, scopes, GitHub URL)
2. In non-interactive mode: skip PAT setup, print post-setup reminder
3. Mask token in all output (never echo it)

**TDD steps**:
1. Write test: gh authed → prompts for token, saves via gh secret set
2. Write test: gh not authed → prints manual instructions, no gh secret set
3. Write test: invalid token format → warns, re-prompts (or skips in non-interactive)
4. Write test: non-interactive → skips PAT setup, prints reminder
5. Write test: token is never printed to stdout
6. Run tests: confirm they fail
7. Implement: extend `lib/beads-sync-scaffold.js`
8. Run tests: confirm they pass
9. Commit: `feat: guided PAT setup for Beads sync via gh CLI`

**Expected output**: PAT saved as repo secret, or clear instructions printed.

---

## Wave 6: Docs + Integration (depends on all above)

### Task 16: README + docs updates

**File(s)**: `README.md`, `docs/SETUP.md`, `docs/research/test-environment.md`, `CHANGELOG.md`

**What to implement**: Update all documentation to reflect changes:

1. README: recommend `bun add -D forge-workflow` (dev dependency, not prod)
2. README: document new flags: `--dry-run`, `--non-interactive`, `--symlink`, `--sync`, `--agents`
3. docs/SETUP.md: update curl command with note about thin bootstrapper
4. docs/SETUP.md: add Beads sync setup section
5. docs/research/test-environment.md: update install.sh references
6. CHANGELOG: add entry for all changes

**TDD steps**:
1. Write test: `test/docs-consistency.test.js` — verify README mentions `--dry-run`, `--non-interactive`, `--symlink`
2. Write test: verify SETUP.md install command uses `-D` flag
3. Run tests: confirm they fail
4. Implement: update all docs
5. Run tests: confirm they pass
6. Commit: `docs: update README, SETUP, and CHANGELOG for install-fixes`

**Expected output**: All docs accurate and consistent.

---

### Task 17: npm pack integration test

**File(s)**: `test/integration/package-distribution.test.js` (new)

**What to implement**: Integration test that verifies the published npm package contains all required files.

1. Run `npm pack --dry-run --json` and parse output
2. Assert presence of:
   - All hook scripts: `scripts/commitlint.js`, `scripts/branch-protection.js`, `scripts/lint.js`, `scripts/test.js`
   - All multi-dev scripts: `scripts/sync-utils.sh`, `scripts/file-index.sh`, `scripts/conflict-detect.sh`
   - All sync modules: `scripts/github-beads-sync/*.mjs`
   - Workflow templates
   - All agent directories
3. Assert absence of: `test/`, `docs/plans/`, `.worktrees/`, `node_modules/`

**TDD steps**:
1. Write test: verify all required files present in pack output
2. Write test: verify no test/development files leak into package
3. Run tests: confirm current state (may pass or fail based on files array)
4. If failing: this is caught by Task 3's files array changes
5. Commit: `test: add npm pack integration test for package distribution`

**Expected output**: CI catches any future distribution regressions.

---

### Task 18: File upstream Beads issues

**File(s)**: None (GitHub issues)

**What to implement**: File issues on the Beads GitHub repo for bugs that Forge is working around:

1. Empty JSONL causes `bd create` to fail
2. `bd init` overwrites existing git hooks without asking
3. `bd init --prefix` flag doesn't persist to config.yaml
4. `bd sync` reports "Exported 0 issues" in no-db mode despite issues existing
5. Dolt binary files created even with `no-db: true`

**Steps**:
1. For each bug, create a GitHub issue on the Beads repo with reproduction steps
2. Reference the Forge workarounds
3. Link issues in the design doc
4. Commit: `docs: add upstream Beads issue references`

**Expected output**: 5 upstream issues filed with reproduction steps.
