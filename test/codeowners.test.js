const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('.github/CODEOWNERS', () => {
  const codeownersPath = path.join(__dirname, '..', '.github', 'CODEOWNERS');

  describe('File existence', () => {
    test('should exist', () => {
      assert.ok(fs.existsSync(codeownersPath), 'CODEOWNERS file should exist');
    });
  });

  describe('File format', () => {
    test('should be valid syntax', () => {
      const content = fs.readFileSync(codeownersPath, 'utf-8');

      // Should have comments or ownership rules
      assert.ok(content.length > 0, 'CODEOWNERS should not be empty');

      // Should not have syntax errors (basic validation)
      const lines = content.split('\n');
      const hasValidLines = lines.some(line => {
        const trimmed = line.trim();
        return trimmed.startsWith('#') || trimmed.includes('@') || trimmed === '';
      });

      assert.ok(hasValidLines, 'CODEOWNERS should have comments or ownership rules');
    });
  });

  describe('Critical directory ownership', () => {
    test('should protect /bin/ directory', () => {
      const content = fs.readFileSync(codeownersPath, 'utf-8');

      // Should have ownership rule for /bin/
      const hasBinOwner = content.includes('/bin/') && content.includes('@');
      assert.ok(hasBinOwner, '/bin/ directory should have code owners');
    });

    test('should protect /lib/ directory', () => {
      const content = fs.readFileSync(codeownersPath, 'utf-8');

      // Should have ownership rule for /lib/
      const hasLibOwner = content.includes('/lib/') && content.includes('@');
      assert.ok(hasLibOwner, '/lib/ directory should have code owners');
    });

    test('should protect /.claude/ directory', () => {
      const content = fs.readFileSync(codeownersPath, 'utf-8');

      // Should have ownership rule for /.claude/
      const hasClaudeOwner = content.includes('/.claude/') && content.includes('@');
      assert.ok(hasClaudeOwner, '/.claude/ directory should have code owners');
    });

    test('should protect /docs/ directory', () => {
      const content = fs.readFileSync(codeownersPath, 'utf-8');

      // Should have ownership rule for /docs/
      const hasDocsOwner = content.includes('/docs/') && content.includes('@');
      assert.ok(hasDocsOwner, '/docs/ directory should have code owners');
    });
  });

  describe('Team assignments', () => {
    test('should use GitHub team syntax', () => {
      const content = fs.readFileSync(codeownersPath, 'utf-8');

      // Should use @org/team or @username format
      const hasTeamSyntax = content.match(/@[\w-]+\/[\w-]+/) || content.match(/@[\w-]+/);
      assert.ok(hasTeamSyntax, 'Should use GitHub team syntax (@org/team or @username)');
    });

    test('should have distinct teams for different areas', () => {
      const content = fs.readFileSync(codeownersPath, 'utf-8');

      // Should have at least 2 different owner references
      const owners = content.match(/@[\w-]+\/[\w-]+/g) || content.match(/@[\w-]+/g);
      if (owners) {
        const uniqueOwners = [...new Set(owners)];
        assert.ok(uniqueOwners.length >= 2, 'Should have at least 2 distinct code owner teams');
      }
    });
  });
});
