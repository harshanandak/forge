const { afterAll, describe, test, expect, setDefaultTimeout } = require('bun:test');
const path = require('path');
const fs = require('fs');
const {
  CASE_TIMEOUT_MS,
  CLI_TIMEOUT_MS,
  createCliSandboxes,
  runForgeIn,
} = require('./helpers/cli-subprocess');

setDefaultTimeout(CASE_TIMEOUT_MS);

const sandboxes = createCliSandboxes('cli-lifecycle-test-');
afterAll(() => sandboxes.cleanup());

/**
 * Helper: run forge CLI and capture stdout+stderr.
 * Runs in a private sandbox (AGENTS.md present so the first-run check passes),
 * with a scrubbed env so no ambient INIT_CWD/FORGE_* repoints the child.
 *
 * @param {string[]} args - CLI args to pass to forge
 * @param {Object} [options]
 * @param {string} [options.cwd] - Caller-owned working directory (defaults to a fresh sandbox)
 * @param {number} [options.timeoutMs] - Inner execFileSync timeout. Increase
 *   for commands that do heavy I/O on Windows (e.g. `forge reinstall --force`
 *   which chains resetHard + full setup).
 */
function runForge(args, { cwd, timeoutMs = CLI_TIMEOUT_MS } = {}) {
  const tmpDir = cwd || sandboxes.makeSandbox();

  // Caller-supplied dirs still need AGENTS.md so first-run detection doesn't block us.
  if (!fs.existsSync(path.join(tmpDir, 'AGENTS.md'))) {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Test', 'utf-8');
  }

  const { stdout, stderr, status } = runForgeIn(tmpDir, args, { timeoutMs });
  return { stdout, stderr, exitCode: status };
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
      const tmpDir = sandboxes.makeSandbox();
      fs.mkdirSync(path.join(tmpDir, '.forge'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.forge', 'setup-state.json'), '{}', 'utf-8');

      const result = runForge(['reset', '--soft', '--force'], { cwd: tmpDir });
      const output = result.stdout + result.stderr;

      // Should not show help, should perform the reset
      expect(output).not.toContain('Usage:');
      // .forge should be removed
      expect(fs.existsSync(path.join(tmpDir, '.forge'))).toBe(false);
    });

    test('recognizes --hard flag', () => {
      const tmpDir = sandboxes.makeSandbox();
      fs.mkdirSync(path.join(tmpDir, '.forge'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.forge', 'setup-state.json'), '{}', 'utf-8');

      const result = runForge(['reset', '--hard', '--force'], { cwd: tmpDir });
      const output = result.stdout + result.stderr;

      expect(output).not.toContain('Usage:');
      expect(fs.existsSync(path.join(tmpDir, '.forge'))).toBe(false);
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

    test('with --force performs reset', () => {
      const tmpDir = sandboxes.makeSandbox();
      fs.mkdirSync(path.join(tmpDir, '.forge'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.forge', 'setup-state.json'), '{}', 'utf-8');

      // `forge reinstall --force` chains resetHard + full setup flow
      // (handleSetupCommand with claude agent). On Windows CI that can exceed
      // the default 10s execFileSync timeout — bump the inner timeout to 55s
      // so it completes before bun test's outer 60s test-case timeout fires.
      const result = runForge(['reinstall', '--force'], { cwd: tmpDir, timeoutMs: 55000 });
      const output = result.stdout + result.stderr;

      // resetHard removes the pre-existing .forge (the empty setup-state.json marker),
      // then setup re-runs and lands a FRESH .forge (hook scripts under .forge/hooks).
      // So the post-condition is a reinstalled .forge, not its absence — and the original
      // empty marker must be gone (proving the reset half ran).
      expect(output).toContain('Reinstall complete');
      const stateFile = path.join(tmpDir, '.forge', 'setup-state.json');
      const originalMarkerSurvived =
        fs.existsSync(stateFile) && fs.readFileSync(stateFile, 'utf-8').trim() === '{}';
      expect(originalMarkerSurvived).toBe(false);
    }, 60000);
  });
});
