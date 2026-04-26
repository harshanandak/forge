// Test: Agent Validator Helper
// Tests for validating agent configurations

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
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

beforeAll(() => {
  // Create temp directory for tests
  testDir = mkdtempSync(path.join(tmpdir(), 'forge-test-agent-'));
});

afterAll(() => {
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

      expect(typeof result.passed).toBe('boolean');
      expect(Array.isArray(result.failures)).toBeTruthy();
      expect(typeof result.coverage).toBe('number');
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

      expect(typeof result.passed).toBe('boolean');
      expect(Array.isArray(result.failures)).toBeTruthy();
    });

    test('should detect missing agent files', () => {
      const missingDir = path.join(testDir, 'missing-files');
      fs.mkdirSync(missingDir, { recursive: true });

      const result = validateAgent('claude', missingDir);

      expect(result.passed).toBe(false);
      expect(result.failures.length > 0).toBeTruthy();
    });

    test('should detect partial installation', () => {
      const partialDir = path.join(testDir, 'partial-install');
      fs.mkdirSync(partialDir, { recursive: true });

      // Create only some expected files
      fs.writeFileSync(path.join(partialDir, 'CLAUDE.md'), '# Partial');
      // Missing .claude/commands/ directory

      const result = validateAgent('claude', partialDir);

      expect(result.failures.length > 0).toBeTruthy();
      expect(result.coverage < 1.0).toBeTruthy();
    });

    test('should return unified interface format', () => {
      const formatDir = path.join(testDir, 'format-check');
      fs.mkdirSync(formatDir, { recursive: true });

      const result = validateAgent('claude', formatDir);

      // Check interface structure
      expect('passed' in result).toBeTruthy();
      expect('failures' in result).toBeTruthy();
      expect('coverage' in result).toBeTruthy();

      expect(typeof result.passed).toBe('boolean');
      expect(Array.isArray(result.failures)).toBeTruthy();
      expect(typeof result.coverage).toBe('number');
      expect(result.coverage >= 0 && result.coverage <= 1).toBeTruthy();
    });
  });

  describe('getExpectedFiles()', () => {
    test('should return expected files for Claude Code', () => {
      const files = getExpectedFiles('claude');

      expect(Array.isArray(files)).toBeTruthy();
      expect(files.length > 0).toBeTruthy();

      // Should include at least CLAUDE.md
      const hasClaudeMd = files.some(f => f.path && f.path.includes('CLAUDE.md'));
      expect(hasClaudeMd).toBeTruthy();
    });

    test('should return expected files for Cursor', () => {
      const files = getExpectedFiles('cursor');

      expect(Array.isArray(files)).toBeTruthy();
      expect(files.length > 0).toBeTruthy();

      // Should include .cursorrules (not CURSOR.md)
      const hasCursorRules = files.some(f => f.path && f.path.includes('.cursorrules'));
      expect(hasCursorRules).toBeTruthy();
    });

    test('should return expected files for all 8 agents', () => {
      const agents = [
        'claude', 'cursor', 'cline', 'opencode', 'copilot',
        'kilo-code', 'roo-code', 'codex'
      ];

      for (const agent of agents) {
        const files = getExpectedFiles(agent);
        expect(Array.isArray(files)).toBeTruthy();
      }
    });

    test('should return empty array for unknown agent', () => {
      const files = getExpectedFiles('unknown-agent-xyz');

      expect(Array.isArray(files)).toBeTruthy();
      expect(files.length).toBe(0);
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
      expect(result.coverage > 0.5).toBeTruthy();
    });

    test('should calculate partial coverage with some files missing', () => {
      const partialDir = path.join(testDir, 'partial-coverage');
      fs.mkdirSync(partialDir, { recursive: true });

      // Create only main config file
      fs.writeFileSync(path.join(partialDir, 'CLAUDE.md'), '# Claude');
      // Missing .claude directory and commands

      const result = validateAgent('claude', partialDir);

      // Coverage should be less than 1.0
      expect(result.coverage < 1.0).toBeTruthy();
      expect(result.coverage > 0).toBeTruthy();
    });
  });
});
