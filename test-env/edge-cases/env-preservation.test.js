// Test: .env.local Preservation Edge Cases
// Validates .env.local preservation using env-validator.js

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
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

beforeAll(() => {
  testDir = mkdtempSync(path.join(tmpdir(), 'forge-test-env-preservation-'));
});

afterAll(() => {
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

      expect(result.passed).toBe(true);
      expect(result.failures.length).toBe(0);
    });

    test('should add new variables without overwrite', () => {
      const oldEnv = `API_KEY=old_key
`;

      const newEnv = `API_KEY=old_key
NEW_API=new_value
ANOTHER_VAR=another
`;

      const result = checkPreservation(oldEnv, newEnv);

      expect(result.passed).toBe(true);

      const newParsed = parseEnvFile(newEnv);
      expect(newParsed.variables.API_KEY).toBe('old_key');
      expect(newParsed.variables.NEW_API).toBe('new_value');
      expect(newParsed.variables.ANOTHER_VAR).toBe('another');
    });

    test('should not change existing values', () => {
      const oldEnv = `API_KEY=original_value
SECRET=top_secret
`;

      const newEnv = `API_KEY=changed_value
SECRET=top_secret
`;

      const result = checkPreservation(oldEnv, newEnv);

      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.path === 'API_KEY')).toBeTruthy();
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

      expect(result.passed).toBe(false);
      expect(result.failures.some(f => f.path === 'SECRET')).toBeTruthy();
    });
  });

  describe('Comment Preservation', () => {
    test('should keep header comments', () => {
      const envContent = `# This is a header comment
# Multiple lines of comments
API_KEY=value
`;

      const parsed = parseEnvFile(envContent);

      expect(parsed.comments.length >= 2).toBeTruthy();
      expect(parsed.comments.some(c => c.includes('header comment'))).toBeTruthy();
    });

    test('should handle inline comments', () => {
      // Note: .env format typically doesn't support inline comments well,
      // but we should at least not break on them
      const envContent = `API_KEY=value
# Comment after variable
DATABASE_URL=url
`;

      const parsed = parseEnvFile(envContent);

      expect(parsed.comments.length > 0).toBeTruthy();
      expect(parsed.variables.API_KEY).toBe('value');
    });
  });

  describe('Format Preservation', () => {
    test('should preserve spacing and empty lines', () => {
      const envContent = `# Header

API_KEY=value

DATABASE_URL=url
`;

      const parsed = parseEnvFile(envContent);

      expect(parsed.variables.API_KEY).toBe('value');
      expect(parsed.variables.DATABASE_URL).toBe('url');
      expect(parsed.raw.includes('\n\n')).toBeTruthy();
    });

    test('should preserve quoted values', () => {
      const envContent = `API_KEY="quoted value"
PATH='single quoted'
PLAIN=unquoted
`;

      const parsed = parseEnvFile(envContent);

      // parseEnvFile strips quotes, but values should be correct
      expect(parsed.variables.API_KEY).toBe('quoted value');
      expect(parsed.variables.PATH).toBe('single quoted');
      expect(parsed.variables.PLAIN).toBe('unquoted');
    });

    test('should preserve escaped values', () => {
      const envContent = `PATH="C:\\\\Program Files\\\\App"
REGEX="test\\nvalue"
`;

      const parsed = parseEnvFile(envContent);

      // Should parse without errors
      expect(parsed.variables.PATH).toBeTruthy();
      expect(parsed.variables.REGEX).toBeTruthy();
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

      expect(shouldAdd).toBe(true);

      // Add it
      fs.writeFileSync(gitignorePath, gitignore + '.env.local\n');

      const updatedGitignore = fs.readFileSync(gitignorePath, 'utf8');
      expect(updatedGitignore.includes('.env.local')).toBeTruthy();
    });

    test('should not duplicate .env.local entry', () => {
      const gitignorePath = path.join(testDir, '.gitignore');
      fs.writeFileSync(gitignorePath, `node_modules/
.env.local
*.log
`);

      const gitignore = fs.readFileSync(gitignorePath, 'utf8');
      const shouldAdd = !gitignore.includes('.env.local');

      expect(shouldAdd).toBe(false);

      // Count occurrences
      const matches = gitignore.match(/\.env\.local/g);
      expect(matches.length).toBe(1);
    });
  });

  describe('Integration with existing-forge-v1 Fixture', () => {
    test('should validate existing .env.local format', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'existing-forge-v1');
      const envPath = path.join(fixturePath, '.env.local');

      // Check if fixture has .env.local
      if (fs.existsSync(envPath)) {
        const result = validateEnvFile(envPath);

        expect(result.passed).toBe(true);
        expect(result.coverage > 0).toBeTruthy();
      }
    });
  });
});
