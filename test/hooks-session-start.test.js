'use strict';

const { describe, test, expect } = require('bun:test');

const hooks = require('../lib/commands/hooks');

const NOTES = [{ note: 'Kernel is the single source of truth', timestamp: '2026-07-10T09:00:00.000Z' }];
const READY = [{ id: 'r1', title: 'Wire auto-file rail' }];

function run(args, opts) {
  return hooks.handler(args, {}, '/root', opts);
}

describe('forge hooks session-start (context hook — memory push)', () => {
  test('claude emits SessionStart JSON with the digest as additionalContext', async () => {
    const res = await run(['session-start', '--harness', 'claude'], {
      fetchNotes: () => NOTES,
      fetchIssues: (_root, kind) => (kind === 'ready' ? READY : []),
    });
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output); // must be valid JSON
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Kernel is the single source of truth');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('[ready] Wire auto-file rail');
  });

  test('empty digest → empty output (harness injects nothing), exit-safe', async () => {
    const res = await run(['session-start', '--harness', 'claude'], {
      fetchNotes: () => [],
      fetchIssues: () => [],
    });
    expect(res.success).toBe(true);
    expect(res.output).toBe('');
  });

  test('unsupported harness (cursor) → empty output (honest no-op)', async () => {
    const res = await run(['session-start', '--harness', 'cursor'], {
      fetchNotes: () => NOTES,
      fetchIssues: () => READY,
    });
    expect(res.success).toBe(true);
    expect(res.output).toBe('');
  });

  test('fail-open: a throwing fetcher never errors the hook', async () => {
    const res = await run(['session-start', '--harness', 'claude'], {
      fetchNotes: () => { throw new Error('kernel down'); },
      fetchIssues: () => { throw new Error('issue store down'); },
    });
    expect(res.success).toBe(true);
    expect(res.output).toBe('');
  });

  test('default harness is claude when --harness omitted', async () => {
    const res = await run(['session-start'], { fetchNotes: () => NOTES, fetchIssues: () => [] });
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
  });
});
