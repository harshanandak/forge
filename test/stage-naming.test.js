const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const ROOT = path.join(__dirname, '..');

describe('Stage naming consistency', () => {
  describe('bin/forge.js CURSOR_RULE', () => {
    const forgeSource = fs.readFileSync(path.join(ROOT, 'bin', 'forge.js'), 'utf8');

    // Extract the CURSOR_RULE template string
    const cursorRuleMatch = forgeSource.match(
      /const CURSOR_RULE = `([\s\S]*?)`;/
    );
    const cursorRule = cursorRuleMatch ? cursorRuleMatch[1] : '';

    test('CURSOR_RULE section exists', () => {
      expect(cursorRule.length).toBeGreaterThan(0);
    });

    test('does not contain /check as a stage name', () => {
      expect(cursorRule).not.toContain('/check');
    });

    test('does not contain /merge as a stage name', () => {
      expect(cursorRule).not.toContain('/merge');
    });

    test('contains /validate as stage name', () => {
      expect(cursorRule).toContain('/validate');
    });

    test('contains /premerge as stage name', () => {
      expect(cursorRule).toContain('/premerge');
    });
  });

  describe('active docs have no stale /check stage refs', () => {
    const activeDocs = [
      'docs/WORKFLOW.md',
      'docs/SETUP.md',
      'docs/EXAMPLES.md',
      'docs/VALIDATION.md',
      'docs/TOOLCHAIN.md',
      'docs/ROADMAP.md',
    ];

    for (const relPath of activeDocs) {
      const absPath = path.join(ROOT, relPath);
      let content;
      try {
        content = fs.readFileSync(absPath, 'utf8');
      } catch (_e) {
        content = null;
      }

      if (content !== null) {
        test(`${relPath} has no backtick-quoted /check stage name`, () => {
          const staleRefs = content.match(/`\/check`/g);
          expect(staleRefs).toBeNull();
        });
      }
    }
  });

  describe('.cursorrules file', () => {
    const cursorrules = fs.readFileSync(path.join(ROOT, '.cursorrules'), 'utf8');

    test('does not contain backtick-quoted /check as stage name', () => {
      const staleRefs = cursorrules.match(/`\/check`/g);
      expect(staleRefs).toBeNull();
    });

    test('does not contain /check in stage table row', () => {
      const tableRef = cursorrules.match(/\|\s*`\/check`\s*\|/g);
      expect(tableRef).toBeNull();
    });

    test('does not contain /check in flow diagram', () => {
      const flowRef = cursorrules.match(/\/check\s*→/g);
      expect(flowRef).toBeNull();
    });

    test('does not contain "Check (`/check`)" heading', () => {
      expect(cursorrules).not.toContain('Check (`/check`)');
    });

    test('contains /validate where /check was replaced', () => {
      expect(cursorrules).toMatch(/\|\s*`\/validate`\s*\|/);
      expect(cursorrules).toMatch(/\/validate\s*→/);
      expect(cursorrules).toContain('Validate (`/validate`)');
    });
  });
});
