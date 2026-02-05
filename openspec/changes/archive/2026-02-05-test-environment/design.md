# Design: Comprehensive Test Environment

## Overview

This design documents the technical decisions for implementing a comprehensive test environment for the Forge workflow project. The design focuses on zero-dependency testing, isolated fixtures, and automated validation across platforms.

## Key Design Decisions

### 1. Test Framework Choice

**Decision**: Use Node.js built-in `node:test` with `node:assert/strict`

**Rationale**:
- Consistency with existing 9 test files
- Zero external dependencies (aligns with project philosophy)
- Fast, lightweight
- Built into Node.js 20+ (our minimum version)
- Standard assert library sufficient for our needs

**Implementation**:
```javascript
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('Feature', () => {
  test('should validate input', () => {
    const result = validateInput('test');
    assert.strictEqual(result.valid, true);
  });
});
```

**Alternatives rejected**:
- Jest: Too heavy, requires dependencies
- Vitest: Requires Vite setup
- Mocha/Chai: Additional dependencies

### 2. Test Isolation Strategy

**Decision**: Temp directory per test with automatic cleanup

**Rationale**:
- Prevents test pollution
- Enables parallel execution
- Safe to run repeatedly
- Matches existing rollback test pattern

**Implementation**:
```javascript
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

describe('Installation', () => {
  let testDir;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'forge-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('should install in isolated directory', () => {
    // Test runs in testDir
  });
});
```

**Edge case handling**:
- Cleanup failures: Use `force: true` to ignore ENOENT
- Permission errors: Catch and log, don't fail test suite
- Windows paths: Use `path.join()` for cross-platform compatibility

### 3. Fixture Management

**Decision**: Pre-created fixtures via shell script, reused across tests

**Rationale**:
- Faster test execution (no setup time per test)
- Consistent test environments
- Easy to add new scenarios
- Can be version controlled

**Directory structure**:
```
test-env/fixtures/
├── fresh-project/           # Empty directory + git init
├── existing-forge-v1/       # Simulated v1 installation
├── partial-install/         # Corrupted state (some files missing)
├── conflicting-configs/     # Both AGENTS.md + CLAUDE.md
├── read-only-dirs/          # .claude with 444 permissions
├── no-git/                  # No .git directory
├── dirty-git/               # Uncommitted changes
├── detached-head/           # Git detached HEAD
├── merge-conflict/          # Active merge conflict
├── monorepo/                # pnpm workspace
├── nextjs-project/          # Fresh Next.js structure
├── nestjs-project/          # Fresh NestJS structure
├── unicode-paths/           # Special characters
├── large-agents-md/         # AGENTS.md 300+ lines
└── missing-prerequisites/   # Docker container simulation
```

**Setup script**: `test-env/automation/setup-fixtures.sh`

**Usage in tests**:
```javascript
const fixturePath = path.join(__dirname, '../../fixtures/fresh-project');
// Copy fixture to temp dir
fs.cpSync(fixturePath, testDir, { recursive: true });
```

### 4. Validation Helper Architecture

**Decision**: Four specialized validation modules with unified interface

**Modules**:
1. **file-checker.js** - File existence, content, symlinks
2. **git-state-checker.js** - Repository state, branches, commits
3. **agent-validator.js** - Agent configs for all 11 agents
4. **env-validator.js** - .env.local format and preservation

**Unified interface**:
```javascript
// Each validator exports functions that return:
{
  passed: boolean,
  failures: [
    { path: 'file.txt', reason: 'File not found' }
  ],
  coverage: 0.95 // 95% of checks passed
}
```

**Example - file-checker.js**:
```javascript
function validateInstallation(agent, scenario) {
  const expectedFiles = getExpectedFiles(agent);

  const results = expectedFiles.map(file => ({
    path: file.path,
    exists: fs.existsSync(file.path),
    valid: file.validate ? file.validate(file.path) : true
  }));

  return {
    passed: results.every(r => r.exists && r.valid),
    failures: results.filter(r => !r.exists || !r.valid),
    coverage: results.filter(r => r.exists && r.valid).length / results.length
  };
}
```

### 5. Security Validation Pattern

**Decision**: Follow existing pattern from `test/rollback-edge-cases.test.js`

**Pattern**:
```javascript
function validateInput(type, value) {
  // Type-specific validation
  if (type === 'path') {
    // Shell injection
    if (/[;|&$`()<>\r\n]/.test(value)) {
      return { valid: false, error: 'Invalid characters' };
    }

    // Path traversal
    const resolved = path.resolve(projectRoot, value);
    if (!resolved.startsWith(projectRoot)) {
      return { valid: false, error: 'Path outside project' };
    }

    // Non-ASCII
    if (!/^[\x20-\x7E]+$/.test(value)) {
      return { valid: false, error: 'Only ASCII allowed' };
    }
  }

  return { valid: true };
}
```

**Applied to**:
- Installation paths (`--path` flag)
- Agent selection names
- File paths in partial rollback
- API keys in .env.local
- Plugin JSON file paths

**Test coverage**:
- Shell injection: semicolon, pipe, ampersand, dollar, backtick
- Path traversal: `../`, encoded `%2e%2e%2f`, Windows `..\\`
- Unicode injection: emoji, null bytes, non-ASCII
- Edge cases: empty strings, whitespace-only, too long

### 6. Multi-Installation Testing Strategy

**Decision**: 13 representative scenarios (not all 132 combinations)

**Scenarios**:
1-4. **Package managers**: npm, yarn, pnpm, bun
5-7. **Frameworks**: Next.js, NestJS, React+Vite
8-9. **Monorepos**: pnpm workspace, Yarn workspaces
10-12. **Installation modes**: postinstall, interactive, quick
13. **Upgrade**: v1 → v2

**Automation**:
```bash
#!/bin/bash
# test-env/automation/run-multi-install.sh

for scenario in npm yarn pnpm bun nextjs nestjs react monorepo upgrade; do
  echo "Testing: $scenario"

  # Create temp directory
  TEST_DIR=$(mktemp -d)
  cd "$TEST_DIR"

  # Setup scenario
  setup_$scenario

  # Run installation
  case $scenario in
    npm|yarn|pnpm|bun)
      $scenario install forge-workflow
      ;;
    *)
      npm install forge-workflow
      npx forge setup --quick
      ;;
  esac

  # Validate
  validate_installation $scenario

  # Cleanup
  cd /
  rm -rf "$TEST_DIR"
done
```

### 7. Backup System Architecture

**Decision**: Timestamped backup directory with rollback capability

**Directory structure**:
```
.forge/backups/
├── 2026-02-03T16-30-00/
│   ├── AGENTS.md
│   ├── .claude/commands/*.md
│   └── manifest.json (metadata)
├── 2026-02-03T15-45-00/
└── ...
```

**Manifest format**:
```json
{
  "timestamp": "2026-02-03T16:30:00Z",
  "files": [
    {
      "path": "AGENTS.md",
      "size": 12450,
      "sha256": "abc123..."
    }
  ],
  "operation": "forge setup --quick"
}
```

**Rollback command**:
```bash
npx forge rollback --backup 2026-02-03T16-30-00
```

**Implementation** (`bin/forge.js`):
```javascript
function createBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join('.forge', 'backups', timestamp);

  fs.mkdirSync(backupDir, { recursive: true });

  // Backup files that will be overwritten
  const filesToBackup = detectFilesToOverwrite();
  const manifest = { timestamp, files: [], operation: process.argv.join(' ') };

  for (const file of filesToBackup) {
    const dest = path.join(backupDir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);

    manifest.files.push({
      path: file,
      size: fs.statSync(file).size,
      sha256: calculateSHA256(file)
    });
  }

  fs.writeFileSync(
    path.join(backupDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  // Cleanup old backups (keep last 5)
  cleanupOldBackups();

  return backupDir;
}
```

**Auto-cleanup**: Keep last 5 backups, remove older ones

### 8. Atomic Installation with Rollback

**Decision**: Transaction-like installation using staging directory

**Flow**:
```
1. Create staging directory: .forge/staging-<timestamp>/
2. Write all files to staging
3. On success:
   - Create backup of existing files
   - Move from staging to final locations (atomic)
   - Remove staging directory
4. On failure:
   - Log error
   - Remove staging directory
   - Restore from backup (if backup was created)
```

**Implementation**:
```javascript
async function atomicInstall(agents) {
  const stagingDir = path.join('.forge', `staging-${Date.now()}`);
  let backupDir = null;

  try {
    // Stage all file operations
    fs.mkdirSync(stagingDir, { recursive: true });

    for (const agent of agents) {
      await writeAgentFiles(agent, stagingDir);
    }

    // Verify staging
    const validation = validateStaging(stagingDir);
    if (!validation.passed) {
      throw new Error(`Staging validation failed: ${validation.failures}`);
    }

    // Backup existing files
    backupDir = createBackup();
    console.log(`Backup created: ${backupDir}`);

    // Atomic move (rename is atomic on same filesystem)
    for (const file of getStagedFiles(stagingDir)) {
      const src = path.join(stagingDir, file);
      const dest = file;

      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
    }

    // Success - remove staging
    fs.rmSync(stagingDir, { recursive: true });

    console.log('✓ Installation complete');

  } catch (error) {
    console.error('Installation failed:', error.message);

    // Rollback
    if (backupDir) {
      console.log(`Rolling back from ${backupDir}...`);
      restoreBackup(backupDir);
    }

    // Cleanup staging
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true });
    }

    throw error;
  }
}
```

**Benefits**:
- All-or-nothing installation
- Safe from partial failures
- Easy to rollback
- User data protected

### 9. CI/CD Matrix Testing

**Decision**: GitHub Actions with 3-dimensional matrix

**Matrix dimensions**:
- OS: `[ubuntu-latest, macos-latest, windows-latest]`
- Node: `[20.x, 22.x]`
- Package Manager: `[npm, yarn, pnpm]` (bun excluded - not stable on all OS)

**Total combinations**: 3 × 2 × 3 = 18 jobs

**Workflow** (`.github/workflows/test-env.yml`):
```yaml
name: Test Environment

on:
  pull_request:
    paths:
      - 'bin/**'
      - 'lib/**'
      - 'test/**'
      - 'test-env/**'
  workflow_dispatch:
  schedule:
    - cron: '0 0 * * 0'  # Weekly on Sunday

jobs:
  test-matrix:
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [20.x, 22.x]
        pkg-manager: [npm, yarn, pnpm]

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}

      - name: Install package manager
        run: npm install -g ${{ matrix.pkg-manager }}

      - name: Run tests
        run: npm test

      - name: Run multi-installation tests
        run: bash test-env/automation/run-multi-install.sh

      - name: Generate report
        if: always()
        run: node test-env/automation/report-generator.js

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-report-${{ matrix.os }}-node${{ matrix.node }}-${{ matrix.pkg-manager }}
          path: test-env/reports/
```

## Performance Targets

- **Quick mode installation**: < 30 seconds
- **Interactive installation**: 2-5 minutes (acceptable due to user input)
- **Test execution (local)**: < 2 minutes
- **Test execution (CI/CD)**: < 5 minutes per job
- **Full CI/CD matrix**: < 10 minutes total (parallel jobs)

## Security Considerations

1. **Input validation**: All user inputs validated before use
2. **Path safety**: No path traversal, stays within project root
3. **Shell safety**: No shell injection, use `execFileSync` with hardcoded commands
4. **API keys**: Never logged, stored in .env.local (gitignored)
5. **Backup data**: Protected, checksummed, auto-cleanup

## Error Handling Strategy

**Philosophy**: Clear error messages with actionable fixes

**Pattern**:
```javascript
try {
  performOperation();
} catch (error) {
  console.error(`Error: ${error.message}`);
  console.error('');
  console.error('Possible fixes:');
  console.error('  1. Check file permissions');
  console.error('  2. Ensure git repository is initialized');
  console.error('  3. Run: npx forge doctor');
  console.error('');
  console.error('For help, see: docs/TROUBLESHOOTING.md');

  process.exit(1);
}
```

## Monitoring and Observability

- **Test reports**: HTML reports with pass/fail counts, coverage, benchmarks
- **CI/CD artifacts**: Saved for 30 days, downloadable
- **Performance tracking**: Benchmark file sizes, installation times
- **Failure analysis**: Categorize failures (network, permissions, git, validation)

## Backwards Compatibility

- No breaking changes to existing installation flows
- All new features opt-in or backward-compatible
- Existing tests continue to work
- New tests use same patterns (Node.js `node:test`)

## Rollout Strategy

1. **Phase 1-5** (immediate): Test infrastructure, no user-facing changes
2. **Phase 6 (P1)**: Critical improvements, gradual rollout with feature flags
3. **Phase 6 (P2-P4)**: UX and reliability improvements, incremental

## Success Metrics

Refer to proposal.md for success metrics and approval checklist.
