'use strict';

const { describe, test, expect, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hooks = require('../lib/commands/hooks');

// Strong bm25 hits (more-negative = stronger). Query has >=2 meaningful tokens.
const QUERY = JSON.stringify({ session_id: 'sess-1', prompt: 'the auth token refresh bug' });

function baseOpts(extra = {}) {
  return {
    railEnabled: () => true,
    readInput: () => QUERY,
    search: () => [
      {
        key: 'm1',
        value: 'Auth tokens refresh every 15 min; the bug was a clock skew.',
        score: -3.2,
        trust_status: 'confirmed',
        provenance: { source_agent: 'forge remember' },
      },
      {
        key: 'm2',
        value: 'Token store is Redis, keyed by tenant.',
        score: -1.4,
        trust_status: 'confirmed',
        provenance: { source_agent: 'forge remember' },
      },
    ],
    loadSeen: () => [],
    saveSeen: () => {},
    appendShadow: () => {},
    recordRecallEvent: () => {},
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
    expect(payload.hookSpecificOutput.additionalContext).toContain('Confirmed memory');
    expect(payload.hookSpecificOutput.additionalContext).toContain('trust=confirmed');
  });

  test('renders suggested hits in a separate non-authoritative section', async () => {
    const res = await run(baseOpts({
      search: () => [{
        memory_id: 'suggestion',
        content: 'Try the candidate clock-skew fix.',
        score: -3,
        trust_status: 'suggested',
        provenance: { source_agent: 'forge insights' },
        updated_at: '2026-07-30T00:00:00.000Z',
      }],
    }));
    const context = JSON.parse(res.output).hookSpecificOutput.additionalContext;
    expect(context).toContain('Suggested memory — verify before relying');
    expect(context).not.toContain('Confirmed memory');
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

  test('loads bounded seen keys before search and passes them into SQL eligibility', async () => {
    const calls = [];
    await run(baseOpts({
      loadSeen: () => {
        calls.push('seen');
        return Array.from({ length: 26 }, (_, index) => `seen-${index}`);
      },
      search: (_root, _query, _limit, options) => {
        calls.push({ search: options });
        return [{
          memory_id: 'unseen',
          type: 'note',
          content: 'Auth token unseen local result.',
          scope: 'project',
          trust_status: 'confirmed',
          provenance: { source_agent: 'forge remember', source_refs: [] },
          updated_at: '2026-07-30T00:00:00.000Z',
          score: -2,
        }];
      },
    }));

    expect(calls[0]).toBe('seen');
    expect(calls[1]).toEqual({
      search: {
        excludeKeys: Array.from({ length: 26 }, (_, index) => `seen-${index}`),
        busyTimeoutMs: 2500,
      },
    });
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
    expect(res.reason).toBe('global-config');
  });

  test('fails open by its prompt deadline', async () => {
    const startedAt = Date.now();
    const res = await run(baseOpts({
      search: () => new Promise(() => {}),
      promptRecallDeadlineMs: 25,
    }));
    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(res).toEqual({ success: true, output: '', reason: 'timeout' });
  });

  test('does not schedule a telemetry timer after a prompt', async () => {
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const delays = [];
    global.setTimeout = (_callback, delay) => {
      delays.push(delay);
      return null;
    };
    global.clearTimeout = () => {};

    try {
      const opts = baseOpts();
      delete opts.recordRecallEvent;
      await run(opts);
      expect(delays).toEqual([4500]);
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }
  });

  test('a result arriving after the deadline is not marked as injected', async () => {
    let saved = false;
    const res = await run(baseOpts({
      search: () => new Promise(resolve => setTimeout(() => resolve([
        { key: 'late', value: 'late auth token memory', score: -2 },
      ]), 40)),
      saveSeen: () => { saved = true; },
      promptRecallDeadlineMs: 10,
    }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(res.reason).toBe('timeout');
    expect(saved).toBe(false);
  });

  test('does not await seen persistence after the injection decision', async () => {
    let saveStarted = false;
    const startedAt = Date.now();
    const res = await run(baseOpts({
      saveSeen: () => {
        saveStarted = true;
        return new Promise(() => {});
      },
      promptRecallDeadlineMs: 25,
    }));
    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(saveStarted).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(JSON.parse(res.output).hookSpecificOutput.additionalContext).toContain('clock skew');
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

  test('writes only privacy-safe aggregate tuning evidence to the shadow log', async () => {
    const rows = [];
    await run(baseOpts({ appendShadow: (root, rec) => rows.push({ root, rec }) }));
    expect(rows).toHaveLength(1);
    expect(rows[0].root).toBe('/repo');
    const rec = rows[0].rec;
    expect(rec.candidateCount).toBe(2);
    expect(rec.injectedCount).toBe(2);
    expect(rec.scoreFloor).toBe(-1.0);
    expect(JSON.stringify(rec)).not.toContain('sess-1');
    expect(JSON.stringify(rec)).not.toContain('auth');
    expect(JSON.stringify(rec)).not.toContain('m1');
    expect(JSON.stringify(rec)).not.toContain('clock skew');
  });

  test('shadow-log failure is swallowed — a throwing logger never breaks injection', async () => {
    const res = await run(baseOpts({ appendShadow: () => { throw new Error('disk full'); } }));
    expect(res.success).toBe(true);
    const ctx = JSON.parse(res.output).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('clock skew'); // injection still happened
  });

  test('bounds the shadow record fields — a pathological prompt cannot produce a huge record', async () => {
    // A shadow record is a tuning sample, not an archive: an adversarial prompt (hundreds of
    // very long words) must still serialize small, so no single record can blow the log cap.
    const words = Array.from({ length: 400 }, (_, i) => `tok${i}${'x'.repeat(500)}`);
    const rows = [];
    await run(baseOpts({
      readInput: () => JSON.stringify({ session_id: 'sess-big', prompt: words.join(' ') }),
      appendShadow: (root, rec) => rows.push(rec),
    }));
    expect(rows).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(rows[0]), 'utf8')).toBeLessThan(8 * 1024);
    expect(JSON.stringify(rows[0])).not.toContain(words[0]);
  });
});

describe('shadow log byte cap', () => {
  const { appendShadowLog, SHADOW_LOG_MAX_BYTES } = hooks._internal;
  const roots = [];

  // Real writes go to a real tmp dir — never a fake absolute root like '/repo', which on
  // Windows resolves to C:\repo and leaks state between runs.
  function tmpRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shadow-'));
    roots.push(root);
    return root;
  }

  function logPath(root) {
    return path.join(root, '.forge', 'memory-recall', 'shadow.jsonl');
  }

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });

  test('a single record larger than the cap leaves the file empty, never oversized', () => {
    const root = tmpRoot();
    appendShadowLog(root, { sessionId: 'small', tokens: ['a'] });
    appendShadowLog(root, { sessionId: 'huge', pad: 'p'.repeat(SHADOW_LOG_MAX_BYTES + 1024) });
    const body = fs.readFileSync(logPath(root), 'utf8');
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(SHADOW_LOG_MAX_BYTES);
    expect(body).not.toContain('huge'); // the oversized record must NOT survive the trim
    expect(body).toBe('');
  });

  test('evicts whole oldest records by bytes, keeping the newest under the cap', () => {
    const root = tmpRoot();
    const pad = 'p'.repeat(64 * 1024);
    for (let i = 0; i < 12; i += 1) appendShadowLog(root, { seq: i, pad });
    const body = fs.readFileSync(logPath(root), 'utf8');
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(SHADOW_LOG_MAX_BYTES);
    const seqs = body.split('\n').filter(Boolean).map(line => JSON.parse(line).seq);
    expect(seqs[seqs.length - 1]).toBe(11); // newest kept
    expect(seqs).not.toContain(0); // oldest evicted
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // whole records, still in order
  });

  test('stays under the cap across many appends without dropping the newest record', () => {
    const root = tmpRoot();
    const pad = 'p'.repeat(32 * 1024);
    for (let i = 0; i < 40; i += 1) {
      appendShadowLog(root, { seq: i, pad });
      const size = fs.statSync(logPath(root)).size;
      expect(size).toBeLessThanOrEqual(SHADOW_LOG_MAX_BYTES);
    }
    const lines = fs.readFileSync(logPath(root), 'utf8').split('\n').filter(Boolean);
    expect(JSON.parse(lines[lines.length - 1]).seq).toBe(39);
  });
});

describe('forge hooks memory-recall (floor)', () => {
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
