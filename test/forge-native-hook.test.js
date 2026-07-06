'use strict';

const { describe, test, expect } = require('bun:test');

const adapter = require('../.forge/hooks/forge-native-hook.js');

// The native-hook adapter is invoked by the rendered Claude/Cursor hook configs.
// It reads the harness's hook stdin, enforces the protected-path set, and delegates
// the TDD gate to the installed check-tdd.js. It must be self-contained (target
// projects have .forge/hooks/*.js but NOT lib/).

describe('parseArgs', () => {
  test('reads --intent and --harness', () => {
    expect(adapter.parseArgs(['--intent', 'protected-path', '--harness', 'claude']))
      .toEqual({ intent: 'protected-path', harness: 'claude' });
  });
});

describe('extractPath', () => {
  test('reads Claude Write/Edit tool_input.file_path', () => {
    expect(adapter.extractPath({ tool_input: { file_path: '.forge/config.yaml' } })).toBe('.forge/config.yaml');
  });
  test('reads Cursor afterFileEdit top-level file_path', () => {
    expect(adapter.extractPath({ file_path: 'src/app.js' })).toBe('src/app.js');
  });
  test('reads Hermes write_file/patch tool_input.path', () => {
    expect(adapter.extractPath({ tool_input: { path: 'AGENTS.md' } })).toBe('AGENTS.md');
  });
  test('returns null when no path present (e.g. a shell event)', () => {
    expect(adapter.extractPath({ command: 'ls -la' })).toBe(null);
  });
});

describe('isProtectedPath', () => {
  test('flags Forge-core, protocol, secrets, and beads state', () => {
    expect(adapter.isProtectedPath('.forge/config.yaml')).toBe(true);
    expect(adapter.isProtectedPath('AGENTS.md')).toBe(true);
    expect(adapter.isProtectedPath('.git/config')).toBe(true);
    expect(adapter.isProtectedPath('.env')).toBe(true);
    expect(adapter.isProtectedPath('.beads/issues.db')).toBe(true);
  });
  test('allows ordinary source and test files', () => {
    expect(adapter.isProtectedPath('src/app.js')).toBe(false);
    expect(adapter.isProtectedPath('test/app.test.js')).toBe(false);
    expect(adapter.isProtectedPath('README.md')).toBe(false);
  });
});

describe('isGitCommit', () => {
  test('detects git commit invocations', () => {
    expect(adapter.isGitCommit('git commit -m "x"')).toBe(true);
    expect(adapter.isGitCommit('git add . && git commit')).toBe(true);
  });
  test('ignores non-commit commands', () => {
    expect(adapter.isGitCommit('git status')).toBe(false);
    expect(adapter.isGitCommit('npm test')).toBe(false);
  });
});

describe('decide (enforcement logic; TDD check injected for determinism)', () => {
  const allowTdd = () => 0;   // check-tdd passed
  const denyTdd = () => 1;    // check-tdd failed (violations)

  test('protected-path: DENY a write to a protected file', () => {
    const d = adapter.decide({ intent: 'protected-path', input: { tool_input: { file_path: '.forge/config.yaml' } } });
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/protected/i);
  });

  test('protected-path: ALLOW a write to an ordinary file', () => {
    const d = adapter.decide({ intent: 'protected-path', input: { tool_input: { file_path: 'src/app.js' } } });
    expect(d.decision).toBe('allow');
  });

  test('tdd-gate: DENY a git commit when check-tdd reports violations', () => {
    const d = adapter.decide({ intent: 'tdd-gate', input: { tool_input: { command: 'git commit -m "wip"' } }, runTddCheck: denyTdd });
    expect(d.decision).toBe('deny');
  });

  test('tdd-gate: ALLOW a git commit when check-tdd passes', () => {
    const d = adapter.decide({ intent: 'tdd-gate', input: { tool_input: { command: 'git commit -m "ok"' } }, runTddCheck: allowTdd });
    expect(d.decision).toBe('allow');
  });

  test('tdd-gate: ALLOW non-commit shell commands without running the check', () => {
    let called = false;
    const d = adapter.decide({ intent: 'tdd-gate', input: { command: 'ls' }, runTddCheck: () => { called = true; return 1; } });
    expect(d.decision).toBe('allow');
    expect(called).toBe(false);
  });
});

describe('formatOutput (harness-native decision contracts)', () => {
  test('Claude deny -> hookSpecificOutput.permissionDecision = deny', () => {
    const out = JSON.parse(adapter.formatOutput('claude', { decision: 'deny', reason: 'Protected path' }));
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe('Protected path');
  });

  test('Claude allow -> empty output (do not auto-approve)', () => {
    expect(adapter.formatOutput('claude', { decision: 'allow' })).toBe('');
  });

  test('Cursor deny -> { permission: deny } with an agent message', () => {
    const out = JSON.parse(adapter.formatOutput('cursor', { decision: 'deny', reason: 'Protected path' }));
    expect(out.permission).toBe('deny');
    expect(out.agentMessage).toMatch(/protected/i);
  });

  test('Cursor allow -> { permission: allow }', () => {
    const out = JSON.parse(adapter.formatOutput('cursor', { decision: 'allow' }));
    expect(out.permission).toBe('allow');
  });

  test('Hermes deny -> { action: block, message } (shell-hook wire protocol)', () => {
    const out = JSON.parse(adapter.formatOutput('hermes', { decision: 'deny', reason: 'Protected path' }));
    expect(out.action).toBe('block');
    expect(out.message).toBe('Protected path');
  });

  test('Hermes allow -> empty output (silent no-op)', () => {
    expect(adapter.formatOutput('hermes', { decision: 'allow' })).toBe('');
  });
});
