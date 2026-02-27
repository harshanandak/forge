const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { describe, test, expect, beforeEach, afterEach } = require('bun:test');

/**
 * Tests for scripts/commitlint.js
 *
 * The script is a cross-platform wrapper around `commitlint --edit <file>`.
 * It:
 * 1. Requires a commit message file path as argv[2]
 * 2. Detects bun.lock to choose bunx vs npx as the runner
 * 3. Invokes `<runner> commitlint --edit <file>` via spawnSync
 * 4. Exits with status 1 if no file arg is provided
 * 5. Exits with commitlint's exit code on validation failure
 */

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'commitlint.js');
const PROJECT_ROOT = path.join(__dirname, '..', '..');

/**
 * Run the commitlint wrapper script with a given commit message string.
 * Writes the message to a temp file and invokes the script via node.
 */
function runWithMessage(message) {
  const tmpFile = path.join(os.tmpdir(), `commitlint-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(tmpFile, message, 'utf-8');
  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, tmpFile],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        timeout: 30000,
      }
    );
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error,
    };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

/**
 * Run the commitlint wrapper script with no arguments.
 */
function runWithNoArgs() {
  return spawnSync(
    process.execPath,
    [SCRIPT],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 10000,
    }
  );
}

describe('scripts/commitlint.js', () => {
  describe('argument validation', () => {
    test('exits with code 1 when no commit message file is provided', () => {
      const result = runWithNoArgs();
      expect(result.status).toBe(1);
    });

    test('prints error message when no commit message file is provided', () => {
      const result = runWithNoArgs();
      expect(result.stderr).toContain('No commit message file provided');
    });
  });

  describe('valid commit messages (happy path)', () => {
    test('accepts "feat: add new feature"', () => {
      const result = runWithMessage('feat: add new feature');
      expect(result.status).toBe(0);
    });

    test('accepts "fix: resolve null pointer"', () => {
      const result = runWithMessage('fix: resolve null pointer');
      expect(result.status).toBe(0);
    });

    test('accepts "docs: update readme"', () => {
      const result = runWithMessage('docs: update readme');
      expect(result.status).toBe(0);
    });

    test('accepts "test: add unit tests"', () => {
      const result = runWithMessage('test: add unit tests');
      expect(result.status).toBe(0);
    });

    test('accepts "chore: update dependencies"', () => {
      const result = runWithMessage('chore: update dependencies');
      expect(result.status).toBe(0);
    });

    test('accepts "refactor: extract helper function"', () => {
      const result = runWithMessage('refactor: extract helper function');
      expect(result.status).toBe(0);
    });

    test('accepts "perf: reduce bundle size"', () => {
      const result = runWithMessage('perf: reduce bundle size');
      expect(result.status).toBe(0);
    });

    test('accepts "ci: add workflow step"', () => {
      const result = runWithMessage('ci: add workflow step');
      expect(result.status).toBe(0);
    });

    test('accepts "build: configure webpack"', () => {
      const result = runWithMessage('build: configure webpack');
      expect(result.status).toBe(0);
    });

    test('accepts "revert: revert prior change"', () => {
      const result = runWithMessage('revert: revert prior change');
      expect(result.status).toBe(0);
    });

    test('accepts "style: fix formatting"', () => {
      const result = runWithMessage('style: fix formatting');
      expect(result.status).toBe(0);
    });

    test('accepts custom "proposal" type', () => {
      const result = runWithMessage('proposal: add new approach');
      expect(result.status).toBe(0);
    });

    test('accepts type with scope "feat(auth): add login"', () => {
      const result = runWithMessage('feat(auth): add login');
      expect(result.status).toBe(0);
    });

    test('accepts type with breaking change scope "feat(api)!: redesign endpoints"', () => {
      const result = runWithMessage('feat(api)!: redesign endpoints');
      expect(result.status).toBe(0);
    });

    test('accepts multi-line message with body', () => {
      const message = 'feat: add feature\n\nThis is the body of the commit message.\nIt can span multiple lines.';
      const result = runWithMessage(message);
      expect(result.status).toBe(0);
    });

    test('accepts multi-line message with body and footer', () => {
      const message = 'fix: correct edge case\n\nDetailed description here.\n\nCloses #123';
      const result = runWithMessage(message);
      expect(result.status).toBe(0);
    });
  });

  describe('invalid commit messages (error paths)', () => {
    test('rejects message with no type (plain text)', () => {
      const result = runWithMessage('this is not a valid commit message');
      expect(result.status).not.toBe(0);
    });

    test('accepts empty message (commitlint skips empty input)', () => {
      // commitlint exits 0 for empty files — nothing to validate
      const result = runWithMessage('');
      expect(result.status).toBe(0);
    });

    test('rejects unknown type "wip: work in progress"', () => {
      const result = runWithMessage('wip: work in progress');
      expect(result.status).not.toBe(0);
    });

    test('accepts message with title-case subject "feat: Add Feature" (only full upper-case is rejected)', () => {
      // subject-case rule is "never upper-case" — Title Case is NOT "upper-case"
      // Only ALL CAPS subjects (e.g. "feat: ADD FEATURE") are rejected
      const result = runWithMessage('feat: Add Feature');
      expect(result.status).toBe(0);
    });

    test('rejects message with ALL CAPS subject', () => {
      const result = runWithMessage('feat: ADD NEW FEATURE');
      expect(result.status).not.toBe(0);
    });

    test('rejects message exceeding 100 character header limit', () => {
      const longSubject = 'a'.repeat(95);
      const result = runWithMessage(`feat: ${longSubject}`);
      expect(result.status).not.toBe(0);
    });

    test('rejects type-only message without subject "feat:"', () => {
      const result = runWithMessage('feat:');
      expect(result.status).not.toBe(0);
    });

    test('rejects message without colon separator "feat add feature"', () => {
      const result = runWithMessage('feat add feature');
      expect(result.status).not.toBe(0);
    });
  });

  describe('script structure', () => {
    test('script file exists', () => {
      expect(fs.existsSync(SCRIPT)).toBe(true);
    });

    test('script is executable (has shebang)', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
    });

    test('script uses spawnSync for cross-platform compatibility', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content).toContain('spawnSync');
    });

    test('script detects bun.lock to choose runner', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content).toContain('bun.lock');
    });

    test('script passes --edit flag to commitlint', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content).toContain('--edit');
    });

    test('script uses shell:true on Windows for .cmd extension resolution', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content).toContain('shell');
      expect(content).toContain('isWindows');
    });
  });
});
