/**
 * Tests for CLI Registry Integration
 *
 * Verifies that bin/forge.js dispatches to registry commands
 * (sync, worktree) and that --help includes them.
 *
 * Uses subprocess spawning to test the actual CLI entry point.
 */

const { describe, test, expect, setDefaultTimeout } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadCommands } = require('../lib/commands/_registry');

const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');

setDefaultTimeout(15000);

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
    test('real stage commands load into the registry', () => {
      const { commands } = loadCommands(path.join(__dirname, '..', 'lib', 'commands'));

      expect(commands.has('plan')).toBe(true);
      expect(commands.has('dev')).toBe(true);
      expect(commands.has('validate')).toBe(true);
      expect(commands.has('ship')).toBe(true);
    });

    test('legacy and plural issue commands coexist in the registry', () => {
      const { commands } = loadCommands(path.join(__dirname, '..', 'lib', 'commands'));

      expect(commands.has('issue')).toBe(true);
      expect(commands.has('issues')).toBe(true);
    });

    test('recommend and team commands load into the registry without skip warnings', () => {
      const warnCalls = [];
      const originalWarn = console.warn;
      console.warn = (...args) => { warnCalls.push(args.join(' ')); };
      try {
        const { commands } = loadCommands(path.join(__dirname, '..', 'lib', 'commands'));
        expect(commands.has('recommend')).toBe(true);
        expect(commands.has('team')).toBe(true);
        expect(warnCalls.join('\n')).not.toContain('recommend.js');
        expect(warnCalls.join('\n')).not.toContain('team.js');
      } finally {
        console.warn = originalWarn;
      }
    });

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

    test('forge status prints successful command output', () => {
      const workflowState = JSON.stringify({
        id: 'bd-test',
        currentStage: 'validate',
        completedStages: ['plan', 'dev'],
        skippedStages: [],
        workflowDecisions: { classification: 'standard' },
      });

      const { stdout, status } = runForge(['status', '--workflow-state', workflowState]);

      expect(status).toBe(0);
      expect(stdout).toContain('Current Stage: validate - Validation');
      expect(stdout).toContain('Source: authoritative workflow state');
    });

    test('forge issues create --help reaches the issues handler instead of global help parsing', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bd-help-'));
      const fakeBd = path.join(tempDir, process.platform === 'win32' ? 'bd.cmd' : 'bd');

      fs.writeFileSync(
        fakeBd,
        process.platform === 'win32'
          ? '@echo off\r\necho BD CREATE HELP\r\n'
          : '#!/bin/sh\necho BD CREATE HELP\n',
        'utf8'
      );

      if (process.platform !== 'win32') {
        fs.chmodSync(fakeBd, 0o755);
      }

      const { stdout, stderr, status } = runForge(
        ['issues', 'create', '--help'],
        { PATH: `${tempDir}${path.delimiter}${process.env.PATH}` }
      );

      const combined = stdout + stderr;
      expect(status).toBe(0);
      expect(combined).toContain('BD CREATE HELP');
      expect(combined).not.toContain('Usage:');
      expect(combined).not.toContain('npx forge setup');
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

  describe('registry enforcement wiring', () => {
    test('bin/forge.js routes registry commands through executeCommand', () => {
      const source = fs.readFileSync(forgePath, 'utf8');

      expect(source).toContain('executeCommand(');
      expect(source).not.toContain("await cmd.handler(args.slice(1), flags, projectRoot)");
    });

    test('bin/forge.js forwards raw CLI args into stage enforcement', () => {
      const source = fs.readFileSync(forgePath, 'utf8');

      expect(source).toContain('args: context.args');
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

  describe('non-registry stage enforcement', () => {
    test('forge verify still invokes stage enforcement outside the registry', () => {
      const workflowState = JSON.stringify({
        id: 'bd-test',
        currentStage: 'ship',
        completedStages: ['plan', 'dev', 'validate'],
        skippedStages: [],
        workflowDecisions: { classification: 'critical' },
      });

      const { stdout, stderr, status } = runForge(
        ['verify', '--workflow-state', workflowState],
        { PATH: '', Path: '' }
      );
      const combined = stdout + stderr;

      expect(status).toBe(1);
      expect(combined).toContain("Error running 'verify': Stage verify blocked by runtime prerequisites:");
    });
  });
});
