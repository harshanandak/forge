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

  test('empty digest AND no dispatch bootstrap → empty output (harness injects nothing), exit-safe', async () => {
    // Isolate the digest path: disable the always-on using-forge dispatch bootstrap so this test
    // asserts digest-empty behavior alone (the bootstrap is covered in its own describe block).
    const res = await run(['session-start', '--harness', 'claude'], {
      loadDispatchText: () => '',
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
    // Disable the dispatch bootstrap so this isolates the digest fail-open path -> '' on throw.
    const res = await run(['session-start', '--harness', 'claude'], {
      loadDispatchText: () => '',
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

describe('forge hooks session-start (using-forge dispatch injection)', () => {
  const DISPATCH = 'Using [skill] to [purpose] — Forge dispatch bootstrap.';

  test('injects the using-forge dispatch text ahead of the memory digest', async () => {
    const res = await run(['session-start', '--harness', 'claude'], {
      loadDispatchText: () => DISPATCH,
      fetchNotes: () => NOTES,
      fetchIssues: (_root, kind) => (kind === 'ready' ? READY : []),
    });
    expect(res.success).toBe(true);
    const ctx = JSON.parse(res.output).hookSpecificOutput.additionalContext;
    expect(ctx).toContain(DISPATCH);
    expect(ctx).toContain('Kernel is the single source of truth');
    // Dispatch bootstrap is injected FIRST (before the digest).
    expect(ctx.indexOf(DISPATCH)).toBeLessThan(ctx.indexOf('Kernel is the single source of truth'));
  });

  test('dispatch bootstrap injects even when the memory digest is empty', async () => {
    const res = await run(['session-start', '--harness', 'claude'], {
      loadDispatchText: () => DISPATCH,
      fetchNotes: () => [],
      fetchIssues: () => [],
    });
    const ctx = JSON.parse(res.output).hookSpecificOutput.additionalContext;
    expect(ctx).toContain(DISPATCH);
  });

  test('dispatch bootstrap survives a throwing digest fetcher (fail-open)', async () => {
    const res = await run(['session-start', '--harness', 'claude'], {
      loadDispatchText: () => DISPATCH,
      fetchNotes: () => { throw new Error('kernel down'); },
      fetchIssues: () => { throw new Error('issue store down'); },
    });
    expect(res.success).toBe(true);
    const ctx = JSON.parse(res.output).hookSpecificOutput.additionalContext;
    expect(ctx).toContain(DISPATCH);
  });

  test('unsupported harness never injects the dispatch bootstrap', async () => {
    const res = await run(['session-start', '--harness', 'cursor'], {
      loadDispatchText: () => DISPATCH,
      fetchNotes: () => NOTES,
      fetchIssues: () => READY,
    });
    expect(res.output).toBe('');
  });
});
