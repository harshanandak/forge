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
});

describe('commandTouchesProtectedPath (Cursor beforeShellExecution deny path)', () => {
  test('denies WRITE-intent shell commands touching protected paths', () => {
    expect(adapter.commandTouchesProtectedPath('rm -rf .forge')).toBe(true);
    expect(adapter.commandTouchesProtectedPath('echo hacked > AGENTS.md')).toBe(true);
    expect(adapter.commandTouchesProtectedPath('sed -i s/a/b/ lefthook.yml')).toBe(true);
    expect(adapter.commandTouchesProtectedPath('mv .env.local /tmp/steal')).toBe(true);
    expect(adapter.commandTouchesProtectedPath('cat secrets | tee .forge/config.yaml')).toBe(true);
  });

  test('allows READS of protected paths (protected-path guards writes, like Claude Write|Edit)', () => {
    expect(adapter.commandTouchesProtectedPath('cat .forge/config.yaml')).toBe(false);
    expect(adapter.commandTouchesProtectedPath('ls .forge')).toBe(false);
    expect(adapter.commandTouchesProtectedPath('grep foo AGENTS.md')).toBe(false);
  });

  test('allows write commands on unprotected paths + non-write commands', () => {
    expect(adapter.commandTouchesProtectedPath('rm -rf dist')).toBe(false);
    expect(adapter.commandTouchesProtectedPath('git status')).toBe(false);
    expect(adapter.commandTouchesProtectedPath('')).toBe(false);
    expect(adapter.commandTouchesProtectedPath(null)).toBe(false);
  });

  test('decide() denies a protected-path intent via the shell command when no file path present', () => {
    const denied = adapter.decide({ intent: 'protected-path', input: { command: 'rm -rf .forge' } });
    expect(denied.decision).toBe('deny');
    const readOk = adapter.decide({ intent: 'protected-path', input: { command: 'cat .forge/config.yaml' } });
    expect(readOk.decision).toBe('allow');
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

describe('config-honest enforcement (disabled gate/rail => inert hook)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  function makeProject(configYaml) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hook-cfg-'));
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    if (configYaml !== null) {
      fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), configYaml, 'utf8');
    }
    return root;
  }

  test('resolveEnforcement: no config => enforcement ON (tddEnabled true, protectedPaths null)', () => {
    const root = makeProject(null);
    const e = adapter.resolveEnforcement(root);
    expect(e.tddEnabled).toBe(true);
    expect(e.protectedPaths).toBe(null);
  });

  test('resolveEnforcement: workflow.gates rail.tdd_intent disabled => tddEnabled false', () => {
    const root = makeProject('workflow:\n  gates:\n    "rail.tdd_intent":\n      enabled: false\n');
    expect(adapter.resolveEnforcement(root).tddEnabled).toBe(false);
  });

  test('resolveEnforcement: top-level rails.tdd_intent disabled => tddEnabled false', () => {
    const root = makeProject('rails:\n  tdd_intent:\n    enabled: false\n');
    expect(adapter.resolveEnforcement(root).tddEnabled).toBe(false);
  });

  test('resolveEnforcement: empty protectedPaths => [] (protected-path inert)', () => {
    const root = makeProject('protectedPaths: []\n');
    expect(adapter.resolveEnforcement(root).protectedPaths).toEqual([]);
  });

  test('decide: tdd-gate is INERT (allow, never runs check) when tddEnabled false', () => {
    let called = false;
    const d = adapter.decide({
      intent: 'tdd-gate',
      input: { tool_input: { command: 'git commit -m "wip"' } },
      runTddCheck: () => { called = true; return 1; },
      enforcement: { tddEnabled: false, protectedPaths: null },
    });
    expect(d.decision).toBe('allow');
    expect(called).toBe(false);
  });

  test('decide: protected-path is INERT (allow) when protectedPaths resolves empty', () => {
    const d = adapter.decide({
      intent: 'protected-path',
      input: { tool_input: { file_path: '.forge/config.yaml' } },
      enforcement: { tddEnabled: true, protectedPaths: [] },
    });
    expect(d.decision).toBe('allow');
  });

  test('decide: default (no enforcement arg) preserves ON behavior', () => {
    const denied = adapter.decide({ intent: 'protected-path', input: { tool_input: { file_path: '.forge/config.yaml' } } });
    expect(denied.decision).toBe('deny');
    const tdd = adapter.decide({ intent: 'tdd-gate', input: { tool_input: { command: 'git commit' } }, runTddCheck: () => 1 });
    expect(tdd.decision).toBe('deny');
  });

  test('isEnforcementActive: single flag-agnostic predicate for each kind', () => {
    const tddOff = makeProject('workflow:\n  gates:\n    "rail.tdd_intent":\n      enabled: false\n');
    expect(adapter.isEnforcementActive('tdd', tddOff)).toBe(false);
    const ppEmpty = makeProject('protectedPaths: []\n');
    expect(adapter.isEnforcementActive('protected-path', ppEmpty)).toBe(false);
    const none = makeProject(null);
    expect(adapter.isEnforcementActive('tdd', none)).toBe(true);
    expect(adapter.isEnforcementActive('protected-path', none)).toBe(true); // unset → built-in set active
  });

  test('unparseable config FAILS TOWARD enforcement (__raw fallback: TDD ON, protectedPaths built-in)', () => {
    // An unterminated flow sequence makes YAML.parse throw, so loadConfigObject
    // returns { __raw }. It contains neither a `rail.tdd_intent ... enabled: false`
    // block nor a literal `protectedPaths: []`, so the raw-scan must NOT silently
    // drop either gate: corrupt config keeps TDD ON and protected-path on the
    // built-in set (protectedPaths === null), never inert (issue eda6d866).
    const corrupt = makeProject("protectedPaths: ['.forge/config.yaml'\n");
    const e = adapter.resolveEnforcement(corrupt);
    expect(e.tddEnabled).toBe(true);
    expect(e.protectedPaths).toBe(null); // → built-in PROTECTED_PATTERNS, not silently disabled
    expect(adapter.isEnforcementActive('tdd', corrupt)).toBe(true);
    expect(adapter.isEnforcementActive('protected-path', corrupt)).toBe(true);
  });
});

describe('config-driven protected paths (config is the source of truth)', () => {
  test('globToRegExp: ** spans separators, * stays within a segment', () => {
    expect(adapter.globToRegExp('.github/workflows/**').test('.github/workflows/ci.yml')).toBe(true);
    expect(adapter.globToRegExp('*.env').test('prod.env')).toBe(true);
    expect(adapter.globToRegExp('*.env').test('config/prod.env')).toBe(true); // (^|/) prefix
    expect(adapter.globToRegExp('AGENTS.md').test('AGENTS-x.md')).toBe(false);
  });

  test('decide protects EXACTLY the configured list, not the hardcoded set', () => {
    const enforcement = { tddEnabled: true, protectedPaths: ['.github/workflows/**'] };
    // In the configured list → deny
    expect(adapter.decide({ intent: 'protected-path', input: { tool_input: { file_path: '.github/workflows/ci.yml' } }, enforcement }).decision).toBe('deny');
    // A hardcoded-set path NOT in config → allowed (config is authoritative)
    expect(adapter.decide({ intent: 'protected-path', input: { tool_input: { file_path: '.forge/config.yaml' } }, enforcement }).decision).toBe('allow');
  });

  test('shell-command scan honors the configured matcher', () => {
    const enforcement = { tddEnabled: true, protectedPaths: ['.forge/config.yaml'] };
    expect(adapter.decide({ intent: 'protected-path', input: { command: 'echo x > .forge/config.yaml' }, enforcement }).decision).toBe('deny');
    expect(adapter.decide({ intent: 'protected-path', input: { command: 'rm -rf .github' }, enforcement }).decision).toBe('allow');
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
