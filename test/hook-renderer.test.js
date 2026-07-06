'use strict';

const { describe, test, expect } = require('bun:test');

const {
  FORGE_HOOK_CONTRACT,
  HARNESS_HOOK_FILES,
  HookConfigParseError,
  renderClaudeHooks,
  renderCursorHooks,
  renderCodexHooksToml,
  renderHermesHooksYaml,
  mergeClaudeSettings,
  mergeCursorHooks,
  renderHookConfig,
} = require('../lib/hook-renderer');

// The native hook renderer projects Forge's TDD-gate + protected-path enforcement
// onto each harness's REAL native hook surface, mirroring the MCP config renderer:
//   - Claude : .claude/settings.json  (a `hooks` block)
//   - Cursor : .cursor/hooks.json     (Cursor 1.7+ agent hooks, { version: 1, hooks })
//   - Codex  : .codex/config.toml     ([hooks]) — GLOBAL-config scope, rendered but NOT written
//   - Hermes : ~/.hermes/config.yaml  (`hooks:` shell hooks) — GLOBAL-config scope, rendered but NOT written
// The rendered commands invoke Forge's installed native-hook adapter
// (.forge/hooks/forge-native-hook.js), which delegates the TDD gate to the real
// installed check-tdd.js and enforces protected paths.

const FORGE_MARK = 'forge-native-hook.js';

describe('Forge hook contract', () => {
  test('declares the TDD-gate and protected-path enforcement intents', () => {
    expect(FORGE_HOOK_CONTRACT.kind).toBe('forge.hookContract');
    const ids = FORGE_HOOK_CONTRACT.intents.map(i => i.id);
    expect(ids).toEqual(['protected-path', 'tdd-gate']);
    for (const intent of FORGE_HOOK_CONTRACT.intents) {
      expect(intent.command).toContain(FORGE_MARK);
      expect(intent.command).toContain(`--intent ${intent.id}`);
      expect(typeof intent.enforces).toBe('string');
      expect(intent.enforces.length).toBeGreaterThan(0);
    }
  });

  test('maps each harness to its native hook config file', () => {
    expect(HARNESS_HOOK_FILES.claude).toBe('.claude/settings.json');
    expect(HARNESS_HOOK_FILES.cursor).toBe('.cursor/hooks.json');
    expect(HARNESS_HOOK_FILES.codex).toBe('.codex/config.toml');
  });
});

describe('renderClaudeHooks (.claude/settings.json hooks block)', () => {
  test('renders a PreToolUse block that denies protected writes and gates commits', () => {
    const block = renderClaudeHooks(FORGE_HOOK_CONTRACT);
    expect(Array.isArray(block.PreToolUse)).toBe(true);

    const writeGroup = block.PreToolUse.find(g => /Write/.test(g.matcher) && /Edit/.test(g.matcher));
    expect(writeGroup).toBeDefined();
    expect(writeGroup.hooks[0].type).toBe('command');
    expect(writeGroup.hooks[0].command).toContain('--intent protected-path');
    expect(writeGroup.hooks[0].command).toContain('--harness claude');

    const bashGroup = block.PreToolUse.find(g => g.matcher === 'Bash');
    expect(bashGroup).toBeDefined();
    expect(bashGroup.hooks[0].command).toContain('--intent tdd-gate');
    expect(bashGroup.hooks[0].command).toContain('--harness claude');
  });

  test('Claude command references the adapter via $CLAUDE_PROJECT_DIR (cwd-independent)', () => {
    // Claude runs hook commands from an arbitrary cwd; $CLAUDE_PROJECT_DIR is the
    // documented, cwd-independent way to reach a project-local script. A bare relative
    // path would break. See https://code.claude.com/docs/en/hooks.
    const block = renderClaudeHooks(FORGE_HOOK_CONTRACT);
    for (const group of block.PreToolUse) {
      const cmd = group.hooks[0].command;
      expect(cmd).toContain('$CLAUDE_PROJECT_DIR');
      expect(cmd).toContain(FORGE_MARK); // still marked Forge-owned for idempotent re-merge
    }
  });
});

describe('renderCursorHooks (.cursor/hooks.json)', () => {
  test('renders version 1 with before* gating events (Cursor has no pre-edit deny)', () => {
    const cfg = renderCursorHooks(FORGE_HOOK_CONTRACT);
    expect(cfg.version).toBe(1);

    // Cursor cannot deny a pre-edit; write-blocking + commit gating go through the
    // shell surface, and afterFileEdit is an observational audit.
    const shell = cfg.hooks.beforeShellExecution.map(h => h.command).join('\n');
    expect(shell).toContain('--intent tdd-gate');
    expect(shell).toContain('--intent protected-path');
    expect(shell).toContain('--harness cursor');

    const afterEdit = cfg.hooks.afterFileEdit.map(h => h.command).join('\n');
    expect(afterEdit).toContain('--intent protected-path');
    expect(afterEdit).toContain('--harness cursor');
  });

  test('Cursor command uses a repo-relative adapter path (Cursor has no $CLAUDE_PROJECT_DIR)', () => {
    const cfg = renderCursorHooks(FORGE_HOOK_CONTRACT);
    const cmd = cfg.hooks.beforeShellExecution[0].command;
    expect(cmd).not.toContain('CLAUDE_PROJECT_DIR');
    expect(cmd).toContain('.forge/hooks/forge-native-hook.js');
  });
});

describe('renderCodexHooksToml (global-config only — rendered, never written by setup)', () => {
  test('produces a [hooks] TOML block wired to the Forge adapter', () => {
    const toml = renderCodexHooksToml(FORGE_HOOK_CONTRACT);
    expect(typeof toml).toBe('string');
    expect(toml).toContain('[hooks');
    expect(toml).toContain(FORGE_MARK);
    expect(toml).toContain('--intent tdd-gate');
    expect(toml).toContain('--intent protected-path');
  });
});

describe('renderHermesHooksYaml (global-config only — rendered, never written by setup)', () => {
  test('produces a `hooks:` block with pre_tool_call matchers wired to the Forge adapter', () => {
    const yaml = renderHermesHooksYaml(FORGE_HOOK_CONTRACT);
    expect(typeof yaml).toBe('string');
    expect(yaml).toContain('hooks:');
    expect(yaml).toContain('pre_tool_call:');
    // write tools (write_file|patch) → protected-path; shell (terminal) → tdd-gate
    expect(yaml).toMatch(/matcher: "write_file\|patch"/);
    expect(yaml).toMatch(/matcher: "terminal"/);
    expect(yaml).toContain('--intent protected-path');
    expect(yaml).toContain('--intent tdd-gate');
    expect(yaml).toContain('--harness hermes');
    expect(yaml).toContain(FORGE_MARK);
  });
});

describe('renderHookConfig — global-config harnesses are honestly skipped, never written', () => {
  test.each(['codex', 'hermes'])('%s returns a global-config skip without touching disk', (harness) => {
    const res = renderHookConfig({ harness, targetRoot: '/nonexistent-should-not-be-written' });
    expect(res.skipped).toBe(true);
    expect(res.wrote).toBe(false);
    expect(res.scope).toBe('global-config');
  });
});

describe('mergeClaudeSettings (read -> merge -> write, preserve user config)', () => {
  test('adds the Forge hooks block to an empty settings file', () => {
    const merged = mergeClaudeSettings('', FORGE_HOOK_CONTRACT);
    const obj = JSON.parse(merged);
    expect(obj.hooks.PreToolUse.length).toBeGreaterThan(0);
    expect(merged.endsWith('\n')).toBe(true);
  });

  test('preserves unrelated settings keys and the user\'s own hook groups', () => {
    const existing = JSON.stringify({
      permissions: { allow: ['Bash(git:*)'] },
      hooks: {
        PreToolUse: [
          { matcher: 'Read', hooks: [{ type: 'command', command: 'node my-audit.js' }] },
        ],
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node notify.js' }] }],
      },
    }, null, 2);

    const obj = JSON.parse(mergeClaudeSettings(existing, FORGE_HOOK_CONTRACT));
    expect(obj.permissions.allow).toContain('Bash(git:*)');       // unrelated key preserved
    expect(obj.hooks.Stop[0].hooks[0].command).toBe('node notify.js'); // user event preserved
    const commands = obj.hooks.PreToolUse.flatMap(g => g.hooks.map(h => h.command));
    expect(commands).toContain('node my-audit.js');               // user group preserved
    expect(commands.some(c => c.includes('forge-native-hook.js'))).toBe(true); // Forge added
  });

  test('is idempotent — re-merging does not duplicate Forge groups', () => {
    const once = mergeClaudeSettings('', FORGE_HOOK_CONTRACT);
    const twice = mergeClaudeSettings(once, FORGE_HOOK_CONTRACT);
    const a = JSON.parse(once);
    const b = JSON.parse(twice);
    expect(b.hooks.PreToolUse.length).toBe(a.hooks.PreToolUse.length);
  });

  test('throws HookConfigParseError on populated-but-unparseable settings', () => {
    expect(() => mergeClaudeSettings('{ not json, }', FORGE_HOOK_CONTRACT)).toThrow(HookConfigParseError);
  });
});

describe('mergeCursorHooks (read -> merge -> write, preserve user config)', () => {
  test('writes version 1 + Forge hooks to an empty file', () => {
    const obj = JSON.parse(mergeCursorHooks('', FORGE_HOOK_CONTRACT));
    expect(obj.version).toBe(1);
    expect(obj.hooks.beforeShellExecution.length).toBeGreaterThan(0);
  });

  test('preserves the user\'s existing hook events and entries', () => {
    const existing = JSON.stringify({
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: 'node user-guard.js' }],
        beforeReadFile: [{ command: 'node secret-guard.js' }],
      },
    }, null, 2);

    const obj = JSON.parse(mergeCursorHooks(existing, FORGE_HOOK_CONTRACT));
    expect(obj.hooks.beforeReadFile[0].command).toBe('node secret-guard.js'); // user event preserved
    const shell = obj.hooks.beforeShellExecution.map(h => h.command);
    expect(shell).toContain('node user-guard.js');                            // user entry preserved
    expect(shell.some(c => c.includes('forge-native-hook.js'))).toBe(true);   // Forge added
  });

  test('is idempotent', () => {
    const once = mergeCursorHooks('', FORGE_HOOK_CONTRACT);
    const twice = mergeCursorHooks(once, FORGE_HOOK_CONTRACT);
    expect(JSON.parse(twice).hooks.beforeShellExecution.length)
      .toBe(JSON.parse(once).hooks.beforeShellExecution.length);
  });

  test('throws HookConfigParseError on populated-but-unparseable config', () => {
    expect(() => mergeCursorHooks('{ // jsonc\n }', FORGE_HOOK_CONTRACT)).toThrow(HookConfigParseError);
  });
});
