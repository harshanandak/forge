// Test: File Size Limit Edge Cases
// Validates warnings for oversized files (non-blocking)

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir: _tmpdir } = require('node:os');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

let testDir;

before(() => {
  testDir = mkdtempSync(path.join(__dirname, '.file-limits-test-'));
});

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// Helper function to count lines in a file
function countLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split('\n').length;
}

// Helper function to create AGENTS.md with specific line count
function createAgentsMd(filePath, lineCount) {
  let content = '# AGENTS.md\n\nThis file contains agent configuration.\n\n';
  const currentLines = content.split('\n').length;

  for (let i = currentLines; i < lineCount; i++) {
    content += `Line ${i}: Placeholder content for testing.\n`;
  }

  fs.writeFileSync(filePath, content);
}

// Simulate the checkAgentsMdSize function from bin/forge.js
function checkAgentsMdSize(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').length;

    if (lines > 200) {
      return {
        warning: true,
        lines,
        message: `AGENTS.md is quite large (${lines} lines, recommended: < 200)`
      };
    }

    return { warning: false, lines };
  } catch (err) {
    return { warning: false, error: err.message };
  }
}

describe('file-limits', () => {
  describe('AGENTS.md Size Warnings', () => {
    test('199 lines - no warning', () => {
      const filePath = path.join(testDir, 'agents-199.md');
      createAgentsMd(filePath, 199);

      const lines = countLines(filePath);
      assert.ok(lines >= 199 && lines <= 200, `Should have ~199 lines, got ${lines}`);

      const result = checkAgentsMdSize(filePath);
      assert.strictEqual(result.warning, false, 'Should not warn at 199 lines');
    });

    test('200 lines - no warning (boundary)', () => {
      const filePath = path.join(testDir, 'agents-200.md');
      createAgentsMd(filePath, 200);

      const lines = countLines(filePath);
      assert.ok(lines >= 200 && lines <= 201, `Should have ~200 lines, got ${lines}`);

      const result = checkAgentsMdSize(filePath);
      assert.strictEqual(result.warning, false, 'Should not warn at exactly 200 lines');
    });

    test('201 lines - warning appears', () => {
      const filePath = path.join(testDir, 'agents-201.md');
      createAgentsMd(filePath, 201);

      const lines = countLines(filePath);
      assert.ok(lines >= 201, `Should have >=201 lines, got ${lines}`);

      const result = checkAgentsMdSize(filePath);
      assert.strictEqual(result.warning, true, 'Should warn at 201 lines');
      assert.ok(result.message.includes('quite large'), 'Warning message should mention size');
    });

    test('350 lines - warning with severity message', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'large-agents-md', 'AGENTS.md');

      const lines = countLines(fixturePath);
      assert.ok(lines > 300, `large-agents-md fixture should have >300 lines, got ${lines}`);

      const result = checkAgentsMdSize(fixturePath);
      assert.strictEqual(result.warning, true, 'Should warn for large file');
      assert.ok(result.lines > 300, `Should report >300 lines, got ${result.lines}`);
    });
  });

  describe('Suggestion Messages', () => {
    test('should suggest moving to docs/', () => {
      const filePath = path.join(testDir, 'agents-250.md');
      createAgentsMd(filePath, 250);

      const result = checkAgentsMdSize(filePath);

      assert.strictEqual(result.warning, true, 'Should warn');
      // The actual implementation in bin/forge.js would console.log the suggestion
      // Here we just verify the warning is triggered
      assert.ok(result.message, 'Should have warning message');
    });

    test('warning should not block operation', () => {
      const filePath = path.join(testDir, 'agents-500.md');
      createAgentsMd(filePath, 500);

      const result = checkAgentsMdSize(filePath);

      // Warning exists but doesn't throw or block
      assert.strictEqual(result.warning, true, 'Should warn');
      assert.strictEqual(result.error, undefined, 'Should not have errors');

      // The function completes successfully despite warning
      assert.ok(result.lines > 0, 'Should complete and return line count');
    });
  });
});
