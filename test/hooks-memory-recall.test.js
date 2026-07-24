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
    appendShadow: () => {},
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

  test('queries the search seam with meaningful tokens, not the raw prompt (keyword-OR fix)', async () => {
    // The bug: the RAW prompt was passed to a token-AND FTS match -> 0 recall. The fix derives
    // meaningful tokens (stopwords dropped) and hands those to the search seam.
    const seen = [];
    await run(baseOpts({ search: (root, query, _limit) => { seen.push(query); return []; } }));
    expect(seen).toHaveLength(1);
    // 'the' (stopword) is dropped; every content token is present.
    expect(seen[0].split(/\s+/)).toEqual(['auth', 'token', 'refresh', 'bug']);
  });

  test('writes a shadow-log record (tokens, candidates, injectedKeys, floor) via the injectable seam', async () => {
    const rows = [];
    await run(baseOpts({ appendShadow: (root, rec) => rows.push({ root, rec }) }));
    expect(rows).toHaveLength(1);
    expect(rows[0].root).toBe('/repo');
    const rec = rows[0].rec;
    expect(rec.sessionId).toBe('sess-1');
    expect(rec.tokens).toEqual(['auth', 'token', 'refresh', 'bug']);
    expect(rec.candidateCount).toBe(2);
    expect(rec.candidates).toEqual([{ key: 'm1', score: -3.2 }, { key: 'm2', score: -1.4 }]);
    expect(rec.injectedKeys).toEqual(['m1', 'm2']);
    expect(rec.scoreFloor).toBe(-1.0);
  });

  test('shadow-log failure is swallowed — a throwing logger never breaks injection', async () => {
    const res = await run(baseOpts({ appendShadow: () => { throw new Error('disk full'); } }));
    expect(res.success).toBe(true);
    const ctx = JSON.parse(res.output).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('clock skew'); // injection still happened
  });

  test('applies a default score floor when the caller supplies none (no floor-less path)', async () => {
    // opts without scoreFloor -> the handler must supply DEFAULT_SCORE_FLOOR (0), which keeps
    // token-AND bm25 matches (score <= 0) but screens a positive (non-)match. A hit scored
    // above the floor must be excluded rather than injected.
    const opts = baseOpts();
    delete opts.scoreFloor;
    opts.search = () => [{ key: 'weak', value: 'barely related', score: 0.5 }];
    expect((await run(opts)).output).toBe('');
  });
});
