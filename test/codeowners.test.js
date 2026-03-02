const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

describe('.github/CODEOWNERS', () => {
  const codeownersPath = path.join(__dirname, '..', '.github', 'CODEOWNERS');

  describe('File existence', () => {
    test('should exist', () => {
      expect(fs.existsSync(codeownersPath)).toBeTruthy();
    });
  });

  describe('File format', () => {
    test('should be valid syntax', () => {
      const content = fs.readFileSync(codeownersPath, 'utf-8');

      // Should have comments or ownership rules
      expect(content.length > 0).toBeTruthy();

      // Should not have syntax errors (basic validation)
      const lines = content.split('\n');
      const hasValidLines = lines.some(line => {
        const trimmed = line.trim();
        return trimmed.startsWith('#') || trimmed.includes('@') || trimmed === '';
      });

      expect(hasValidLines).toBeTruthy();
    });
  });

  describe('Critical directory ownership', () => {
    test('should protect /bin/ directory', () => {
      const content = fs.readFileSync(codeownersPath, 'utf-8');

      // Should have ownership rule for /bin/
      const hasBinOwner = content.includes('/bin/') && content.includes('@');
      expect(hasBinOwner).toBeTruthy();
    });

    test('should protect /lib/ directory', () => {
      const content = fs.readFileSync(codeownersPath, 'utf-8');

      // Should have ownership rule for /lib/
      const hasLibOwner = content.includes('/lib/') && content.includes('@');
      expect(hasLibOwner).toBeTruthy();
    });

    test('should protect /.claude/ directory', () => {
      const content = fs.readFileSync(codeownersPath, 'utf-8');

      // Should have ownership rule for /.claude/
      const hasClaudeOwner = content.includes('/.claude/') && content.includes('@');
      expect(hasClaudeOwner).toBeTruthy();
    });

    test('should protect /docs/ directory', () => {
      const content = fs.readFileSync(codeownersPath, 'utf-8');

      // Should have ownership rule for /docs/
      const hasDocsOwner = content.includes('/docs/') && content.includes('@');
      expect(hasDocsOwner).toBeTruthy();
    });
  });

  describe('Team assignments', () => {
    test('should use GitHub team syntax', () => {
      const content = fs.readFileSync(codeownersPath, 'utf-8');

      // Should use @org/team or @username format
      const hasTeamSyntax = content.match(/@[\w-]+\/[\w-]+/) || content.match(/@[\w-]+/);
      expect(hasTeamSyntax).toBeTruthy();
    });

    test('should have distinct teams for different areas', () => {
      const content = fs.readFileSync(codeownersPath, 'utf-8');

      // Should have at least 2 different owner references
      const owners = content.match(/@[\w-]+\/[\w-]+/g) || content.match(/@[\w-]+/g);
      if (owners) {
        const uniqueOwners = [...new Set(owners)];
        expect(uniqueOwners.length >= 2).toBeTruthy();
      }
    });
  });
});
