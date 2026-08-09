'use strict';

const { describe, expect, test } = require('bun:test');
const {
  FORGE_HOOK_CONTRACT,
  readAttentionCapability,
  renderClaudeHooks,
  mergeClaudeSettings,
} = require('../lib/hook-renderer');

describe('Read-attention memory hook', () => {
  test('Claude renders a supported PreToolUse:Read context hook', () => {
    const hooks = renderClaudeHooks(FORGE_HOOK_CONTRACT);
    const readGroup = hooks.PreToolUse.find(group => group.matcher === 'Read');
    expect(readGroup.hooks).toHaveLength(1);
    expect(readGroup.hooks[0].command).toContain('hooks read-attention --harness claude');
  });

  test('unsupported harnesses report an honest skip', () => {
    expect(readAttentionCapability('claude')).toEqual({ rendered: true });
    expect(readAttentionCapability('cursor')).toEqual({ rendered: false, reason: 'no-read-context-surface' });
    expect(readAttentionCapability('codex')).toEqual({ rendered: false, reason: 'global-config' });
    expect(readAttentionCapability('hermes')).toEqual({ rendered: false, reason: 'global-config' });
  });

  test('re-render replaces the Forge hook without duplicating user Read hooks', () => {
    const existing = JSON.stringify({ hooks: { PreToolUse: [
      { matcher: 'Read', hooks: [{ type: 'command', command: 'node user-read.js' }] },
    ] } });
    const twice = mergeClaudeSettings(mergeClaudeSettings(existing, FORGE_HOOK_CONTRACT), FORGE_HOOK_CONTRACT);
    const commands = JSON.parse(twice).hooks.PreToolUse
      .filter(group => group.matcher === 'Read')
      .flatMap(group => group.hooks.map(hook => hook.command));
    expect(commands.filter(command => command.includes('hooks read-attention'))).toHaveLength(1);
    expect(commands).toContain('node user-read.js');
  });
});
