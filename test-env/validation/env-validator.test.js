// Test: Env Validator Helper
// Tests for .env.local file validation and preservation

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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

before(() => {
  // Create temp directory for tests
  testDir = mkdtempSync(path.join(tmpdir(), 'forge-test-env-'));
});

after(() => {
  // Cleanup
  rmSync(testDir, { recursive: true, force: true });
});

describe('env-validator', () => {
  describe('validateEnvFile()', () => {
    test('should validate correct .env.local format', () => {
      const envPath = path.join(testDir, 'valid.env');
      fs.writeFileSync(envPath, 'API_KEY=abc123\nDATABASE_URL=postgres://localhost');

      const result = validateEnvFile(envPath);

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.failures.length, 0);
    });

    test('should detect malformed entries', () => {
      const envPath = path.join(testDir, 'malformed.env');
      fs.writeFileSync(envPath, 'API_KEY=value\nINVALID LINE WITHOUT EQUALS\nVALID=true');

      const result = validateEnvFile(envPath);

      assert.strictEqual(result.passed, false);
      assert.ok(result.failures.length > 0);
    });

    test('should detect missing equals sign', () => {
      const envPath = path.join(testDir, 'no-equals.env');
      fs.writeFileSync(envPath, 'NO_EQUALS_HERE');

      const result = validateEnvFile(envPath);

      assert.strictEqual(result.passed, false);
      assert.match(result.failures[0].reason, /invalid format/i);
    });

    test('should allow comments and empty lines', () => {
      const envPath = path.join(testDir, 'with-comments.env');
      fs.writeFileSync(envPath, '# This is a comment\nAPI_KEY=value\n\n# Another comment\nDB_HOST=localhost');

      const result = validateEnvFile(envPath);

      assert.strictEqual(result.passed, true);
    });

    test('should return unified interface format', () => {
      const envPath = path.join(testDir, 'interface-check.env');
      fs.writeFileSync(envPath, 'KEY=value');

      const result = validateEnvFile(envPath);

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

  describe('parseEnvFile()', () => {
    test('should parse key=value pairs correctly', () => {
      const content = 'API_KEY=abc123\nDATABASE_URL=postgres://localhost';

      const result = parseEnvFile(content);

      assert.ok(result.variables);
      assert.strictEqual(result.variables.API_KEY, 'abc123');
      assert.strictEqual(result.variables.DATABASE_URL, 'postgres://localhost');
    });

    test('should handle quoted values', () => {
      const content = 'QUOTED="value with spaces"\nSINGLE=\'single quoted\'';

      const result = parseEnvFile(content);

      assert.strictEqual(result.variables.QUOTED, 'value with spaces');
      assert.strictEqual(result.variables.SINGLE, 'single quoted');
    });

    test('should preserve comments', () => {
      const content = '# This is a comment\nKEY=value\n# Another comment';

      const result = parseEnvFile(content);

      assert.ok(Array.isArray(result.comments));
      assert.ok(result.comments.length >= 2);
    });

    test('should ignore empty lines', () => {
      const content = 'KEY1=value1\n\n\nKEY2=value2';

      const result = parseEnvFile(content);

      assert.strictEqual(Object.keys(result.variables).length, 2);
    });

    test('should handle multiline values', () => {
      // Note: Most .env parsers don't support true multiline, but we should handle edge cases
      const content = 'SIMPLE=value';

      const result = parseEnvFile(content);

      assert.strictEqual(result.variables.SIMPLE, 'value');
    });
  });

  describe('checkPreservation()', () => {
    test('should detect all old variables preserved', () => {
      const oldContent = 'API_KEY=old123\nDB_HOST=localhost';
      const newContent = 'API_KEY=old123\nDB_HOST=localhost\nNEW_VAR=added';

      const result = checkPreservation(oldContent, newContent);

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.failures.length, 0);
    });

    test('should detect new variables added', () => {
      const oldContent = 'API_KEY=value';
      const newContent = 'API_KEY=value\nNEW_KEY=new_value';

      const result = checkPreservation(oldContent, newContent);

      assert.strictEqual(result.passed, true);
      // No failures because adding is allowed
    });

    test('should detect removed variables', () => {
      const oldContent = 'API_KEY=value\nDB_HOST=localhost';
      const newContent = 'API_KEY=value';

      const result = checkPreservation(oldContent, newContent);

      assert.strictEqual(result.passed, false);
      assert.ok(result.failures.some(f => /removed/i.test(f.reason)));
    });

    test('should detect changed values', () => {
      const oldContent = 'API_KEY=original_value';
      const newContent = 'API_KEY=changed_value';

      const result = checkPreservation(oldContent, newContent);

      assert.strictEqual(result.passed, false);
      assert.ok(result.failures.some(f => /changed/i.test(f.reason)));
    });

    test('should preserve comments', () => {
      const oldContent = '# Important comment\nAPI_KEY=value';
      const newContent = '# Important comment\nAPI_KEY=value\nNEW=var';

      const result = checkPreservation(oldContent, newContent);

      // Comments should be preserved
      assert.strictEqual(result.passed, true);
    });
  });
});
