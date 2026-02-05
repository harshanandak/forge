// Test: setup-fixtures.sh
// Validates that all 15 test fixtures are created correctly

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// SECURITY: Using execSync with HARDCODED script path only (no user input)
const { execSync } = require('node:child_process');

// Import validation helpers from Phase 1
const { checkGitState, isDetachedHead, hasUncommittedChanges, hasMergeConflict } = require('../validation/git-state-checker.js');
const { validateFile } = require('../validation/file-checker.js');
const { validateEnvFile } = require('../validation/env-validator.js');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const SETUP_SCRIPT = path.join(__dirname, 'setup-fixtures.sh');

const EXPECTED_FIXTURES = [
  'fresh-project', 'existing-forge-v1', 'partial-install', 'conflicting-configs',
  'read-only-dirs', 'no-git', 'dirty-git', 'detached-head', 'merge-conflict',
  'monorepo', 'nextjs-project', 'nestjs-project', 'unicode-paths',
  'large-agents-md', 'missing-prerequisites'
];

before(() => {
  try { fs.chmodSync(SETUP_SCRIPT, 0o755); } catch (error) { }
  try {
    execSync('bash setup-fixtures.sh', { cwd: __dirname, stdio: 'pipe' });
  } catch (error) { console.error('Failed to run setup-fixtures.sh:', error.message); }
});

describe('setup-fixtures.sh', () => {
  test('should create all 15 fixtures', () => {
    for (const fixture of EXPECTED_FIXTURES) {
      const fixturePath = path.join(FIXTURES_DIR, fixture);
      assert.ok(fs.existsSync(fixturePath), `Fixture should exist: ${fixture}`);
    }
  });

  describe('Fixture: fresh-project', () => {
    const fixturePath = path.join(FIXTURES_DIR, 'fresh-project');
    test('should have .git directory', () => {
      assert.ok(fs.existsSync(path.join(fixturePath, '.git')));
    });
    test('should have clean git state', () => {
      assert.strictEqual(checkGitState(fixturePath).passed, true);
    });
  });

  describe('Fixture: no-git', () => {
    const fixturePath = path.join(FIXTURES_DIR, 'no-git');
    test('should NOT have .git directory', () => {
      assert.strictEqual(fs.existsSync(path.join(fixturePath, '.git')), false);
    });
  });

  describe('Fixture: dirty-git', () => {
    test('should have uncommitted changes', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'dirty-git');
      const result = hasUncommittedChanges(fixturePath);
      assert.strictEqual(result.hasChanges, true);
    });
  });

  describe('Fixture: detached-head', () => {
    test('should be in detached HEAD state', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'detached-head');
      const result = isDetachedHead(fixturePath);
      assert.strictEqual(result.detached, true);
    });
  });

  describe('Fixture: merge-conflict', () => {
    test('should have active merge conflict', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'merge-conflict');
      const result = hasMergeConflict(fixturePath);
      assert.strictEqual(result.hasConflict, true);
    });
  });

  describe('Fixture: monorepo', () => {
    test('should have pnpm-workspace.yaml', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'monorepo');
      assert.ok(fs.existsSync(path.join(fixturePath, 'pnpm-workspace.yaml')));
    });
  });

  describe('Fixture: large-agents-md', () => {
    test('should have AGENTS.md with >300 lines', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'large-agents-md');
      const content = fs.readFileSync(path.join(fixturePath, 'AGENTS.md'), 'utf8');
      assert.ok(content.split('\n').length > 300);
    });
  });

  test('Idempotency: should be safe to run multiple times', () => {
    const result = execSync('bash setup-fixtures.sh', {
      cwd: __dirname, stdio: 'pipe', encoding: 'utf8'
    });
    assert.match(result, /Fixture already exists|Skipped/i);
  });
});
