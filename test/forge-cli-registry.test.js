/**
 * Tests for CLI Registry Integration
 *
 * Verifies that bin/forge.js dispatches to registry commands
 * (sync, worktree) and that --help includes them.
 *
 * Uses subprocess spawning to test the actual CLI entry point.
 */

const { afterAll, beforeAll, describe, test, expect, setDefaultTimeout } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadCommands } = require('../lib/commands/_registry');
const {
  CASE_TIMEOUT_MS,
  FORGE_BIN: forgePath,
  createCliSandboxes,
  runForgeIn,
} = require('./helpers/cli-subprocess');

setDefaultTimeout(CASE_TIMEOUT_MS);

const sandboxes = createCliSandboxes('forge-cli-registry-');
afterAll(() => sandboxes.cleanup());

/**
 * Helper: run forge CLI with given args, return { stdout, stderr, status }.
 *
 * Each call gets a fresh private sandbox as cwd AND project root, so the spawned
 * CLI reads/writes only its own `.forge/` state. It previously ran with the repo
 * checkout as cwd, which made these tests observe (and mutate) state shared with
 * every concurrently-running shard.
 *
 * @param {string[]} cliArgs - Arguments to pass to forge
 * @param {object} [envOverrides] - Extra environment variables
 * @returns {{ stdout: string, stderr: string, status: number }}
 */
function runForge(cliArgs, envOverrides = {}) {
  return runForgeIn(sandboxes.makeSandbox(), cliArgs, { env: envOverrides });
}

/**
 * Parse the command names listed under the "Additional commands:" section of
 * `forge --help`. Each registry entry is rendered as `  <name>  <description>`
 * (two-space indent, two-or-more spaces before the description), so we match that
 * shape rather than substring-scanning the whole banner — command names like
 * `list` also appear in prose (e.g. `--agents <list>`).
 *
 * @param {string} stdout - Full `forge --help` output
 * @returns {string[]} Command names enumerated in the section
 */
function parseAdditionalCommands(stdout) {
  const idx = stdout.indexOf('Additional commands:');
  if (idx === -1) return [];
  return stdout
    .slice(idx)
    .split('\n')
    .map(line => /^ {2}(\S+) {2,}\S/.exec(line))
    .filter(Boolean)
    .map(match => match[1]);
}

let helpStdout;
let helpNames;

beforeAll(() => {
  const result = runForge(['--help']);
  expect(result.status).toBe(0);
  helpStdout = result.stdout;
  helpNames = parseAdditionalCommands(helpStdout);
});

// Bare issue passthroughs that duplicate `forge issue <sub>`. They stay routable
// as undocumented back-compat aliases but must NOT appear in `forge --help`, so the
// canonical `forge issue` surface is unambiguous (kernel issue 450c6e34).
const HIDDEN_ISSUE_ALIASES = [
  'create', 'update', 'claim', 'close', 'show', 'list',
  'ready', 'blocked', 'stale', 'orphans', 'lint', 'claims', 'issues',
];

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
      const { stdout, stderr, status } = runForge(['sync'], { PATH: '', Path: '' });
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

    test('forge issues create --help prints subcommand usage without dispatching to a backend', () => {
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

      // No backend pin: `--help` must short-circuit to the subcommand's usage BEFORE
      // any backend dispatch (kernel default or beads), so the planted fake `bd` is
      // never invoked. Guards the regression where --help was forwarded as an op arg
      // (errored "Command failed" on the kernel default; silently minted on the
      // singular path).
      const { stdout, stderr, status } = runForge(
        ['issues', 'create', '--help'],
        { PATH: `${tempDir}${path.delimiter}${process.env.PATH}` }
      );

      const combined = stdout + stderr;
      expect(status).toBe(0);
      expect(combined).toContain('forge create');
      expect(combined).not.toContain('BD CREATE HELP');
      expect(combined).not.toContain('Usage:');
      expect(combined).not.toContain('npx forge setup');
    });
  });

  describe('help includes registry commands', () => {
    test('forge --help includes sync and worktree in output', () => {
      expect(helpStdout).toMatch(/sync/i);
      expect(helpStdout).toMatch(/worktree/i);
    });

    test('forge --help includes "Additional commands" section', () => {
      expect(helpStdout).toContain('Additional commands');
    });

    test('forge --help documents the canonical `issue` surface', () => {
      expect(helpNames).toContain('issue');
    });

    test('forge --help hides the plural `issues` back-compat alias', () => {
      expect(helpNames).not.toContain('issues');
    });

    test('forge --help hides the bare issue passthrough aliases', () => {
      for (const alias of HIDDEN_ISSUE_ALIASES) {
        expect(helpNames).not.toContain(alias);
      }
    });
  });

  describe('memory noun + visible shortcuts (P1, febf7690)', () => {
    test('forge --help lists the memory noun in Additional commands', () => {
      expect(helpNames).toContain('memory');
    });

    test('forge --help moves remember/recall/insights into a Shortcuts block, not Additional commands', () => {
      // The bare verbs are no longer enumerated as top-level commands...
      for (const alias of ['remember', 'recall', 'insights']) {
        expect(helpNames).not.toContain(alias);
      }
      // ...they surface in a Shortcuts block mapping to their canonical memory sub.
      expect(helpStdout).toContain('Shortcuts');
      expect(helpStdout).toMatch(/remember\s+-> forge memory add/);
      expect(helpStdout).toMatch(/recall\s+-> forge memory recall/);
      expect(helpStdout).toMatch(/insights\s+-> forge memory insights/);
    });

    test('bare forge recall --help still prints recall usage (passthrough fix keeps --help parsed)', () => {
      // Regression guard: if the memory shortcuts leaked into the bd flag-passthrough
      // set, --help would reach the recall handler as a query instead of short-circuiting.
      const { stdout, stderr, status } = runForge(['recall', '--help']);
      const combined = stdout + stderr;
      expect(status).toBe(0);
      expect(combined).toContain('forge recall');
      expect(combined).not.toContain('FORGE_SETUP_REQUIRED');
    });

    test('bare forge remember --help still prints remember usage', () => {
      const { stdout, stderr, status } = runForge(['remember', '--help']);
      const combined = stdout + stderr;
      expect(status).toBe(0);
      expect(combined).toContain('forge remember');
    });

    test('forge memory --help prints the memory noun surface', () => {
      const { stdout, stderr, status } = runForge(['memory', '--help']);
      const combined = stdout + stderr;
      expect(status).toBe(0);
      expect(combined).toContain('memory');
    });
  });

  describe('hidden issue aliases stay executable (back-compat)', () => {
    test('hidden aliases remain routable in the registry', () => {
      const { commands } = loadCommands(path.join(__dirname, '..', 'lib', 'commands'));
      // Canonical surface is present AND documented; the aliases keep routing even
      // though `forge --help` no longer enumerates them.
      expect(commands.has('issue')).toBe(true);
      for (const alias of HIDDEN_ISSUE_ALIASES) {
        expect(commands.has(alias)).toBe(true);
      }
    });

    test('the plural `issues` alias still executes', () => {
      // No subcommand: the issues handler returns its own usage. Proves the alias
      // dispatches rather than falling through to setup/minimal-install.
      const { stdout, status } = runForge(['issues']);
      expect(status).toBe(0);
      expect(stdout).toContain('forge issues');
      expect(stdout).not.toContain('FORGE_SETUP_REQUIRED');
    });

    test('a bare passthrough alias still executes (forge list --help)', () => {
      // `--help` short-circuits to the subcommand usage before any backend dispatch,
      // so this asserts routing without minting an issue. If the alias were removed
      // from the registry it would fall through to the setup/minimal-install path.
      const { stdout, stderr, status } = runForge(['list', '--help']);
      const combined = stdout + stderr;
      expect(status).toBe(0);
      expect(combined).toContain('forge list');
      expect(combined).not.toContain('FORGE_SETUP_REQUIRED');
      expect(combined).not.toContain('npx forge setup');
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
      // `verify` is not a registry command — it is handled by the stageId fallthrough
      // in bin/forge.js. This proves enforceStageEntry still runs for it.
      //
      // enforceStageEntry blocks this invocation via one of two gates, both of which it
      // owns: the runtime-health gate (a prerequisite is missing) OR the stage-transition
      // rule (entering `verify` from `ship` skips `review` and needs an override). Which
      // one fires depends on the ambient runtime, so we accept either — the point is only
      // that enforcement ran. We deliberately do NOT force a missing `bd` here: under the
      // default kernel backend bd is no longer a runtime prerequisite, which made the old
      // PATH-emptying assertion non-deterministic across CI runners (bd absent on ubuntu
      // cleared the runtime gate and reached the transition check instead).
      const workflowState = JSON.stringify({
        id: 'verify-transition-test',
        currentStage: 'ship',
        completedStages: ['plan', 'dev', 'validate'],
        skippedStages: [],
        workflowDecisions: { classification: 'critical' },
      });

      const { stdout, stderr, status } = runForge(
        ['verify', '--workflow-state', workflowState]
      );
      const combined = stdout + stderr;

      expect(status).toBe(1);
      expect(combined).toMatch(
        /Stage verify (is blocked from ship|blocked by runtime prerequisites)/
      );
    });
  });
});
