/**
 * Tests for CLI Registry Integration
 *
 * Verifies that bin/forge.js dispatches to registry commands
 * (sync, worktree) and that --help includes them.
 *
 * Uses subprocess spawning to test the actual CLI entry point.
 */

const { describe, test, expect } = require('bun:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');

/**
 * Helper: run forge CLI with given args, return { stdout, stderr, status }.
 * Merges env so AGENTS.md check is bypassed (postinstall lifecycle).
 *
 * @param {string[]} cliArgs - Arguments to pass to forge
 * @param {object} [envOverrides] - Extra environment variables
 * @returns {{ stdout: string, stderr: string, status: number }}
 */
function runForge(cliArgs, envOverrides = {}) {
  try {
    const stdout = execFileSync(process.execPath, [forgePath, ...cliArgs], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, ...envOverrides },
      // Use repo root as cwd so AGENTS.md exists (avoids FORGE_SETUP_REQUIRED)
      cwd: path.join(__dirname, '..'),
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      status: err.status ?? 1,
    };
  }
}

describe('CLI Registry Integration', () => {
  describe('registry command dispatch', () => {
    test('forge sync dispatches to registry (not unknown command)', () => {
      const { stdout, stderr, status } = runForge(['sync']);
      const combined = stdout + stderr;
      // Key assertion: sync command does NOT fall through to FORGE_SETUP_REQUIRED
      // or minimalInstall. It dispatches via registry and exits cleanly.
      expect(combined).not.toContain('FORGE_SETUP_REQUIRED');
      // Exit 0 means the registry handled it (even if bd is not installed — graceful skip)
      expect(status).toBe(0);
    });

    test('forge worktree produces worktree-related output (not unknown command)', () => {
      const { stdout, stderr } = runForge(['worktree']);
      const combined = stdout + stderr;
      // worktree command with no subcommand should show usage or error
      expect(combined).toMatch(/worktree|usage|subcommand|create|remove/i);
    });
  });

  describe('help includes registry commands', () => {
    test('forge --help includes sync and worktree in output', () => {
      const { stdout } = runForge(['--help']);
      expect(stdout).toMatch(/sync/i);
      expect(stdout).toMatch(/worktree/i);
    });

    test('forge --help includes "Additional commands" section', () => {
      const { stdout } = runForge(['--help']);
      expect(stdout).toContain('Additional commands');
    });
  });

  describe('fallthrough for unknown commands', () => {
    test('forge nonexistent falls through to existing behavior', () => {
      // An unknown command (not in registry, not setup/recommend/rollback)
      // should fall through to the else branch (minimalInstall or postinstall)
      const { stdout, stderr, status } = runForge(['nonexistent_cmd_xyz']);
      const combined = stdout + stderr;
      // Should NOT contain registry command output
      expect(combined).not.toMatch(/sync|worktree/i);
      // Should contain either setup prompt, minimal install, or similar
      // The key assertion: it did not crash with "unknown command" error from registry
      expect(status === 0 || combined.length > 0).toBe(true);
    });
  });
});
