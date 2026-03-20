import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..');

describe('Stage naming consistency', () => {
  describe('bin/forge.js CURSOR_RULE', () => {
    const forgeSource = readFileSync(join(ROOT, 'bin', 'forge.js'), 'utf8');

    // Extract the CURSOR_RULE template string
    const cursorRuleMatch = forgeSource.match(
      /const CURSOR_RULE = `([\s\S]*?)`;/
    );
    const cursorRule = cursorRuleMatch ? cursorRuleMatch[1] : '';

    test('CURSOR_RULE section exists', () => {
      expect(cursorRule.length).toBeGreaterThan(0);
    });

    test('does not contain /check as a stage name', () => {
      // Match backtick-quoted /check or /check used as a stage command
      // but not the word "check" in prose
      const staleCheckRefs = cursorRule.match(/`\/check`/g);
      expect(staleCheckRefs).toBeNull();
    });

    test('does not contain /merge as a stage name', () => {
      const staleMergeRefs = cursorRule.match(/`\/merge`/g);
      expect(staleMergeRefs).toBeNull();
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
      const absPath = join(ROOT, relPath);
      let content;
      try {
        content = readFileSync(absPath, 'utf8');
      } catch {
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
    const cursorrules = readFileSync(join(ROOT, '.cursorrules'), 'utf8');

    test('does not contain backtick-quoted /check as stage name', () => {
      const staleRefs = cursorrules.match(/`\/check`/g);
      expect(staleRefs).toBeNull();
    });

    test('does not contain /check in stage table row', () => {
      // Stage table pattern: | N | `/check` |
      const tableRef = cursorrules.match(/\|\s*`\/check`\s*\|/g);
      expect(tableRef).toBeNull();
    });

    test('does not contain /check in flow diagram', () => {
      // Flow diagram: /check →
      const flowRef = cursorrules.match(/\/check\s*→/g);
      expect(flowRef).toBeNull();
    });

    test('does not contain "Check (`/check`)" heading', () => {
      expect(cursorrules).not.toContain('Check (`/check`)');
    });

    test('contains /validate where /check was replaced', () => {
      // Stage table should have /validate
      expect(cursorrules).toMatch(/\|\s*`\/validate`\s*\|/);
      // Flow diagram should have /validate
      expect(cursorrules).toMatch(/\/validate\s*→/);
      // Heading should reference /validate
      expect(cursorrules).toContain('Validate (`/validate`)');
    });
  });
});
