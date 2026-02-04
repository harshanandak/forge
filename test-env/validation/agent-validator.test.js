// Test: Agent Validator Helper
// Tests for validating agent configurations

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');

// Module under test
const {
  validateAgent,
  getExpectedFiles
} = require('./agent-validator.js');

let testDir;

before(() => {
  // Create temp directory for tests
  testDir = mkdtempSync(path.join(tmpdir(), 'forge-test-agent-'));
});

after(() => {
  // Cleanup
  rmSync(testDir, { recursive: true, force: true });
});

describe('agent-validator', () => {
  describe('validateAgent()', () => {
    test('should validate Claude Code installation', () => {
      const claudeDir = path.join(testDir, 'claude-install');
      fs.mkdirSync(claudeDir, { recursive: true });

      // Create expected Claude files
      fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '# Claude Project');
      const commandsDir = path.join(claudeDir, '.claude', 'commands');
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(path.join(commandsDir, 'status.md'), '# Status command');
      fs.writeFileSync(path.join(commandsDir, 'plan.md'), '# Plan command');

      const result = validateAgent('claude', claudeDir);

      assert.strictEqual(typeof result.passed, 'boolean');
      assert.ok(Array.isArray(result.failures));
      assert.strictEqual(typeof result.coverage, 'number');
    });

    test('should validate Cursor installation', () => {
      const cursorDir = path.join(testDir, 'cursor-install');
      fs.mkdirSync(cursorDir, { recursive: true });

      // Create expected Cursor files (.cursorrules is rootConfig, not CURSOR.md)
      fs.writeFileSync(path.join(cursorDir, '.cursorrules'), 'cursor rules');
      const rulesDir = path.join(cursorDir, '.cursor', 'rules');
      fs.mkdirSync(rulesDir, { recursive: true });
      const skillsDir = path.join(cursorDir, '.cursor', 'skills', 'forge-workflow');
      fs.mkdirSync(skillsDir, { recursive: true });

      const result = validateAgent('cursor', cursorDir);

      assert.strictEqual(typeof result.passed, 'boolean');
      assert.ok(Array.isArray(result.failures));
    });

    test('should validate Continue installation', () => {
      const continueDir = path.join(testDir, 'continue-install');
      fs.mkdirSync(continueDir, { recursive: true });

      // Create expected Continue files
      fs.writeFileSync(path.join(continueDir, 'CONTINUE.md'), '# Continue Project');
      const continueConfigDir = path.join(continueDir, '.continue');
      fs.mkdirSync(continueConfigDir, { recursive: true });
      fs.writeFileSync(path.join(continueConfigDir, 'config.json'), '{}');

      const result = validateAgent('continue', continueDir);

      assert.strictEqual(typeof result.passed, 'boolean');
      assert.ok(Array.isArray(result.failures));
    });

    test('should detect missing agent files', () => {
      const missingDir = path.join(testDir, 'missing-files');
      fs.mkdirSync(missingDir, { recursive: true });

      const result = validateAgent('claude', missingDir);

      assert.strictEqual(result.passed, false);
      assert.ok(result.failures.length > 0);
    });

    test('should detect partial installation', () => {
      const partialDir = path.join(testDir, 'partial-install');
      fs.mkdirSync(partialDir, { recursive: true });

      // Create only some expected files
      fs.writeFileSync(path.join(partialDir, 'CLAUDE.md'), '# Partial');
      // Missing .claude/commands/ directory

      const result = validateAgent('claude', partialDir);

      assert.ok(result.failures.length > 0);
      assert.ok(result.coverage < 1.0);
    });

    test('should return unified interface format', () => {
      const formatDir = path.join(testDir, 'format-check');
      fs.mkdirSync(formatDir, { recursive: true });

      const result = validateAgent('claude', formatDir);

      // Check interface structure
      assert.ok('passed' in result);
      assert.ok('failures' in result);
      assert.ok('coverage' in result);

      assert.strictEqual(typeof result.passed, 'boolean');
      assert.ok(Array.isArray(result.failures));
      assert.strictEqual(typeof result.coverage, 'number');
      assert.ok(result.coverage >= 0 && result.coverage <= 1);
    });
  });

  describe('getExpectedFiles()', () => {
    test('should return expected files for Claude Code', () => {
      const files = getExpectedFiles('claude');

      assert.ok(Array.isArray(files));
      assert.ok(files.length > 0);

      // Should include at least CLAUDE.md
      const hasClaudeMd = files.some(f => f.path && f.path.includes('CLAUDE.md'));
      assert.ok(hasClaudeMd);
    });

    test('should return expected files for Cursor', () => {
      const files = getExpectedFiles('cursor');

      assert.ok(Array.isArray(files));
      assert.ok(files.length > 0);

      // Should include .cursorrules (not CURSOR.md)
      const hasCursorRules = files.some(f => f.path && f.path.includes('.cursorrules'));
      assert.ok(hasCursorRules);
    });

    test('should return expected files for all 11 agents', () => {
      const agents = [
        'claude', 'cursor', 'continue', 'windsurf', 'cline',
        'roo-cline', 'void', 'pear', 'aider', 'aide', 'aws-q'
      ];

      for (const agent of agents) {
        const files = getExpectedFiles(agent);
        assert.ok(Array.isArray(files), `${agent} should return array`);
      }
    });

    test('should return empty array for unknown agent', () => {
      const files = getExpectedFiles('unknown-agent-xyz');

      assert.ok(Array.isArray(files));
      assert.strictEqual(files.length, 0);
    });
  });

  describe('coverage calculation', () => {
    test('should calculate coverage correctly with all files present', () => {
      const fullDir = path.join(testDir, 'full-install');
      fs.mkdirSync(fullDir, { recursive: true });

      // Create all expected files for cursor
      fs.writeFileSync(path.join(fullDir, '.cursorrules'), 'rules');
      const rulesDir = path.join(fullDir, '.cursor', 'rules');
      fs.mkdirSync(rulesDir, { recursive: true });
      const skillsDir = path.join(fullDir, '.cursor', 'skills', 'forge-workflow');
      fs.mkdirSync(skillsDir, { recursive: true });

      const result = validateAgent('cursor', fullDir);

      // Coverage should be high (close to 1.0)
      assert.ok(result.coverage > 0.5);
    });

    test('should calculate partial coverage with some files missing', () => {
      const partialDir = path.join(testDir, 'partial-coverage');
      fs.mkdirSync(partialDir, { recursive: true });

      // Create only main config file
      fs.writeFileSync(path.join(partialDir, 'CLAUDE.md'), '# Claude');
      // Missing .claude directory and commands

      const result = validateAgent('claude', partialDir);

      // Coverage should be less than 1.0
      assert.ok(result.coverage < 1.0);
      assert.ok(result.coverage > 0);
    });
  });
});
