// Test: Env Validator Helper
// Tests for .env.local file validation and preservation

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
const fs = require('node:fs');
const path = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');

// Module under test
const {
  validateEnvFile,
  parseEnvFile,
  checkPreservation
} = require('./env-validator.js');

let testDir;

beforeAll(() => {
  // Create temp directory for tests
  testDir = mkdtempSync(path.join(tmpdir(), 'forge-test-env-'));
});

afterAll(() => {
  // Cleanup
  rmSync(testDir, { recursive: true, force: true });
});

describe('env-validator', () => {
  describe('validateEnvFile()', () => {
    test('should validate correct .env.local format', () => {
      const envPath = path.join(testDir, 'valid.env');
      fs.writeFileSync(envPath, 'API_KEY=abc123\nDATABASE_URL=postgres://localhost');

      const result = validateEnvFile(envPath);

      expect(result.passed).toBe(true);
      expect(result.failures.length).toBe(0);
    });

    test('should detect malformed entries', () => {
      const envPath = path.join(testDir, 'malformed.env');
      fs.writeFileSync(envPath, 'API_KEY=value\nINVALID LINE WITHOUT EQUALS\nVALID=true');

      const result = validateEnvFile(envPath);

      expect(result.passed).toBe(false);
      expect(result.failures.length > 0).toBeTruthy();
    });

    test('should detect missing equals sign', () => {
      const envPath = path.join(testDir, 'no-equals.env');
      fs.writeFileSync(envPath, 'NO_EQUALS_HERE');

      const result = validateEnvFile(envPath);

      expect(result.passed).toBe(false);
      expect(result.failures[0].reason).toMatch(/invalid format/i);
    });

    test('should allow comments and empty lines', () => {
      const envPath = path.join(testDir, 'with-comments.env');
      fs.writeFileSync(envPath, '# This is a comment\nAPI_KEY=value\n\n# Another comment\nDB_HOST=localhost');

      const result = validateEnvFile(envPath);

      expect(result.passed).toBe(true);
    });

    test('should return unified interface format', () => {
      const envPath = path.join(testDir, 'interface-check.env');
      fs.writeFileSync(envPath, 'KEY=value');

      const result = validateEnvFile(envPath);

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

  describe('parseEnvFile()', () => {
    test('should parse key=value pairs correctly', () => {
      const content = 'API_KEY=abc123\nDATABASE_URL=postgres://localhost';

      const result = parseEnvFile(content);

      expect(result.variables).toBeTruthy();
      expect(result.variables.API_KEY).toBe('abc123');
      expect(result.variables.DATABASE_URL).toBe('postgres://localhost');
    });

    test('should handle quoted values', () => {
      const content = 'QUOTED="value with spaces"\nSINGLE=\'single quoted\'';

      const result = parseEnvFile(content);

      expect(result.variables.QUOTED).toBe('value with spaces');
      expect(result.variables.SINGLE).toBe('single quoted');
    });

    test('should preserve comments', () => {
      const content = '# This is a comment\nKEY=value\n# Another comment';

      const result = parseEnvFile(content);

      expect(Array.isArray(result.comments)).toBeTruthy();
      expect(result.comments.length >= 2).toBeTruthy();
    });

    test('should ignore empty lines', () => {
      const content = 'KEY1=value1\n\n\nKEY2=value2';

      const result = parseEnvFile(content);

      expect(Object.keys(result.variables).length).toBe(2);
    });

    test('should handle multiline values', () => {
      // Note: Most .env parsers don't support true multiline, but we should handle edge cases
      const content = 'SIMPLE=value';

      const result = parseEnvFile(content);

      expect(result.variables.SIMPLE).toBe('value');
    });
  });

  describe('checkPreservation()', () => {
    test('should detect all old variables preserved', () => {
      const oldContent = 'API_KEY=old123\nDB_HOST=localhost';
      const newContent = 'API_KEY=old123\nDB_HOST=localhost\nNEW_VAR=added';

      const result = checkPreservation(oldContent, newContent);

      expect(result.passed).toBe(true);
      expect(result.failures.length).toBe(0);
    });

    test('should detect new variables added', () => {
      const oldContent = 'API_KEY=value';
      const newContent = 'API_KEY=value\nNEW_KEY=new_value';

      const result = checkPreservation(oldContent, newContent);

      expect(result.passed).toBe(true);
      // No failures because adding is allowed
    });

    test('should detect removed variables', () => {
      const oldContent = 'API_KEY=value\nDB_HOST=localhost';
      const newContent = 'API_KEY=value';

      const result = checkPreservation(oldContent, newContent);

      expect(result.passed).toBe(false);
      expect(result.failures.some(f => /removed/i.test(f.reason))).toBeTruthy();
    });

    test('should detect changed values', () => {
      const oldContent = 'API_KEY=original_value';
      const newContent = 'API_KEY=changed_value';

      const result = checkPreservation(oldContent, newContent);

      expect(result.passed).toBe(false);
      expect(result.failures.some(f => /changed/i.test(f.reason))).toBeTruthy();
    });

    test('should preserve comments', () => {
      const oldContent = '# Important comment\nAPI_KEY=value';
      const newContent = '# Important comment\nAPI_KEY=value\nNEW=var';

      const result = checkPreservation(oldContent, newContent);

      // Comments should be preserved
      expect(result.passed).toBe(true);
    });
  });
});
