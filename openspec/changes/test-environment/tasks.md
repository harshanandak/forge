# Implementation Tasks: Test Environment

## Overview

TDD-ordered implementation checklist for comprehensive test environment. Tasks are ordered by dependencies and test-first approach.

**Total Estimated Time**: 54-72 hours (split across multiple sessions)

---

## Phase 1: Test Infrastructure Setup (2-3 hours)

### Task 1.1: Create Directory Structure

- [ ] Create `test-env/` directory
- [ ] Create `test-env/fixtures/`
- [ ] Create `test-env/integration-tests/`
- [ ] Create `test-env/edge-cases/`
- [ ] Create `test-env/automation/`
- [ ] Create `test-env/validation/`
- [ ] Create `test-env/reports/`
- [ ] Create `.gitignore` for test-env (ignore generated files, keep structure)
- [ ] Create `test-env/README.md` (purpose, usage, how to run)

**Validation**: Directory structure exists, README is clear

### Task 1.2: Create Automation Scripts (Stubs)

Create empty scripts that will be filled in later phases:

- [ ] Create `test-env/automation/setup-fixtures.sh` (stub)
- [ ] Create `test-env/automation/run-matrix.sh` (stub)
- [ ] Create `test-env/automation/run-multi-install.sh` (stub)
- [ ] Create `test-env/automation/cleanup.sh` (stub)
- [ ] Make all scripts executable (`chmod +x`)

**Validation**: Scripts exist and are executable

### Task 1.3: Create Validation Helpers (TDD)

**Test-first approach**: Write helper tests before implementations

- [ ] **Test**: Create `test-env/validation/file-checker.test.js`
  - Test: Should validate file existence
  - Test: Should check file content
  - Test: Should verify symlinks
  - Test: Should return unified interface `{ passed, failures, coverage }`

- [ ] **Impl**: Create `test-env/validation/file-checker.js`
  - Implement: `validateInstallation(agent, scenario)`
  - Implement: `validateFile(file, checks)`
  - Implement: `checkSymlink(path, target)`

- [ ] **Test**: Create `test-env/validation/git-state-checker.test.js`
  - Test: Should check git initialization
  - Test: Should detect detached HEAD
  - Test: Should detect uncommitted changes
  - Test: Should detect merge conflicts

- [ ] **Impl**: Create `test-env/validation/git-state-checker.js`
  - Implement: `checkGitState(directory)`
  - Implement: `isDetachedHead()`
  - Implement: `hasUncommittedChanges()`
  - Implement: `hasMergeConflict()`

- [ ] **Test**: Create `test-env/validation/agent-validator.test.js`
  - Test: Should validate Claude Code configuration
  - Test: Should validate Cursor configuration
  - Test: Should validate all 11 agents

- [ ] **Impl**: Create `test-env/validation/agent-validator.js`
  - Implement: `validateAgent(agent, directory)`
  - Implement: `getExpectedFiles(agent)` (based on plugin definitions)

- [ ] **Test**: Create `test-env/validation/env-validator.test.js`
  - Test: Should parse .env.local correctly
  - Test: Should detect preserved variables
  - Test: Should validate format

- [ ] **Impl**: Create `test-env/validation/env-validator.js`
  - Implement: `validateEnvFile(path)`
  - Implement: `parseEnvFile(content)`
  - Implement: `checkPreservation(oldContent, newContent)`

**Validation**: All helper tests pass (`npm test test-env/validation/`)

---

## Phase 2: Test Fixtures Creation (2-3 hours)

### Task 2.1: Implement Fixture Setup Script

- [ ] Implement `test-env/automation/setup-fixtures.sh`:
  - Create fresh-project (git init only)
  - Create existing-forge-v1 (old AGENTS.md format)
  - Create partial-install (some .claude/commands/ missing)
  - Create conflicting-configs (AGENTS.md 250+ lines + CLAUDE.md)
  - Create read-only-dirs (.claude with 444 permissions)
  - Create no-git (no .git directory)
  - Create dirty-git (uncommitted changes)
  - Create detached-head (git checkout --detach)
  - Create merge-conflict (conflicting branches)
  - Create monorepo (pnpm workspace structure)
  - Create nextjs-project (package.json with next.js)
  - Create nestjs-project (package.json with @nestjs/core)
  - Create unicode-paths (files with special chars)
  - Create large-agents-md (AGENTS.md 300+ lines)
  - Create missing-prerequisites (marker file for Docker test)

**Validation**: Run script, verify all 15 fixtures created

### Task 2.2: Test Fixture Setup Script

- [ ] Create `test-env/automation/setup-fixtures.test.js`
  - Test: Script creates all 15 fixtures
  - Test: Each fixture has expected characteristics
  - Test: Script is idempotent (safe to run multiple times)

**Validation**: `npm test test-env/automation/setup-fixtures.test.js` passes

---

## Phase 3: Edge Case Testing (4-5 hours)

### Task 3.1: Prerequisites Edge Cases (TDD)

- [ ] **Test**: Create `test-env/edge-cases/prerequisites.test.js`
  - Test: Should detect missing git
  - Test: Should detect Node < 20
  - Test: Should detect no package manager
  - Test: Should warn about unauthenticated gh

- [ ] **Impl**: Add validation functions to `bin/forge.js:checkPrerequisites()`
  - Return structured errors (not just exit)
  - Provide fix suggestions

**Validation**: All prerequisites tests pass

### Task 3.2: Permission Errors (TDD)

- [ ] **Test**: Create `test-env/edge-cases/permission-errors.test.js`
  - Test: Read-only .claude directory
  - Test: Locked AGENTS.md file
  - Test: No write permission to project root

- [ ] **Impl**: Add permission checks to `bin/forge.js` before writes
  - Check write permissions before operations
  - Provide clear error messages with sudo suggestions

**Validation**: All permission tests pass

### Task 3.3: Git State Edge Cases (TDD)

- [ ] **Test**: Create `test-env/edge-cases/git-states.test.js`
  - Test: Detached HEAD warning
  - Test: Uncommitted changes warning
  - Test: Merge conflict error (block installation)

- [ ] **Impl**: Add git state checks to `bin/forge.js`
  - Use validation/git-state-checker.js
  - Warn but allow (detached HEAD, uncommitted)
  - Block installation (merge conflict)

**Validation**: All git state tests pass

### Task 3.4: Network Failures (TDD)

- [ ] **Test**: Create `test-env/edge-cases/network-failures.test.js`
  - Test: npm install timeout
  - Test: Curl download failure
  - Test: API key validation network error

- [ ] **Impl**: Add timeout handling to network operations
  - Add retry logic (3 attempts)
  - Graceful degradation (skip API validation on network error)

**Validation**: All network tests pass

### Task 3.5: Invalid JSON (TDD)

- [ ] **Test**: Create `test-env/edge-cases/invalid-json.test.js`
  - Test: Malformed plugin JSON
  - Test: Missing required fields
  - Test: Duplicate plugin IDs

- [ ] **Impl**: Enhanced plugin validation in `lib/plugin-manager.js`
  - JSON Schema validation
  - Clear error messages showing which file/field

**Validation**: All invalid JSON tests pass

### Task 3.6: File Size Limits (TDD)

- [ ] **Test**: Create `test-env/edge-cases/file-limits.test.js`
  - Test: AGENTS.md > 200 lines warning
  - Test: Warning doesn't block installation
  - Test: Suggestion to move to docs/

- [ ] **Impl**: Add file size check after AGENTS.md creation
  - Count lines
  - Log warning if > 200

**Validation**: All file limit tests pass

### Task 3.7: Security Validation (TDD)

- [ ] **Test**: Create `test-env/edge-cases/security.test.js`
  - Test: Shell injection attempts (43 tests from rollback pattern)
  - Test: Path traversal attempts
  - Test: Unicode injection
  - Apply to: installation paths, agent names, API keys

- [ ] **Impl**: Add `validateUserInput(input, type)` to `bin/forge.js`
  - Use same pattern as `test/rollback-edge-cases.test.js:10-54`
  - Validate all user inputs before use

**Validation**: All security tests pass (100% injection attempts blocked)

### Task 3.8: Env Preservation (TDD)

- [ ] **Test**: Create `test-env/edge-cases/env-preservation.test.js`
  - Test: Existing .env.local variables preserved
  - Test: New variables added correctly
  - Test: Comments preserved
  - Test: .gitignore updated

- [ ] **Impl**: Enhanced `readEnvFile()` and `writeEnvTokens()` in `bin/forge.js`
  - Use validation/env-validator.js
  - Preserve all existing content

**Validation**: All env preservation tests pass

---

## Phase 4: Integration Testing (3-4 hours)

### Task 4.1: NPM Install Flow (TDD)

- [ ] **Test**: Create `test-env/integration-tests/npm-install.test.js`
  - Test: Fresh npm install forge-workflow
  - Test: AGENTS.md created
  - Test: docs/ created
  - Test: No other files created (minimal install)

- [ ] **Validation**: Run against actual npm package

**Validation**: NPM install test passes

### Task 4.2: NPX Setup Flow (TDD)

- [ ] **Test**: Create `test-env/integration-tests/npx-setup.test.js`
  - Test: Quick mode (--quick)
  - Test: Interactive mode (mocked inputs)
  - Test: Agent selection (--agents flag)
  - Test: Skip external (--skip-external)

- [ ] **Validation**: Run against `bin/forge.js`

**Validation**: NPX setup tests pass

### Task 4.3: Curl Install Flow (TDD)

- [ ] **Test**: Create `test-env/integration-tests/curl-install.test.js`
  - Test: install.sh runs successfully
  - Test: Files created match npx setup
  - Test: Quick mode flag works

- [ ] **Validation**: Run against `install.sh`

**Validation**: Curl install tests pass

### Task 4.4: Multi-Agent Combinations (TDD)

- [ ] **Test**: Create `test-env/integration-tests/multi-agent.test.js`
  - Test: Single agent (11 tests, one per agent)
  - Test: Popular pairs (Claude+Cursor, Claude+Continue, Cursor+Windsurf)
  - Test: All agents
  - Test: No agents (error handling)

- [ ] **Validation**: Use validation/agent-validator.js

**Validation**: All 16 agent combination tests pass

### Task 4.5: Upgrade Flows (TDD)

- [ ] **Test**: Create `test-env/integration-tests/upgrade-flows.test.js`
  - Test: v1 → v2 upgrade (AGENTS.md format change)
  - Test: Partial → full installation
  - Test: USER section preservation
  - Test: Overwrite prompts

- [ ] **Impl**: Enhanced smart merge in `bin/forge.js:smartMergeAgentsMd()`

**Validation**: All upgrade tests pass

### Task 4.6: Package Manager Variations (TDD)

- [ ] **Test**: Create `test-env/integration-tests/package-managers.test.js`
  - Test: npm (package-lock.json)
  - Test: yarn (yarn.lock)
  - Test: pnpm (pnpm-lock.yaml)
  - Test: bun (bun.lockb)
  - Test: Detection accuracy
  - Test: Monorepo with mixed managers

**Validation**: All package manager tests pass

---

## Phase 5: Automation & Reporting (2 hours)

### Task 5.1: Implement Run Matrix Script

- [ ] Implement `test-env/automation/run-matrix.sh`:
  - Run all edge case tests sequentially
  - Run all integration tests sequentially
  - Collect pass/fail counts
  - Report total time

**Validation**: Script runs all tests, reports correctly

### Task 5.2: Implement Multi-Install Script

- [ ] Implement `test-env/automation/run-multi-install.sh`:
  - Test 13 installation scenarios
  - Use temp directories
  - Validate each installation
  - Generate performance benchmarks
  - Cleanup after each test

**Validation**: Script completes 13 scenarios, all pass

### Task 5.3: Implement Report Generator

- [ ] Create `test-env/automation/report-generator.js`:
  - Parse test results from run-matrix.sh
  - Parse benchmarks from run-multi-install.sh
  - Generate HTML report with:
    - Pass/fail summary
    - Coverage metrics
    - Performance benchmarks
    - Failed test details
  - Save to `test-env/reports/comprehensive-test-report.html`

**Validation**: Report generated, opens in browser correctly

### Task 5.4: Implement Cleanup Script

- [ ] Implement `test-env/automation/cleanup.sh`:
  - Remove all generated test files
  - Remove temp directories
  - Keep fixtures and structure
  - Safe to run multiple times

**Validation**: Script cleans up, no errors

### Task 5.5: Create CI/CD Workflow

- [ ] Create `.github/workflows/test-env.yml`:
  - Matrix: OS (ubuntu, macos, windows) × Node (20, 22) × PKG (npm, yarn, pnpm)
  - Run npm test
  - Run run-multi-install.sh
  - Generate report
  - Upload artifacts (30 day retention)

**Validation**: Workflow runs on PR, artifacts uploaded

---

## Phase 6: Critical Improvements (Priority-based)

### Priority 1: Critical (10-13 hours)

#### Task 6.1: Backup System (TDD)

- [ ] **Test**: Create `test/backup-system.test.js`
  - Test: Backup created before overwrite
  - Test: Manifest includes all files
  - Test: SHA256 checksums correct
  - Test: Auto-cleanup keeps last 5
  - Test: Rollback restores correctly

- [ ] **Impl**: Add backup functions to `bin/forge.js`
  - `createBackup()` - Create timestamped backup
  - `restoreBackup(timestamp)` - Restore from backup
  - `cleanupOldBackups()` - Keep last 5

**Validation**: All backup tests pass

#### Task 6.2: Atomic Installation (TDD)

- [ ] **Test**: Create `test/atomic-installation.test.js`
  - Test: All files written to staging first
  - Test: Atomic move on success
  - Test: Rollback on failure
  - Test: No partial state

- [ ] **Impl**: Refactor `bin/forge.js` installation flow
  - `atomicInstall(agents)` - Transaction-like installation
  - Staging directory: `.forge/staging-<timestamp>/`
  - Use `fs.renameSync()` for atomic moves

**Validation**: All atomic installation tests pass

#### Task 6.3: Enhanced Security Validation (TDD)

- [ ] **Test**: Create `test/input-validation.test.js`
  - Test: API key format validation
  - Test: Plugin JSON schema validation
  - Test: Checksum verification for downloads

- [ ] **Impl**: Enhanced validation
  - Add `validateApiKey(key, type)` with regex patterns
  - Add JSON Schema for plugin validation
  - Add checksum verification in `install.sh:280-290`

**Validation**: All security validation tests pass

### Priority 2: High (9-12 hours)

#### Task 6.4: Forge Doctor Command (TDD)

- [ ] **Test**: Create `test/forge-doctor.test.js`
  - Test: Detects missing files
  - Test: Detects corrupted files
  - Test: Suggests fixes
  - Test: Returns correct exit codes

- [ ] **Impl**: Create `bin/forge-doctor.js`
  - Check all expected files
  - Validate file contents
  - Check permissions, symlinks
  - Provide fix suggestions
  - Exit 0 (healthy) or 1 (issues)

- [ ] Add to `package.json` bin: `"forge-doctor": "bin/forge-doctor.js"`

**Validation**: All forge-doctor tests pass

#### Task 6.5: Interactive Recovery Mode (TDD)

- [ ] **Test**: Create `test/recovery-mode.test.js`
  - Test: Detects partial installation
  - Test: Shows what's missing
  - Test: Repairs on confirmation
  - Test: Preserves existing files

- [ ] **Impl**: Enhanced `detectProjectStatus()` in `bin/forge.js`
  - Detailed status (exists ✓, missing ✗, corrupted ⚠)
  - Prompt: "Repair installation? (y/n)"
  - Install only missing components
  - Run forge-doctor after repair

**Validation**: All recovery mode tests pass

#### Task 6.6: Progress Indication (Implementation)

- [ ] Add progress indicators to `bin/forge.js`:
  - Plugin loading (0-10%)
  - Prerequisites check (10-20%)
  - File downloads (20-60%)
  - Agent configuration (60-90%)
  - External services (90-100%)
  - "What's happening now" messages

**Note**: Simple console progress, no external dependencies

**Validation**: Manual testing, progress shows correctly

### Priority 3: Medium (18-23 hours)

#### Task 6.7: Expand Test Coverage

- [ ] Add 11 agent-specific validation tests
- [ ] Add 4 package manager tests
- [ ] Add 3 framework integration tests
- [ ] Add 2 monorepo tests
- [ ] Add 5 upgrade scenario tests
- [ ] Add 4 external service configuration tests

**Target**: 50+ test files total (from 9)

**Validation**: All tests pass, coverage ~95%

#### Task 6.8: Mock Testing Infrastructure

- [ ] Create `test/mocks/mock-npm-registry.js`
- [ ] Create `test/mocks/mock-git.js`
- [ ] Create `test/mocks/mock-api.js`
- [ ] Create `test/mocks/mock-fs.js`
- [ ] Update existing tests to use mocks (offline testing)

**Validation**: Tests run offline successfully

### Priority 4: Low (3-4 hours)

#### Task 6.9: Installation Presets

- [ ] Create `lib/presets.json`:
  - "fullstack": Claude + Cursor + GitHub + ESLint + Beads
  - "backend": Claude + NestJS + SonarCloud
  - "frontend": Cursor + React + ESLint
  - "minimal": Claude only

- [ ] Add `--preset` flag to `bin/forge.js`
- [ ] Support community presets in `.forge/presets/`

**Validation**: Each preset installs correctly

---

## Verification Tasks

After all phases complete:

- [ ] Run `npm test` - All 50+ tests pass
- [ ] Run `bash test-env/automation/run-matrix.sh` - All edge/integration tests pass
- [ ] Run `bash test-env/automation/run-multi-install.sh` - All 13 scenarios pass
- [ ] Run `node test-env/automation/report-generator.js` - Report generated successfully
- [ ] Manual testing:
  - [ ] Install in fresh Next.js project
  - [ ] Install in fresh NestJS project
  - [ ] Install in fresh React project
  - [ ] Test all 11 agent combinations
  - [ ] Test `forge doctor` finds and fixes issues
  - [ ] Test upgrade from v1 → v2
  - [ ] Test rollback functionality
- [ ] CI/CD:
  - [ ] All matrix jobs pass (18 jobs)
  - [ ] Artifacts uploaded successfully
  - [ ] Performance within targets (< 30s quick mode)

---

## Definition of Done

Each task is complete when:

1. ✅ Tests written (for testable tasks)
2. ✅ Implementation complete
3. ✅ Tests pass
4. ✅ Code reviewed
5. ✅ Documentation updated (if needed)
6. ✅ Committed to git

Each phase is complete when:

1. ✅ All tasks in phase done
2. ✅ Phase validation passes
3. ✅ Committed and pushed
4. ✅ PR created (if strategic)

---

## Notes

- **TDD discipline**: Always write tests before implementation
- **RED-GREEN-REFACTOR**: Failing test → passing implementation → refactor
- **Commit frequently**: After each GREEN cycle
- **Zero dependencies**: Use Node.js built-in modules only
- **Security first**: Validate all user inputs
- **Clear errors**: Every error includes suggested fix
