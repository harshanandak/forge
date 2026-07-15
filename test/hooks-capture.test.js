'use strict';

const { afterEach, describe, test, expect } = require('bun:test');

const hooks = require('../lib/commands/hooks');
const recall = require('../lib/commands/recall');
const projectMemory = require('../lib/project-memory');
const { createKernelProjectRoots } = require('./helpers/kernel-project-root');

// `forge hooks capture` (kernel 3867b9c2) — the CAPTURE-on-exit context hook. PreCompact and
// Stop fire it; it snapshots a deterministic, token-bounded session-summary note into the
// memory store BEFORE context is lost. Machine-facing + FAIL-OPEN: any failure, an unsupported
// harness, or nothing worth capturing yields empty output and NO write. Fetchers/writer are
// injectable so these unit tests never touch a real store.

const CLAIMED = [{ id: 'i1', title: 'Wire auto-file rail' }, { id: 'i2', title: 'Fix head-branch bug' }];

function run(args, opts) {
  return hooks.handler(args, {}, '/root', opts);
}

// A recording writer that also feeds dedupe: appended notes come back through fetchNotes.
function recordingStore() {
  const writes = [];
  return {
    writes,
    append(_root, note, options = {}) {
      const entry = { id: `n${writes.length}`, note, timestamp: '2026-07-15T00:00:00.000Z', tags: options.tags || [] };
      writes.push(entry);
      return entry;
    },
    fetchNotes: () => [...writes].reverse(), // newest-first, like recall
  };
}

describe('forge hooks capture (context hook — capture on exit)', () => {
  test('claude + stop with in-progress issues writes ONE session-summary typed note', async () => {
    const store = recordingStore();
    const res = await run(['capture', '--harness', 'claude', '--trigger', 'stop'], {
      append: store.append,
      fetchNotes: store.fetchNotes,
      fetchIssues: (_root, kind) => (kind === 'ready' ? [] : CLAIMED),
    });
    expect(res.success).toBe(true);
    expect(res.output).toBe(''); // capture is SILENT persistence — never injects into the turn
    expect(store.writes).toHaveLength(1);
    const [entry] = store.writes;
    expect(entry.tags).toContain('type:session-summary');
    expect(entry.tags).toContain('forge:auto-capture');
    expect(entry.note).toContain('stop');
    expect(entry.note).toContain('Wire auto-file rail');
  });

  test('dedupe: an identical consecutive capture does NOT write a second note', async () => {
    const store = recordingStore();
    const opts = {
      append: store.append,
      fetchNotes: store.fetchNotes,
      fetchIssues: (_root, kind) => (kind === 'ready' ? [] : CLAIMED),
    };
    await run(['capture', '--harness', 'claude', '--trigger', 'stop'], opts);
    await run(['capture', '--harness', 'claude', '--trigger', 'stop'], opts);
    // Same trigger + same in-progress set → same body → the second Stop is a no-op.
    expect(store.writes).toHaveLength(1);
  });

  test('a changed in-progress set DOES write a fresh capture (not deduped)', async () => {
    const store = recordingStore();
    const base = { append: store.append, fetchNotes: store.fetchNotes };
    await run(['capture', '--harness', 'claude', '--trigger', 'stop'],
      { ...base, fetchIssues: (_r, k) => (k === 'ready' ? [] : CLAIMED) });
    await run(['capture', '--harness', 'claude', '--trigger', 'stop'],
      { ...base, fetchIssues: (_r, k) => (k === 'ready' ? [] : [{ id: 'i3', title: 'New work' }]) });
    expect(store.writes).toHaveLength(2);
  });

  test('precompact captures a boundary marker even with no in-progress issues (unlike Stop)', async () => {
    const store = recordingStore();
    const res = await run(['capture', '--harness', 'claude', '--trigger', 'precompact'], {
      append: store.append,
      fetchNotes: store.fetchNotes,
      fetchIssues: () => [],
    });
    expect(res.success).toBe(true);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].note).toContain('precompact');
  });

  test('precompact is NOT exempt from dedupe: a byte-identical repeat does not write again', async () => {
    const store = recordingStore();
    const opts = {
      append: store.append,
      fetchNotes: store.fetchNotes,
      fetchIssues: (_root, kind) => (kind === 'ready' ? [] : CLAIMED),
    };
    await run(['capture', '--harness', 'claude', '--trigger', 'precompact'], opts);
    await run(['capture', '--harness', 'claude', '--trigger', 'precompact'], opts);
    // Same trigger + same in-progress set → identical body → the second PreCompact is deduped.
    expect(store.writes).toHaveLength(1);
  });

  test('a plain Stop with nothing in progress is a no-op (avoids per-turn flooding)', async () => {
    const store = recordingStore();
    const res = await run(['capture', '--harness', 'claude', '--trigger', 'stop'], {
      append: store.append,
      fetchNotes: store.fetchNotes,
      fetchIssues: () => [],
    });
    expect(res.success).toBe(true);
    expect(res.output).toBe('');
    expect(store.writes).toHaveLength(0);
  });

  test('unsupported harness (cursor) → empty output, no write (honest no-op)', async () => {
    const store = recordingStore();
    const res = await run(['capture', '--harness', 'cursor', '--trigger', 'stop'], {
      append: store.append,
      fetchNotes: store.fetchNotes,
      fetchIssues: () => CLAIMED,
    });
    expect(res.success).toBe(true);
    expect(res.output).toBe('');
    expect(store.writes).toHaveLength(0);
  });

  test('fail-open: a throwing fetcher never errors the hook and never half-writes', async () => {
    const store = recordingStore();
    const res = await run(['capture', '--harness', 'claude', '--trigger', 'precompact'], {
      append: store.append,
      fetchNotes: store.fetchNotes,
      fetchIssues: () => { throw new Error('issue store down'); },
    });
    expect(res.success).toBe(true);
    expect(res.output).toBe('');
    expect(store.writes).toHaveLength(0);
  });

  test('fail-open: a throwing writer is swallowed (capture must never break a session)', async () => {
    const res = await run(['capture', '--harness', 'claude', '--trigger', 'precompact'], {
      append: () => { throw new Error('store write failed'); },
      fetchNotes: () => [],
      fetchIssues: () => CLAIMED,
    });
    expect(res.success).toBe(true);
    expect(res.output).toBe('');
  });

  test('token-bounded: a huge in-progress set is capped, not dumped verbatim', async () => {
    const store = recordingStore();
    const many = Array.from({ length: 50 }, (_i, n) => ({ id: `x${n}`, title: `Issue number ${n} `.repeat(20) }));
    await run(['capture', '--harness', 'claude', '--trigger', 'stop'], {
      append: store.append,
      fetchNotes: store.fetchNotes,
      fetchIssues: (_r, k) => (k === 'ready' ? [] : many),
    });
    expect(store.writes).toHaveLength(1);
    // A hard ceiling (incl. the appended ellipsis) keeps the next-session digest small.
    expect(store.writes[0].note.length).toBeLessThanOrEqual(1000);
  });
});

describe('forge hooks capture (end-to-end against the real kernel store)', () => {
  const { makeProjectRoot, cleanup } = createKernelProjectRoots('forge-capture-e2e-');

  afterEach(() => {
    projectMemory.closeAll();
    cleanup();
  });

  test('the captured note is retrievable via recall (real store, default writer)', async () => {
    const projectRoot = makeProjectRoot();
    // Real append + dedupe read; only the issue fetch is stubbed to a deterministic claim.
    const res = await hooks.handler(
      ['capture', '--harness', 'claude', '--trigger', 'precompact'],
      {},
      projectRoot,
      { fetchIssues: (_r, k) => (k === 'ready' ? [] : [{ id: 'i9', title: 'Persisted work item' }]) }
    );
    expect(res.success).toBe(true);

    const recalled = JSON.parse((await recall.handler(['--json'], {}, projectRoot)).output).notes;
    const capture = recalled.find(n => (n.tags || []).includes('forge:auto-capture'));
    expect(capture).toBeDefined();
    expect(capture.note).toContain('Persisted work item');
    expect(capture.tags).toContain('type:session-summary');
  });
});
