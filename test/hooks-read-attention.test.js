'use strict';

const { describe, expect, test } = require('bun:test');
const hooks = require('../lib/commands/hooks');

describe('forge hooks read-attention', () => {
  const input = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/repo/lib/parser.js' } });
  const notes = [{ note: 'Parser requires a byte cap.', tags: ['path:lib/parser.js'] }];

  test('Claude emits path-matched PreToolUse additionalContext', async () => {
    let fetchOptions;
    const result = await hooks.handler(['read-attention', '--harness', 'claude'], {}, '/repo', {
      readInput: () => input,
      fetchNotes: (_root, options) => { fetchOptions = options; return notes; },
    });
    const payload = JSON.parse(result.output);
    expect(payload.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(payload.hookSpecificOutput.additionalContext).toContain('Parser requires a byte cap.');
    expect(fetchOptions.noteLimit).toBe(100);
  });

  test('unrelated paths and unsupported harnesses emit no context', async () => {
    const unrelated = await hooks.handler(['read-attention', '--harness', 'claude'], {}, '/repo', {
      readInput: () => JSON.stringify({ tool_input: { file_path: '/repo/lib/other.js' } }),
      fetchNotes: () => notes,
    });
    expect(unrelated.output).toBe('');
    const unsupported = await hooks.handler(['read-attention', '--harness', 'codex'], {}, '/repo', {
      readInput: () => input,
      fetchNotes: () => notes,
    });
    expect(unsupported).toEqual({ success: true, output: '', reason: 'global-config' });
  });
});
