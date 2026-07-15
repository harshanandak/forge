'use strict';

const { describe, test, expect } = require('bun:test');

const {
  FORGE_HOOK_CONTRACT,
  HARNESS_HOOK_FILES,
  FORGE_CONTEXT_MARKER,
  SESSION_START_SUPPORT,
  SESSION_END_SUPPORT,
  sessionStartCapability,
  sessionEndCapability,
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
  test('declares enforcement (protected-path, tdd-gate) + context (memory-inject, inbox-pickup, memory-capture) intents', () => {
    expect(FORGE_HOOK_CONTRACT.kind).toBe('forge.hookContract');
    const ids = FORGE_HOOK_CONTRACT.intents.map(i => i.id);
    expect(ids).toEqual(['protected-path', 'tdd-gate', 'memory-inject', 'inbox-pickup', 'memory-capture']);
    // Each context intent routes to the `forge` CLI via a `hooks <cliAction>` marker.
    const CONTEXT_MARKERS = {
      'memory-inject': FORGE_CONTEXT_MARKER,
      'inbox-pickup': 'hooks inbox-pickup',
      'memory-capture': 'hooks capture',
    };
    for (const intent of FORGE_HOOK_CONTRACT.intents) {
      expect(typeof intent.enforces).toBe('string');
      expect(intent.enforces.length).toBeGreaterThan(0);
      if (intent.kind === 'enforcement') {
        // Enforcement intents route through the self-contained adapter, fail-closed.
        expect(intent.command).toContain(FORGE_MARK);
        expect(intent.command).toContain(`--intent ${intent.id}`);
      } else {
        // Context intents route to the `forge` CLI, fail-open — no adapter marker.
        expect(intent.kind).toBe('context');
        expect(intent.command).toContain(CONTEXT_MARKERS[intent.id]);
        expect(intent.command).not.toContain(FORGE_MARK);
      }
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

describe('SessionStart context injection (memory push)', () => {
  test('Claude renders a SessionStart group wired to the forge CLI digest command', () => {
    const block = renderClaudeHooks(FORGE_HOOK_CONTRACT);
    expect(Array.isArray(block.SessionStart)).toBe(true);
    expect(block.SessionStart.length).toBe(1);
    const cmd = block.SessionStart[0].hooks[0].command;
    expect(cmd).toContain('hooks session-start --harness claude');
    // Context hook goes through the CLI, NOT the self-contained enforcement adapter.
    expect(cmd).not.toContain(FORGE_MARK);
    expect(cmd).toContain(FORGE_CONTEXT_MARKER);
  });

  test('MAJOR-3: rendered command is a RESOLVED node invocation, never bare `forge`', () => {
    const cmd = renderClaudeHooks(FORGE_HOOK_CONTRACT).SessionStart[0].hooks[0].command;
    // A bare `forge` on a minimal PATH would silently no-op or run a foreign binary
    // whose stdout gets injected as context. Must resolve the exact bin/forge.js.
    expect(cmd.startsWith('node ')).toBe(true);
    expect(cmd).not.toMatch(/^forge\b/);
    expect(cmd).toContain('bin');
    expect(cmd).toContain('forge.js');
  });

  test('capability matrix is honest — only Claude renders; others carry a skip reason', () => {
    expect(sessionStartCapability('claude')).toEqual({ rendered: true });
    expect(sessionStartCapability('cursor')).toEqual({ rendered: false, reason: 'no-session-start-surface' });
    expect(sessionStartCapability('codex')).toEqual({ rendered: false, reason: 'global-config' });
    expect(sessionStartCapability('hermes')).toEqual({ rendered: false, reason: 'global-config' });
    expect(sessionStartCapability('nope')).toEqual({ rendered: false, reason: 'unknown-harness' });
    // The exported matrix matches the capability function (single source).
    expect(SESSION_START_SUPPORT.claude.rendered).toBe(true);
  });

  test('Cursor does NOT fake a session-start surface (no context hook rendered)', () => {
    const cfg = renderCursorHooks(FORGE_HOOK_CONTRACT);
    const allCommands = Object.values(cfg.hooks).flat().map(h => h.command).join('\n');
    expect(allCommands).not.toContain('session-start');
  });

  test('merging the SessionStart group is idempotent (both markers detected)', () => {
    const once = mergeClaudeSettings('', FORGE_HOOK_CONTRACT);
    const twice = mergeClaudeSettings(once, FORGE_HOOK_CONTRACT);
    const a = JSON.parse(once);
    const b = JSON.parse(twice);
    expect(a.hooks.SessionStart.length).toBe(1);
    expect(b.hooks.SessionStart.length).toBe(1);
    const cmd = b.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain('session-start');
  });

  test('merging preserves a user\'s own SessionStart hook', () => {
    const existing = JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node user-welcome.js' }] }] },
    }, null, 2);
    const obj = JSON.parse(mergeClaudeSettings(existing, FORGE_HOOK_CONTRACT));
    const commands = obj.hooks.SessionStart.flatMap(g => g.hooks.map(h => h.command));
    expect(commands).toContain('node user-welcome.js');                 // user hook preserved
    expect(commands.some(c => c.includes(FORGE_CONTEXT_MARKER))).toBe(true); // Forge added
  });
});

describe('PreCompact + Stop capture-on-exit (memory capture)', () => {
  test('Claude renders PreCompact and Stop groups wired to `forge hooks capture`', () => {
    const block = renderClaudeHooks(FORGE_HOOK_CONTRACT);
    for (const [event, trigger] of [['PreCompact', 'precompact'], ['Stop', 'stop']]) {
      expect(Array.isArray(block[event])).toBe(true);
      expect(block[event].length).toBe(1);
      const cmd = block[event][0].hooks[0].command;
      expect(cmd).toContain('hooks capture --harness claude');
      // The event stamps the trigger so the CLI never needs to read hook stdin.
      expect(cmd).toContain(`--trigger ${trigger}`);
      // Context hook goes through the CLI, NOT the self-contained enforcement adapter.
      expect(cmd).not.toContain(FORGE_MARK);
      expect(cmd).toContain('hooks capture');
      // A RESOLVED node invocation, never a bare `forge`.
      expect(cmd.startsWith('node ')).toBe(true);
      expect(cmd).toContain('forge.js');
    }
  });

  test('capability matrix is honest — only Claude captures; others carry a skip reason', () => {
    expect(sessionEndCapability('claude')).toEqual({ rendered: true });
    expect(sessionEndCapability('cursor')).toEqual({ rendered: false, reason: 'no-session-end-surface' });
    expect(sessionEndCapability('codex')).toEqual({ rendered: false, reason: 'global-config' });
    expect(sessionEndCapability('hermes')).toEqual({ rendered: false, reason: 'global-config' });
    expect(sessionEndCapability('nope')).toEqual({ rendered: false, reason: 'unknown-harness' });
    expect(SESSION_END_SUPPORT.claude.rendered).toBe(true);
  });

  test('Cursor does NOT fake a capture surface (no capture hook rendered)', () => {
    const cfg = renderCursorHooks(FORGE_HOOK_CONTRACT);
    const allCommands = Object.values(cfg.hooks).flat().map(h => h.command).join('\n');
    expect(allCommands).not.toContain('hooks capture');
  });

  test('merging PreCompact + Stop groups is idempotent and preserves user hooks', () => {
    const existing = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node user-stop.js' }] }] },
    }, null, 2);
    const once = mergeClaudeSettings(existing, FORGE_HOOK_CONTRACT);
    const twice = mergeClaudeSettings(once, FORGE_HOOK_CONTRACT);
    const b = JSON.parse(twice);
    expect(b.hooks.PreCompact.length).toBe(1);
    // user Stop hook + one Forge Stop group, idempotent across a re-merge.
    const stopCommands = b.hooks.Stop.flatMap(g => g.hooks.map(h => h.command));
    expect(stopCommands).toContain('node user-stop.js');
    expect(stopCommands.filter(c => c.includes('hooks capture')).length).toBe(1);
  });

  test('a user hook that merely CONTAINS "hooks capture" survives re-merge (not clobbered)', () => {
    // CodeRabbit MAJOR on #397: the Forge-ownership check must key on the full resolved Forge
    // invocation, NOT the bare `hooks capture` verb — otherwise a user's own command that just
    // mentions "hooks capture" would be treated as Forge-owned and DELETED on re-merge.
    const userCmd = 'node my-capture-tool.js hooks capture --to sentry';
    const existing = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: userCmd }] }] },
    }, null, 2);
    const once = mergeClaudeSettings(existing, FORGE_HOOK_CONTRACT);
    const twice = mergeClaudeSettings(once, FORGE_HOOK_CONTRACT);
    const b = JSON.parse(twice);
    const stopCommands = b.hooks.Stop.flatMap(g => g.hooks.map(h => h.command));
    expect(stopCommands).toContain(userCmd); // user hook preserved across a double-merge
    // exactly one Forge capture group is maintained (the resolved forge.js invocation).
    expect(stopCommands.filter(c => c.includes('forge.js') && c.includes('hooks capture')).length).toBe(1);
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
