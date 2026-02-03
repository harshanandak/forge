# Testing Capability Specification

## ADDED Requirements

### Requirement: Test Infrastructure

The system MUST provide a comprehensive test infrastructure with isolated fixtures, validation helpers, and automation scripts.

#### Scenario: Create test environment directory structure

**GIVEN** a Forge project
**WHEN** test infrastructure is set up
**THEN**:
- `test-env/fixtures/` directory exists with 15 test scenarios
- `test-env/validation/` directory exists with 4 helper modules
- `test-env/automation/` directory exists with 4 scripts
- `test-env/integration-tests/` directory exists for full flow tests
- `test-env/edge-cases/` directory exists for edge case tests
- `test-env/reports/` directory exists for generated reports

#### Scenario: Test fixtures isolation

**GIVEN** test fixtures are created
**WHEN** running tests
**THEN** each test runs in isolated temp directory to prevent pollution

### Requirement: Edge Case Testing

The system MUST validate all identified edge cases including prerequisites, permissions, git states, network failures, and security vulnerabilities.

#### Scenario: Missing prerequisites detected

**GIVEN** git is not installed
**WHEN** running forge setup
**THEN**:
- Installation fails with clear error message
- Error includes fix suggestion: "Install from https://git-scm.com"
- Exit code is 1

#### Scenario: Read-only directory handling

**GIVEN** .claude directory has 444 permissions
**WHEN** running forge setup
**THEN**:
- Installation fails with permission error
- Error suggests: "sudo chown -R $USER ."
- No partial files created

#### Scenario: Git detached HEAD state

**GIVEN** repository is in detached HEAD state
**WHEN** running forge setup
**THEN**:
- Installation continues with warning
- Warning displayed: "Git is in detached HEAD state"
- Installation completes successfully

#### Scenario: Active merge conflict

**GIVEN** repository has active merge conflict
**WHEN** running forge setup
**THEN**:
- Installation blocked
- Error: "Active merge conflict detected"
- Suggests: "Resolve conflicts before running forge setup"

### Requirement: Security Validation

The system MUST block 100% of shell injection and path traversal attempts.

#### Scenario: Shell injection attempt blocked

**GIVEN** user provides installation path with shell metacharacters
**WHEN** validating input: `--path "test;rm -rf /"`
**THEN**:
- Input rejected
- Error: "Invalid characters in path: test;rm -rf /"
- Installation does not proceed

#### Scenario: Path traversal attempt blocked

**GIVEN** user provides path outside project root
**WHEN** validating input: `--path "../../../etc/passwd"`
**THEN**:
- Input rejected
- Error: "Path outside project: ../../../etc/passwd"
- Installation does not proceed

#### Scenario: Unicode injection blocked

**GIVEN** user provides path with non-ASCII characters
**WHEN** validating input: `--path "file😀.js"`
**THEN**:
- Input rejected
- Error: "Only ASCII characters allowed in path"
- Installation does not proceed

### Requirement: Multi-Agent Installation

The system MUST support installation for all 11 agent combinations with validation.

#### Scenario: Single agent installation

**GIVEN** user selects Claude Code only
**WHEN** running forge setup --agents claude
**THEN**:
- CLAUDE.md created (symlink to AGENTS.md)
- .claude/commands/ created with 9 command files
- .claude/skills/forge-workflow/SKILL.md created
- .mcp.json created with Context7 MCP
- No other agent directories created

#### Scenario: Multiple agent installation

**GIVEN** user selects Claude + Cursor
**WHEN** running forge setup --agents claude,cursor
**THEN**:
- Both Claude Code and Cursor files created
- CLAUDE.md and .cursorrules created
- .claude/ and .cursor/ directories created
- No files for other agents created

#### Scenario: All agents installation

**GIVEN** user selects all 11 agents
**WHEN** running forge setup --all
**THEN**:
- All 11 agent configurations created
- Installation completes in < 30 seconds
- All expected files validated

### Requirement: Package Manager Compatibility

The system MUST support npm, yarn, pnpm, and bun package managers.

#### Scenario: npm installation

**GIVEN** project uses npm (package-lock.json exists)
**WHEN** detecting package manager
**THEN**:
- npm detected correctly
- .env.local contains PKG_MANAGER=npm
- Installation uses npm commands

#### Scenario: pnpm workspace (monorepo)

**GIVEN** project is pnpm workspace
**WHEN** installing in packages/api/
**THEN**:
- AGENTS.md created in packages/api/ (not root)
- Installation scoped to package
- No root-level AGENTS.md created

### Requirement: Validation Helpers

The system MUST provide 4 validation helper modules with unified interface.

#### Scenario: File checker validates installation

**GIVEN** installation completed for Claude Code
**WHEN** calling `validateInstallation('claude', 'fresh-project')`
**THEN** returns:
```javascript
{
  passed: true,
  failures: [],
  coverage: 1.0
}
```

#### Scenario: Git state checker detects uncommitted changes

**GIVEN** repository has uncommitted changes
**WHEN** calling `checkGitState(directory)`
**THEN** returns:
```javascript
{
  passed: false,
  failures: [
    { check: 'uncommitted', reason: 'Working tree has uncommitted changes' }
  ],
  coverage: 0.75
}
```

### Requirement: CI/CD Integration

The system MUST provide automated testing across platforms via GitHub Actions.

#### Scenario: Pull request triggers test workflow

**GIVEN** pull request modifies bin/forge.js
**WHEN** PR is created
**THEN**:
- GitHub Actions workflow triggered
- 18 matrix jobs run (3 OS × 2 Node × 3 PKG)
- All tests pass
- Artifacts uploaded

#### Scenario: Test reports generated

**GIVEN** test workflow completes
**WHEN** accessing artifacts
**THEN**:
- HTML report available for download
- Report includes pass/fail counts, coverage, benchmarks
- Retention: 30 days

### Requirement: Performance Targets

The system MUST meet performance targets for installation and testing.

#### Scenario: Quick mode installation under 30 seconds

**GIVEN** fresh project
**WHEN** running `npx forge setup --quick`
**THEN**:
- Installation completes in < 30 seconds
- All files created correctly
- Performance benchmark recorded

#### Scenario: Test suite executes under 2 minutes

**GIVEN** all 50+ test files
**WHEN** running `npm test`
**THEN**:
- All tests complete in < 2 minutes locally
- All tests pass
- Coverage report generated

### Requirement: Automation Scripts

The system MUST provide automation scripts for setup, execution, and cleanup.

#### Scenario: Setup fixtures script

**GIVEN** test-env/automation/setup-fixtures.sh exists
**WHEN** running script
**THEN**:
- All 15 fixtures created in test-env/fixtures/
- Each fixture has expected characteristics
- Script is idempotent (safe to run multiple times)

#### Scenario: Multi-install script

**GIVEN** test-env/automation/run-multi-install.sh exists
**WHEN** running script
**THEN**:
- 13 installation scenarios tested
- Each in isolated temp directory
- Performance benchmarks generated
- All temp directories cleaned up

### Requirement: Test Coverage

The system MUST achieve 95%+ test coverage with 50+ test files.

#### Scenario: Edge case coverage complete

**GIVEN** 8 edge case test categories
**WHEN** running `bash test-env/automation/run-matrix.sh`
**THEN**:
- All 40+ edge case tests pass
- 100% of identified edge cases covered
- No edge case failures

#### Scenario: Integration test coverage complete

**GIVEN** 6 integration test categories
**WHEN** running integration tests
**THEN**:
- All 25+ integration tests pass
- npm, npx, curl installation flows validated
- Multi-agent combinations validated

## Notes

**Implementation phases**:
- Phase 1-5 (13-17 hours): Test infrastructure, fixtures, edge/integration tests, automation
- Phase 6 (40-56 hours): Improvements (P1: security/backup, P2: UX, P3: reliability, P4: features)

**Success criteria**:
- Test files: 50+ (from 9)
- Coverage: ~95% (from ~30%)
- Edge cases: 100% (from 0%)
- Security: 100% injection attempts blocked
- Platforms: Automated across 3 OS × 2 Node × 3 PKG

**References**:
- Research: `docs/research/test-environment.md`
- Design: `openspec/changes/test-environment/design.md`
- Tasks: `openspec/changes/test-environment/tasks.md`
- Proposal: `openspec/changes/test-environment/proposal.md`
