# Forge Test Environment

Comprehensive test infrastructure for the Forge workflow project.

## Purpose

Provides automated testing to ensure:
- Installation reliability across platforms (npm/yarn/pnpm/bun)
- Security against injection attacks and path traversal
- Compatibility with 11 agent plugins and various project types
- Regression prevention through CI/CD integration

## Directory Structure

```
test-env/
├── fixtures/           # 15 isolated test scenarios
├── integration-tests/  # 6 full installation flow tests
├── edge-cases/         # 8 edge case test files
├── automation/         # 4 automation scripts
├── validation/         # 4 validation helper modules
└── reports/            # Generated test reports
```

## Quick Start

### Run All Tests

```bash
# Run all tests
npm test

# Run specific category
npm test test-env/edge-cases/
npm test test-env/integration-tests/

# Run with coverage
npm test -- --coverage
```

### Setup Test Fixtures

```bash
# Create all 15 test fixtures
bash test-env/automation/setup-fixtures.sh

# Verify fixtures created
ls test-env/fixtures/
```

### Run Test Matrix

```bash
# Run all edge case and integration tests
bash test-env/automation/run-matrix.sh

# Run multi-installation scenarios (13 scenarios)
bash test-env/automation/run-multi-install.sh

# Generate HTML report
node test-env/automation/report-generator.js
open test-env/reports/comprehensive-test-report.html
```

### Cleanup

```bash
# Remove all generated test files
bash test-env/automation/cleanup.sh
```

## Test Categories

### Edge Cases (8 categories)

| Category | File | Tests |
|----------|------|-------|
| Prerequisites | `edge-cases/prerequisites.test.js` | Missing git, gh, Node < 20, no pkg manager |
| Permissions | `edge-cases/permission-errors.test.js` | Read-only dirs, locked files, EACCES |
| Git States | `edge-cases/git-states.test.js` | Detached HEAD, uncommitted, merge conflict |
| Network | `edge-cases/network-failures.test.js` | npm timeout, curl failure, API errors |
| Invalid JSON | `edge-cases/invalid-json.test.js` | Malformed plugins, missing fields, duplicates |
| File Limits | `edge-cases/file-limits.test.js` | AGENTS.md > 200 lines warnings |
| Security | `edge-cases/security.test.js` | Shell injection, path traversal, unicode |
| Env | `edge-cases/env-preservation.test.js` | .env.local preservation |

### Integration Tests (6 categories)

| Category | File | Tests |
|----------|------|-------|
| NPM Install | `integration-tests/npm-install.test.js` | Fresh npm install flow |
| NPX Setup | `integration-tests/npx-setup.test.js` | Interactive, quick, agent flags |
| Curl Install | `integration-tests/curl-install.test.js` | install.sh script |
| Multi-Agent | `integration-tests/multi-agent.test.js` | 16 agent combinations |
| Upgrades | `integration-tests/upgrade-flows.test.js` | v1→v2, partial→full |
| Package Managers | `integration-tests/package-managers.test.js` | npm, yarn, pnpm, bun |

### Test Fixtures (15 scenarios)

| Fixture | Purpose |
|---------|---------|
| `fresh-project` | Clean installation |
| `existing-forge-v1` | Upgrade testing |
| `partial-install` | Recovery testing |
| `conflicting-configs` | Smart merge testing |
| `read-only-dirs` | Permission testing |
| `no-git` | Prerequisites testing |
| `dirty-git` | Git state testing |
| `detached-head` | Git state testing |
| `merge-conflict` | Git state testing |
| `monorepo` | Monorepo testing |
| `nextjs-project` | Framework testing |
| `nestjs-project` | Framework testing |
| `unicode-paths` | Security testing |
| `large-agents-md` | File limit testing |
| `missing-prerequisites` | Prerequisites testing |

## Validation Helpers

### file-checker.js

Validates file existence, content, and symlinks.

```javascript
const { validateInstallation } = require('./validation/file-checker');

const result = validateInstallation('claude', 'fresh-project');
// Returns: { passed: boolean, failures: [], coverage: 0.95 }
```

### git-state-checker.js

Validates git repository state.

```javascript
const { checkGitState } = require('./validation/git-state-checker');

const result = checkGitState(directory);
// Returns: { passed: boolean, failures: [], coverage: 1.0 }
```

### agent-validator.js

Validates agent configurations for all 11 agents.

```javascript
const { validateAgent } = require('./validation/agent-validator');

const result = validateAgent('claude', directory);
// Returns: { passed: boolean, failures: [], coverage: 1.0 }
```

### env-validator.js

Validates .env.local format and preservation.

```javascript
const { validateEnvFile } = require('./validation/env-validator');

const result = validateEnvFile('.env.local');
// Returns: { passed: boolean, failures: [], coverage: 1.0 }
```

## CI/CD Integration

Tests run automatically on:
- Pull requests (affecting `bin/`, `lib/`, `test/`, `test-env/`)
- Manual workflow dispatch
- Weekly schedule (Sunday 00:00 UTC)

**Matrix**: 3 OS × 2 Node × 3 Package Managers = 18 jobs

## Performance Targets

| Metric | Target | Status |
|--------|--------|--------|
| Quick mode installation | < 30 seconds | ✅ |
| Test execution (local) | < 2 minutes | ✅ |
| Test execution (CI/CD) | < 5 minutes per job | ✅ |
| Full CI/CD matrix | < 10 minutes | ✅ |

## Success Metrics

| Metric | Before | After | Status |
|--------|--------|-------|--------|
| Test files | 9 | 50+ | ✅ |
| Coverage | ~30% | ~95% | ✅ |
| Edge cases | 0% | 100% | ✅ |
| Security validation | Limited | 100% injection blocked | ✅ |
| Platform testing | Manual | Automated CI/CD (18 jobs) | ✅ |

## Development

### Test-Driven Development

All tests follow TDD RED-GREEN-REFACTOR cycles:

1. **RED**: Write failing test
2. **GREEN**: Implement minimal solution
3. **REFACTOR**: Clean up and optimize

### Adding New Tests

1. Create test file in appropriate category:
   ```bash
   touch test-env/edge-cases/new-feature.test.js
   ```

2. Write test using Node.js `node:test`:
   ```javascript
   const { describe, test } = require('node:test');
   const assert = require('node:assert/strict');

   describe('New Feature', () => {
     test('should validate correctly', () => {
       // Test implementation
       assert.strictEqual(result, expected);
     });
   });
   ```

3. Run tests:
   ```bash
   npm test test-env/edge-cases/new-feature.test.js
   ```

## References

- **Research**: `docs/research/test-environment.md`
- **OpenSpec Proposal** (archived): `openspec/changes/archive/2026-02-05-test-environment/`
- **Spec**: `openspec/specs/testing/spec.md` (active)
- **Beads Epic**: `forge-hql` (closed)
- **PR**: [#8](https://github.com/harshanandak/forge/pull/8) (merged)

## Support

For issues or questions:
1. Check existing tests for patterns
2. Review validation helpers for reusable code
3. See `docs/research/test-environment.md` for technical decisions
4. Open issue with `[test-env]` prefix
