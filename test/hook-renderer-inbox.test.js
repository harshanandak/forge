'use strict';

const { describe, test, expect } = require('bun:test');

const {
  FORGE_HOOK_CONTRACT,
  FORGE_INBOX_CONTEXT_MARKER,
  USER_PROMPT_SUBMIT_SUPPORT,
  userPromptSubmitCapability,
  renderClaudeHooks,
  mergeClaudeSettings,
} = require('../lib/hook-renderer');

describe('inbox-pickup context intent', () => {
  test('the contract carries a fail-open inbox-pickup context intent', () => {
    const intent = FORGE_HOOK_CONTRACT.intents.find(i => i.id === 'inbox-pickup');
    expect(intent).toBeDefined();
    expect(intent.kind).toBe('context');
    expect(intent.cliAction).toBe('inbox-pickup');
    expect(intent.lifecycle).toBe('user-prompt-submit');
  });
});

describe('USER_PROMPT_SUBMIT_SUPPORT — honest capability matrix', () => {
  test('only Claude renders; others carry explicit skip reasons', () => {
    expect(userPromptSubmitCapability('claude')).toEqual({ rendered: true });
    expect(USER_PROMPT_SUBMIT_SUPPORT.cursor.rendered).toBe(false);
    expect(USER_PROMPT_SUBMIT_SUPPORT.cursor.reason).toBe('no-user-prompt-surface');
    expect(USER_PROMPT_SUBMIT_SUPPORT.codex.reason).toBe('global-config');
    expect(USER_PROMPT_SUBMIT_SUPPORT.hermes.reason).toBe('global-config');
    expect(userPromptSubmitCapability('unknown')).toEqual({ rendered: false, reason: 'unknown-harness' });
  });
});

describe('renderClaudeHooks — UserPromptSubmit block', () => {
  test('emits a UserPromptSubmit group invoking hooks inbox-pickup', () => {
    const rendered = renderClaudeHooks(FORGE_HOOK_CONTRACT);
    expect(Array.isArray(rendered.UserPromptSubmit)).toBe(true);
    const command = rendered.UserPromptSubmit[0].hooks[0].command;
    expect(command).toContain('hooks inbox-pickup');
    expect(command).toContain('--harness claude');
    // SessionStart (memory-inject) is preserved alongside it
    expect(rendered.SessionStart[0].hooks[0].command).toContain('hooks session-start');
  });
});

describe('merge idempotency recognizes the inbox context marker', () => {
  test('re-merging replaces the Forge UserPromptSubmit entry in place (no duplication)', () => {
    const once = mergeClaudeSettings('{}', FORGE_HOOK_CONTRACT);
    const twice = mergeClaudeSettings(once, FORGE_HOOK_CONTRACT);
    const parsed = JSON.parse(twice);
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toContain(FORGE_INBOX_CONTEXT_MARKER);
  });

  test('a user UserPromptSubmit entry is preserved next to the Forge one', () => {
    const withUser = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'my-own-hook.js' }] }] } });
    const merged = JSON.parse(mergeClaudeSettings(withUser, FORGE_HOOK_CONTRACT));
    const commands = merged.hooks.UserPromptSubmit.flatMap(g => g.hooks.map(h => h.command));
    expect(commands).toContain('my-own-hook.js');
    expect(commands.some(c => c.includes(FORGE_INBOX_CONTEXT_MARKER))).toBe(true);
  });
});
