'use strict';

const { describe, test, expect } = require('bun:test');

const hooks = require('../lib/commands/hooks');

// Strong bm25 hits (more-negative = stronger). Query has >=2 meaningful tokens.
const QUERY = JSON.stringify({ session_id: 'sess-1', prompt: 'the auth token refresh bug' });

function baseOpts(extra = {}) {
  return {
    railEnabled: () => true,
    readInput: () => QUERY,
    search: () => [
      { key: 'm1', value: 'Auth tokens refresh every 15 min; the bug was a clock skew.', score: -3.2 },
      { key: 'm2', value: 'Token store is Redis, keyed by tenant.', score: -1.4 },
    ],
    loadSeen: () => [],
    saveSeen: () => {},
    scoreFloor: -1.0,
    ...extra,
  };
}

function run(opts) {
  return hooks.handler(['memory-recall', '--harness', 'claude'], {}, '/repo', opts);
}

describe('forge hooks memory-recall', () => {
  test('injects fenced, query-ranked memory bodies as UserPromptSubmit context', async () => {
    const res = await run(baseOpts());
    expect(res.success).toBe(true);
    const payload = JSON.parse(res.output);
    expect(payload.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(payload.hookSpecificOutput.additionalContext).toContain('clock skew');
  });

  test('records the injected keys for cross-turn dedupe', async () => {
    const saved = [];
    await run(baseOpts({ saveSeen: (root, sid, keys) => saved.push({ root, sid, keys }) }));
    expect(saved).toHaveLength(1);
    expect(saved[0].sid).toBe('sess-1');
    expect(saved[0].keys).toEqual(['m1', 'm2']);
  });

  test('excludes memories seen on recent turns (dedupe)', async () => {
    const res = await run(baseOpts({ loadSeen: () => ['m1'] }));
    const ctx = JSON.parse(res.output).hookSpecificOutput.additionalContext;
    expect(ctx).not.toContain('clock skew'); // m1 excluded
    expect(ctx).toContain('Redis'); // m2 still injected
  });

  test('rail disabled -> injects nothing', async () => {
    expect((await run(baseOpts({ railEnabled: () => false }))).output).toBe('');
  });

  test('anaphora prompt ("continue") -> injects nothing', async () => {
    const res = await run(baseOpts({ readInput: () => JSON.stringify({ session_id: 's', prompt: 'continue' }) }));
    expect(res.output).toBe('');
  });

  test('no relevant hits -> injects nothing', async () => {
    expect((await run(baseOpts({ search: () => [] }))).output).toBe('');
  });

  test('non-claude harness -> injects nothing (substrate-solved, never re-solved here)', async () => {
    const res = await hooks.handler(['memory-recall', '--harness', 'codex'], {}, '/repo', baseOpts());
    expect(res.output).toBe('');
  });

  test('fail-open: a throwing search never breaks the prompt', async () => {
    const res = await run(baseOpts({ search: () => { throw new Error('kernel down'); } }));
    expect(res).toEqual({ success: true, output: '' });
  });

  test('fail-open: malformed stdin yields no query and injects nothing', async () => {
    expect((await run(baseOpts({ readInput: () => 'not json' }))).output).toBe('');
  });
});
