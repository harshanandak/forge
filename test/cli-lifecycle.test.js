const { describe, test, expect } = require('bun:test');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const forgeBin = path.resolve(__dirname, '..', 'bin', 'forge.js');

/**
 * Helper: run forge CLI and capture stdout+stderr.
 * Uses a temp dir with AGENTS.md so the first-run check passes.
 */
function runForge(args, { cwd } = {}) {
  const tmpDir = cwd || fs.mkdtempSync(path.join(os.tmpdir(), 'cli-lifecycle-test-'));

  // Create AGENTS.md so first-run detection doesn't block us
  if (!fs.existsSync(path.join(tmpDir, 'AGENTS.md'))) {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Test', 'utf-8');
  }

  try {
    const result = execFileSync('node', [forgeBin, ...args], {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, INIT_CWD: tmpDir },
    });
    return { stdout: result, stderr: '', exitCode: 0 };
  } catch (error) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      exitCode: error.status || 1,
    };
  } finally {
    if (!cwd) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

describe('CLI lifecycle commands', () => {
  describe('forge reset', () => {
    test('with no flags shows help text', () => {
      const result = runForge(['reset']);
      const output = result.stdout + result.stderr;
      expect(output).toContain('reset');
      expect(output).toContain('--soft');
      expect(output).toContain('--hard');
    });

    test('recognizes --soft flag', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-reset-soft-'));
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Test', 'utf-8');
      fs.mkdirSync(path.join(tmpDir, '.forge'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.forge', 'setup-state.json'), '{}', 'utf-8');

      const result = runForge(['reset', '--soft', '--force'], { cwd: tmpDir });
      const output = result.stdout + result.stderr;

      // Should not show help, should perform the reset
      expect(output).not.toContain('Usage:');
      // .forge should be removed
      expect(fs.existsSync(path.join(tmpDir, '.forge'))).toBe(false);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('recognizes --hard flag', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-reset-hard-'));
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Test', 'utf-8');
      fs.mkdirSync(path.join(tmpDir, '.forge'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.forge', 'setup-state.json'), '{}', 'utf-8');

      const result = runForge(['reset', '--hard', '--force'], { cwd: tmpDir });
      const output = result.stdout + result.stderr;

      expect(output).not.toContain('Usage:');
      expect(fs.existsSync(path.join(tmpDir, '.forge'))).toBe(false);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('--soft without --force shows error', () => {
      const result = runForge(['reset', '--soft']);
      const output = result.stdout + result.stderr;
      expect(output).toContain('--force');
    });

    test('--hard without --force shows error', () => {
      const result = runForge(['reset', '--hard']);
      const output = result.stdout + result.stderr;
      expect(output).toContain('--force');
    });
  });

  describe('forge reinstall', () => {
    test('is recognized as a command', () => {
      const result = runForge(['reinstall']);
      const output = result.stdout + result.stderr;
      // Should mention --force requirement (not "unknown command")
      expect(output).toContain('--force');
    });

    test('with --force performs reset', { timeout: 15000 }, () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-reinstall-'));
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Test', 'utf-8');
      fs.mkdirSync(path.join(tmpDir, '.forge'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.forge', 'setup-state.json'), '{}', 'utf-8');

      const result = runForge(['reinstall', '--force'], { cwd: tmpDir });
      const _output = result.stdout + result.stderr;

      // .forge should be removed (hard reset part)
      expect(fs.existsSync(path.join(tmpDir, '.forge'))).toBe(false);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
