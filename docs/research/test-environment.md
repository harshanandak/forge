# Research: Comprehensive Test Environment for Forge

**Date**: 2026-02-03
**Researcher**: AI Assistant
**Epic**: forge-hql
**Status**: Complete

## Executive Summary

Research into creating a comprehensive test environment for the Forge workflow project, covering installation flows, edge cases, onboarding processes, and multi-installation validation. The current test suite (9 files) needs expansion to 50+ tests with automated fixtures, security validation, and improvement recommendations.

## Problem Statement

Forge is a universal AI agent workflow tool supporting 11 agent plugins with complex installation flows. Current testing is insufficient:

- **Test coverage gaps**: Only 9 test files, missing edge cases like permissions, network failures, unicode handling
- **No multi-installation validation**: Not tested across npm/yarn/pnpm/bun or different frameworks
- **Manual onboarding testing**: No automated validation of 11 agent combinations
- **Security concerns**: Limited validation of user inputs, path traversal, injection attacks
- **No improvement tracking**: Need systematic identification of UX and reliability issues

## Current State Analysis

### Existing Test Infrastructure

**9 test files** (using Node.js `node:test`, no external dependencies):

1. `test/agents-md/structure.test.js` - AGENTS.md structure validation
2. `test/plugins/plugin-manager.test.js` - Plugin loading tests
3. `test/plugins/plugin-schema.test.js` - Plugin JSON schema validation
4. `test/validation/forge-validate.test.js` - CLI validation
5. `test/validation/git-hooks.test.js` - Lefthook configuration
6. `test/validation/project-tools.test.js` - Project tools detection
7. `test/rollback-validation.test.js` - Rollback input validation
8. `test/rollback-user-sections.test.js` - User section preservation
9. `test/rollback-edge-cases.test.js` - Security validation (434 lines)

**Coverage**: ~30% of critical flows

### Installation Entry Points

1. **Postinstall** (automatic): Creates AGENTS.md + docs/ (minimal)
2. **Interactive setup**: `npx forge setup` (full agent selection)
3. **Quick mode**: `npx forge setup --quick` (all defaults)
4. **Curl install**: `install.sh` (bash script, 1063 lines)

### Critical Files

- `bin/forge.js` (3,771 lines) - Main CLI, all flows
- `bin/forge-validate.js` (303 lines) - Validation CLI
- `lib/plugin-manager.js` (115 lines) - Plugin loading
- `install.sh` (1,063 lines) - Curl installation
- 11 plugin files in `lib/agents/*.plugin.json`

### Known Edge Cases (Discovered)

From code analysis, these edge cases exist but lack tests:

1. **Prerequisites**: Missing git, gh, Node < 20, no package manager
2. **Permissions**: Read-only directories, locked files
3. **Git states**: Detached HEAD, uncommitted changes, merge conflicts
4. **Partial install**: Some files exist, others missing
5. **Conflicts**: Both AGENTS.md and CLAUDE.md present
6. **File limits**: AGENTS.md > 200 lines (warning triggers)
7. **Unicode/special chars**: Not validated in paths
8. **Network failures**: No timeout handling visible
9. **Invalid JSON**: Plugin validation exists but not comprehensive
10. **Path traversal**: Some validation in rollback, needs expansion

## Research Findings

### 1. Security Validation Patterns

**Good pattern found**: `test/rollback-edge-cases.test.js:10-54`

```javascript
function validateRollbackInput(method, target) {
  // Validates:
  // - Commit hash format (4-40 hex chars)
  // - Shell injection characters (;|&$`()<>)
  // - Path traversal (../, URL-encoded)
  // - Non-ASCII characters
  // - NULL bytes

  // Returns: { valid: boolean, error?: string }
}
```

**Tests cover**:
- Shell injection via semicolon, pipe, ampersand, dollar, backtick
- Path traversal attempts (simple, encoded, Windows-style)
- Unicode injection
- File path validation (within project root)

**Should apply to**:
- Installation target paths (`--path` flag)
- Agent selection names
- File paths in partial rollback
- API keys in .env.local
- Plugin JSON file paths

### 2. Installation Flow Complexity

**Three installation modes**:

```
Mode 1: Postinstall (automatic)
  npm install forge-workflow
  ↓
  Creates: AGENTS.md + docs/ only
  Duration: ~5 seconds
  Files created: ~5

Mode 2: Interactive Setup
  npx forge setup
  ↓
  Prompts: Agent selection (11 options)
  Prompts: File overwrites (if exists)
  Prompts: Beads/OpenSpec installation
  Prompts: External services (code review, quality, research)
  ↓
  Creates: Agent-specific dirs + configs
  Duration: 2-5 minutes (interactive)
  Files created: 5-50 depending on agents

Mode 3: Quick Mode
  npx forge setup --quick
  ↓
  Defaults: All agents, GitHub Code Quality, ESLint
  No prompts (except file overwrites)
  Duration: ~30 seconds
  Files created: ~50
```

**Complexity points**:
- File overwrite handling (backup, prompt, merge)
- USER section preservation in AGENTS.md
- .env.local preservation of existing vars
- Symlink fallback to copy on Windows
- Plugin JSON validation and loading
- Smart project type detection (Next.js, NestJS, etc.)

### 3. Multi-Agent Combinations

**11 agents = 2,047 possible combinations** (2^11 - 1)

Realistic sampling strategy:
- Single agent: 11 tests
- Popular pairs: Claude+Cursor, Claude+Continue, Cursor+Windsurf (3 tests)
- All agents: 1 test
- No agents: 1 test (error handling)

**Total: 16 representative tests** (covers ~80% of use cases)

### 4. Package Manager Detection

**Code**: `install.sh:114-138` and `bin/forge.js:detectPackageManager()`

**Detection logic**:
1. Check lock files (bun.lockb, pnpm-lock.yaml, yarn.lock, package-lock.json)
2. Check commands available (bun, pnpm, yarn, npm)
3. Priority: bun > pnpm > yarn > npm

**Edge cases**:
- Monorepo with mixed package managers
- Missing lock file but command available
- Multiple lock files (corrupted state)
- No package manager installed

### 5. Framework Detection Accuracy

**Code**: `bin/forge.js:detectProjectType()`

**Detects**:
- Next.js (next.config.js, next.config.mjs)
- NestJS (@nestjs/core in dependencies)
- React (react in dependencies)
- Vue (vue in dependencies)
- Angular (angular.json)
- Remix (remix.config.js)
- SvelteKit (svelte.config.js)
- Astro (astro.config.mjs)

**Adds framework-specific tips to AGENTS.md**

**Edge cases**:
- Multiple frameworks in monorepo
- Framework migration in progress
- Custom build configurations

### 6. External Services Configuration

**Four service categories**:

1. **Code Review** (3 options + skip):
   - GitHub Code Quality (free, default)
   - CodeRabbit (free for OSS)
   - Greptile (paid, requires API key)

2. **Code Quality** (3 options + skip):
   - ESLint only (free, default)
   - SonarCloud (50k LoC free)
   - SonarQube Community (self-hosted)

3. **Research Tool** (2 options):
   - Manual (default)
   - Parallel AI (requires API key)

4. **Context7 MCP**:
   - Auto-installed for Claude Code (.mcp.json)
   - Auto-installed for Continue (.continue/config.yaml)
   - Manual setup for others

**Edge cases**:
- API key validation (no network validation currently)
- .env.local already exists with custom vars
- Service requires additional setup (Docker for SonarQube)

### 7. Backup and Recovery

**Current state**:
- AGENTS.md backed up before overwrite: `AGENTS.md.backup`
- No comprehensive backup system
- No rollback capability (except git)

**Needed**:
- Transaction-like installation (all-or-nothing)
- Backup directory with timestamp
- Rollback command: `npx forge rollback --backup <timestamp>`
- Keep last 5 backups, auto-cleanup

### 8. Performance Characteristics

**Measured from code**:

- Plugin loading: O(n) where n=11 plugins (fast)
- File downloads: Serial, not parallel (slow)
- File writes: Serial (could parallelize)
- Git operations: Blocking (necessary)

**Targets**:
- Quick mode: < 30 seconds
- Interactive mode: 2-5 minutes (acceptable)
- Postinstall: < 10 seconds

**Bottlenecks**:
- Network requests (curl downloads in install.sh)
- Git operations (gh pr create, git push)
- User input waits (interactive prompts)

## Key Decisions

### 1. Test Framework Choice

**Decision**: Use Node.js built-in `node:test` (no external dependencies)

**Rationale**:
- Already used in 9 existing tests
- No npm install needed (zero dependencies)
- Fast, lightweight
- Standard assert library sufficient

**Alternatives considered**:
- Jest (too heavy, requires setup)
- Vitest (requires Vite)
- Mocha (requires install)

### 2. Test Isolation Strategy

**Decision**: Use temp directories per test, cleanup after

**Rationale**:
- Prevents test pollution
- Allows parallel execution
- Safe to run repeatedly
- Matches current pattern

**Implementation**:
```javascript
const { mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const testDir = mkdtempSync(join(tmpdir(), 'forge-test-'));
// Run test in testDir
// Cleanup: fs.rmSync(testDir, { recursive: true })
```

### 3. Fixture Management

**Decision**: Create fixtures once via script, reuse across tests

**Rationale**:
- Faster test execution
- Consistent test environments
- Easy to add new fixtures

**Script**: `automation/setup-fixtures.sh`

### 4. Security Test Approach

**Decision**: Follow pattern from `test/rollback-edge-cases.test.js`

**Rationale**:
- Already proven pattern
- Comprehensive coverage (43 security tests)
- Clear test naming
- Returns validation objects

**Expand to**:
- Installation paths
- Agent names
- API keys
- File paths

### 5. Multi-Installation Testing

**Decision**: Use Docker containers for prerequisite testing

**Rationale**:
- Can simulate missing git, gh, Node versions
- Isolated environments
- Reproducible

**Alternatives**:
- Mock commands (doesn't test real behavior)
- Manual VMs (slow, not reproducible)

### 6. Improvement Prioritization

**Decision**: Four-tier priority system (P1-P4)

**P1 (Critical)**: Security, data loss prevention
**P2 (High)**: User experience, error messages
**P3 (Medium)**: Testing, reliability
**P4 (Low)**: Nice-to-have features

**Rationale**:
- Focuses on impact
- Clear implementation order
- Balances short-term and long-term

### 7. Reporting Format

**Decision**: HTML report with interactive sections

**Rationale**:
- Easy to share
- Visual representation
- Can drill down into failures
- Includes benchmarks

**Libraries**: None (generate raw HTML)

### 8. CI/CD Integration

**Decision**: GitHub Actions with matrix testing

**Matrix**:
- OS: Ubuntu, macOS, Windows
- Node: 20.x, 22.x
- Package Manager: npm, yarn, pnpm

**Rationale**:
- Covers 80% of users
- Catches platform-specific bugs
- Automated on every PR

## Risks and Mitigations

### Risk 1: Test execution time too long

**Impact**: Medium
**Probability**: High

**Mitigation**:
- Run edge case tests in parallel
- Use test fixtures (not fresh setup each time)
- Skip slow tests in pre-commit hook
- Full suite only on CI/CD

### Risk 2: Docker dependency for prerequisite tests

**Impact**: Medium
**Probability**: Medium

**Mitigation**:
- Make Docker tests optional
- Provide mock alternative
- Document Docker setup clearly

### Risk 3: Windows compatibility issues

**Impact**: High
**Probability**: Medium

**Mitigation**:
- Test on Windows in CI/CD
- Handle symlink failures (already done)
- Path normalization (use `path.join()`)

### Risk 4: Breaking changes during improvement implementation

**Impact**: High
**Probability**: Low

**Mitigation**:
- Comprehensive tests before changes
- Feature flags for new features
- Gradual rollout (start with P1)
- Backup system (ironically, solving this risk is P1)

## Recommended Approach

### Phase 1: Test Infrastructure (Immediate)

**Goal**: Create test environment and fixtures

1. Create `test-env/` directory structure
2. Build 15 test fixtures
3. Create 4 validation helpers
4. Write 4 automation scripts

**Duration**: 2-3 hours
**Deliverable**: Test infrastructure ready

### Phase 2: Edge Case Tests (Immediate)

**Goal**: Expand test coverage to 50+ tests

1. Create 8 edge case test files
2. Create 6 integration test files
3. Create 11 agent validation tests
4. Create 4 package manager tests

**Duration**: 12-15 hours
**Deliverable**: Comprehensive test suite

### Phase 3: Multi-Installation Testing (Immediate)

**Goal**: Validate across platforms and scenarios

1. Create `run-multi-install.sh` script
2. Test 13 installation scenarios
3. Generate performance benchmarks
4. Create HTML report generator

**Duration**: 3-4 hours
**Deliverable**: Automated validation across scenarios

### Phase 4: Critical Improvements (Priority 1)

**Goal**: Security and data loss prevention

1. Implement backup system
2. Implement atomic installation
3. Enhance security validation

**Duration**: 10-13 hours
**Deliverable**: Production-ready reliability

### Phase 5: UX Improvements (Priority 2)

**Goal**: Better error handling and recovery

1. Create `forge doctor` command
2. Interactive recovery mode
3. Progress indication

**Duration**: 9-12 hours
**Deliverable**: Better user experience

## Success Metrics

1. **Test coverage**: 50+ test files (from 9)
2. **Edge case coverage**: 100% of identified edge cases tested
3. **Security validation**: 100% of injection attempts blocked
4. **Installation success rate**: 99%+ across 13 scenarios
5. **Performance**: Quick mode < 30 seconds
6. **User satisfaction**: Clear error messages, recovery options

## Next Steps

1. Create Beads epic: `bd create "Comprehensive test environment"`
2. Create branch: `git checkout -b feat/test-environment`
3. Implement Phase 1 (test infrastructure)
4. Implement Phase 2 (edge case tests)
5. Implement Phase 3 (multi-installation)
6. Generate first report
7. Review with team
8. Implement Phase 4-5 based on priorities

## References

- Forge codebase: `bin/forge.js`, `bin/forge-validate.js`, `lib/plugin-manager.js`
- Security test pattern: `test/rollback-edge-cases.test.js`
- Installation script: `install.sh`
- Plugin definitions: `lib/agents/*.plugin.json`

## Appendix: Test Scenarios Matrix

| Category | Scenario | Files Affected | Priority |
|----------|----------|----------------|----------|
| Prerequisites | Missing git | bin/forge.js:146-200 | P1 |
| Prerequisites | Node < 20 | bin/forge.js:146-200 | P1 |
| Prerequisites | No package manager | install.sh:114-138 | P1 |
| Permissions | Read-only .claude/ | bin/forge.js (multiple) | P1 |
| Git States | Detached HEAD | bin/forge.js (git ops) | P2 |
| Git States | Uncommitted changes | bin/forge.js (git ops) | P2 |
| Git States | Merge conflict | bin/forge.js (git ops) | P2 |
| Partial Install | Missing commands | bin/forge.js:400-406 | P1 |
| Conflicts | Both AGENTS + CLAUDE | bin/forge.js:275-340 | P2 |
| File Limits | AGENTS.md > 200 lines | test/agents-md/structure.test.js | P3 |
| Security | Shell injection | All user inputs | P1 |
| Security | Path traversal | File operations | P1 |
| Security | Unicode injection | All user inputs | P1 |
| Network | npm install timeout | install.sh:280-290 | P2 |
| Network | API validation failure | bin/forge.js:2800-3000 | P3 |

**Total scenarios**: 15 fixtures + 40+ test cases = 55+ tests needed
