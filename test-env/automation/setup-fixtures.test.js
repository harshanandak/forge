// Test: setup-fixtures.sh
// Validates that all 15 test fixtures are created correctly

import { describe, test, expect } from 'bun:test';
const fs = require('node:fs');
const path = require('node:path');
// SECURITY: Using execSync with HARDCODED script path only (no user input)
const { execFileSync } = require('node:child_process');
const { resolveBashCommand } = require('../../test/helpers/bash.js');
const { ensureTestFixtures, FIXTURES_DIR } = require('../helpers/fixtures.js');

// Import validation helpers from Phase 1
const { checkGitState, isDetachedHead, hasUncommittedChanges, hasMergeConflict } = require('../validation/git-state-checker.js');
const { validateFile: _validateFile } = require('../validation/file-checker.js');
const { validateEnvFile: _validateEnvFile } = require('../validation/env-validator.js');

const SETUP_SCRIPT = path.join(__dirname, 'setup-fixtures.sh');

const EXPECTED_FIXTURES = [
  'fresh-project', 'existing-forge-v1', 'partial-install', 'conflicting-configs',
  'read-only-dirs', 'no-git', 'dirty-git', 'detached-head', 'merge-conflict',
  'monorepo', 'nextjs-project', 'nestjs-project', 'unicode-paths',
  'large-agents-md', 'missing-prerequisites'
];

ensureTestFixtures();

describe('setup-fixtures.sh', () => {
  test('should create all 15 fixtures', () => {
    for (const fixture of EXPECTED_FIXTURES) {
      const fixturePath = path.join(FIXTURES_DIR, fixture);
      expect(fs.existsSync(fixturePath)).toBeTruthy();
    }
  });

  describe('Fixture: fresh-project', () => {
    const fixturePath = path.join(FIXTURES_DIR, 'fresh-project');
    test('should have .git directory', () => {
      expect(fs.existsSync(path.join(fixturePath, '.git'))).toBeTruthy();
    });
    test('should have clean git state', () => {
      expect(checkGitState(fixturePath).passed).toBe(true);
    });
  });

  describe('Fixture: no-git', () => {
    const fixturePath = path.join(FIXTURES_DIR, 'no-git');
    test('should NOT have .git directory', () => {
      expect(fs.existsSync(path.join(fixturePath, '.git'))).toBe(false);
    });
  });

  describe('Fixture: dirty-git', () => {
    test('should have uncommitted changes', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'dirty-git');
      const result = hasUncommittedChanges(fixturePath);
      expect(result.hasChanges).toBe(true);
    });
  });

  describe('Fixture: detached-head', () => {
    test('should be in detached HEAD state', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'detached-head');
      const result = isDetachedHead(fixturePath);
      expect(result.detached).toBe(true);
    });
  });

  describe('Fixture: merge-conflict', () => {
    test('should have active merge conflict', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'merge-conflict');
      const result = hasMergeConflict(fixturePath);
      expect(result.hasConflict).toBe(true);
    });
  });

  describe('Fixture: monorepo', () => {
    test('should have pnpm-workspace.yaml', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'monorepo');
      expect(fs.existsSync(path.join(fixturePath, 'pnpm-workspace.yaml'))).toBeTruthy();
    });
  });

  describe('Fixture: large-agents-md', () => {
    test('should have AGENTS.md with >300 lines', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'large-agents-md');
      const content = fs.readFileSync(path.join(fixturePath, 'AGENTS.md'), 'utf8');
      expect(content.split('\n').length > 300).toBeTruthy();
    });
  });

  test('Idempotency: should be safe to run multiple times', () => {
    const result = execFileSync(resolveBashCommand(), [SETUP_SCRIPT], {
      cwd: __dirname, stdio: 'pipe', encoding: 'utf8'
    });
    expect(result).toMatch(/Fixture already exists|Skipped/i);
  });
});
