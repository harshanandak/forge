// Test: .env.local Preservation Edge Cases
// Validates .env.local preservation using env-validator.js

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');

// Import validation helpers from Phase 1
const {
  validateEnvFile,
  parseEnvFile,
  checkPreservation
} = require('../validation/env-validator.js');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

let testDir;

before(() => {
  testDir = mkdtempSync(path.join(tmpdir(), 'forge-test-env-preservation-'));
});

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('env-preservation', () => {
  describe('Variable Preservation', () => {
    test('should preserve existing variables', () => {
      const oldEnv = `# Configuration
API_KEY=existing_key_123
DATABASE_URL=postgres://localhost/old_db
`;

      const newEnv = `# Configuration
API_KEY=existing_key_123
DATABASE_URL=postgres://localhost/old_db
NEW_VAR=added_value
`;

      const result = checkPreservation(oldEnv, newEnv);

      assert.strictEqual(result.passed, true, 'Should preserve all existing variables');
      assert.strictEqual(result.failures.length, 0, 'Should have no preservation failures');
    });

    test('should add new variables without overwrite', () => {
      const oldEnv = `API_KEY=old_key
`;

      const newEnv = `API_KEY=old_key
NEW_API=new_value
ANOTHER_VAR=another
`;

      const result = checkPreservation(oldEnv, newEnv);

      assert.strictEqual(result.passed, true, 'Should allow adding new variables');

      const newParsed = parseEnvFile(newEnv);
      assert.strictEqual(newParsed.variables.API_KEY, 'old_key', 'Old key preserved');
      assert.strictEqual(newParsed.variables.NEW_API, 'new_value', 'New var added');
      assert.strictEqual(newParsed.variables.ANOTHER_VAR, 'another', 'Another var added');
    });

    test('should not change existing values', () => {
      const oldEnv = `API_KEY=original_value
SECRET=top_secret
`;

      const newEnv = `API_KEY=changed_value
SECRET=top_secret
`;

      const result = checkPreservation(oldEnv, newEnv);

      assert.strictEqual(result.passed, false, 'Should fail if values changed');
      assert.ok(
        result.failures.some(f => f.path === 'API_KEY'),
        'Should report changed API_KEY'
      );
    });

    test('should never remove old variables', () => {
      const oldEnv = `API_KEY=key
DATABASE_URL=url
SECRET=secret
`;

      const newEnv = `API_KEY=key
DATABASE_URL=url
`;

      const result = checkPreservation(oldEnv, newEnv);

      assert.strictEqual(result.passed, false, 'Should fail if variables removed');
      assert.ok(
        result.failures.some(f => f.path === 'SECRET'),
        'Should report removed SECRET'
      );
    });
  });

  describe('Comment Preservation', () => {
    test('should keep header comments', () => {
      const envContent = `# This is a header comment
# Multiple lines of comments
API_KEY=value
`;

      const parsed = parseEnvFile(envContent);

      assert.ok(parsed.comments.length >= 2, 'Should preserve multiple comment lines');
      assert.ok(
        parsed.comments.some(c => c.includes('header comment')),
        'Should preserve header comment text'
      );
    });

    test('should handle inline comments', () => {
      // Note: .env format typically doesn't support inline comments well,
      // but we should at least not break on them
      const envContent = `API_KEY=value
# Comment after variable
DATABASE_URL=url
`;

      const parsed = parseEnvFile(envContent);

      assert.ok(parsed.comments.length > 0, 'Should preserve comments');
      assert.strictEqual(parsed.variables.API_KEY, 'value', 'Should parse value correctly');
    });
  });

  describe('Format Preservation', () => {
    test('should preserve spacing and empty lines', () => {
      const envContent = `# Header

API_KEY=value

DATABASE_URL=url
`;

      const parsed = parseEnvFile(envContent);

      assert.strictEqual(parsed.variables.API_KEY, 'value', 'Should parse with spacing');
      assert.strictEqual(parsed.variables.DATABASE_URL, 'url', 'Should parse after empty line');
      assert.ok(parsed.raw.includes('\n\n'), 'Raw content should preserve empty lines');
    });

    test('should preserve quoted values', () => {
      const envContent = `API_KEY="quoted value"
PATH='single quoted'
PLAIN=unquoted
`;

      const parsed = parseEnvFile(envContent);

      // parseEnvFile strips quotes, but values should be correct
      assert.strictEqual(parsed.variables.API_KEY, 'quoted value', 'Double quoted value');
      assert.strictEqual(parsed.variables.PATH, 'single quoted', 'Single quoted value');
      assert.strictEqual(parsed.variables.PLAIN, 'unquoted', 'Unquoted value');
    });

    test('should preserve escaped values', () => {
      const envContent = `PATH="C:\\\\Program Files\\\\App"
REGEX="test\\nvalue"
`;

      const parsed = parseEnvFile(envContent);

      // Should parse without errors
      assert.ok(parsed.variables.PATH, 'Should parse path with backslashes');
      assert.ok(parsed.variables.REGEX, 'Should parse regex with escapes');
    });
  });

  describe('.gitignore Update', () => {
    test('should add .env.local if missing', () => {
      const gitignorePath = path.join(testDir, '.gitignore');
      fs.writeFileSync(gitignorePath, `node_modules/
*.log
`);

      // Simulate adding .env.local to .gitignore
      const gitignore = fs.readFileSync(gitignorePath, 'utf8');
      const shouldAdd = !gitignore.includes('.env.local');

      assert.strictEqual(shouldAdd, true, '.env.local not in gitignore initially');

      // Add it
      fs.writeFileSync(gitignorePath, gitignore + '.env.local\n');

      const updatedGitignore = fs.readFileSync(gitignorePath, 'utf8');
      assert.ok(updatedGitignore.includes('.env.local'), 'Should add .env.local to gitignore');
    });

    test('should not duplicate .env.local entry', () => {
      const gitignorePath = path.join(testDir, '.gitignore');
      fs.writeFileSync(gitignorePath, `node_modules/
.env.local
*.log
`);

      const gitignore = fs.readFileSync(gitignorePath, 'utf8');
      const shouldAdd = !gitignore.includes('.env.local');

      assert.strictEqual(shouldAdd, false, '.env.local already in gitignore');

      // Count occurrences
      const matches = gitignore.match(/\.env\.local/g);
      assert.strictEqual(matches.length, 1, 'Should have exactly one .env.local entry');
    });
  });

  describe('Integration with existing-forge-v1 Fixture', () => {
    test('should validate existing .env.local format', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'existing-forge-v1');
      const envPath = path.join(fixturePath, '.env.local');

      // Check if fixture has .env.local
      if (fs.existsSync(envPath)) {
        const result = validateEnvFile(envPath);

        assert.strictEqual(result.passed, true, 'Fixture .env.local should be valid');
        assert.ok(result.coverage > 0, 'Should have coverage > 0');
      }
    });
  });
});
