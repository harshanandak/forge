'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const journal = require('../../lib/pr-monitor/journal');
const {
  watchLoop, jitter, defaultSleep, defaultClaim, DEFAULT_INTERVAL_MS,
} = require('../../lib/pr-monitor/watch');
const { EVENT_TYPES: T } = require('../../lib/pr-monitor/events');

function snap(over = {}) {
  return {
    repo: 'acme-forge', pr: '1', headSha: 'sha1', prState: 'OPEN', draft: false,
    verdict: { state: 'CLEAN-MERGEABLE', reason: null },
    checks: [], threads: [], reviews: [], comments: [], behind: 0, conflicts: false, degraded: [],
    ...over,
  };
}

/** A gather that yields each snapshot once, then repeats the last (no-change). */
function gatherQueue(snaps) {
  let i = 0;
  return async () => {
    const s = snaps[Math.min(i, snaps.length - 1)];
    i += 1;
    return s;
  };
}

const now = () => '2026-07-13T00:00:00.000Z';
const rngMid = () => 0.5; // jitter(interval, 0.5) === interval exactly

let root; let dir;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'prmon-w-')); dir = journal.journalDir({ root, repo: 'acme-forge', pr: '1' }); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('watchLoop', () => {
  test('streams a confirmed check.failed as an emitted event on change', async () => {
    const green = snap({ checks: [{ name: 'ci', class: 'green' }] });
    const failed = snap({ checks: [{ name: 'ci', class: 'failed' }] });
    const emitted = [];
    const res = await watchLoop({
      dir, gather: gatherQueue([green, failed, failed]),
      now, rng: rngMid, sleep: async () => {}, maxPasses: 3,
      emit: (e) => emitted.push(e),
    });
    expect(res.started).toBe(true);
    expect(res.passes).toBe(3);
    expect(res.stopped).toBe(false);
    // Held one pass, then confirmed on the no-change third pass → pushed.
    expect(emitted.map((e) => e.type)).toContain(T.CHECK_FAILED);
  });

  test('emits nothing after the baseline when the snapshot never changes', async () => {
    const emitted = [];
    const sleeps = [];
    await watchLoop({
      dir, gather: gatherQueue([snap()]),
      now, rng: rngMid, maxPasses: 4,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      emit: (e) => emitted.push(e),
    });
    // Only the first-pass baseline verdict event is ever pushed.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe(T.VERDICT_CHANGED);
    // No real timers: 3 injected sleeps between 4 passes, each within jitter band.
    expect(sleeps).toHaveLength(3);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThanOrEqual(DEFAULT_INTERVAL_MS * 0.8);
      expect(ms).toBeLessThanOrEqual(DEFAULT_INTERVAL_MS * 1.2);
    }
  });

  test('emits the terminal pr.merged event LAST and exits the loop', async () => {
    const open = snap();
    const merged = snap({ prState: 'MERGED' });
    const emitted = [];
    const res = await watchLoop({
      dir, gather: gatherQueue([open, merged]),
      now, rng: rngMid, sleep: async () => {}, maxPasses: 5,
      emit: (e) => emitted.push(e),
    });
    expect(res.stopped).toBe(true);
    expect(res.passes).toBe(2); // stopped early, well before maxPasses
    expect(emitted[emitted.length - 1].type).toBe(T.PR_MERGED);
  });

  test('is an idempotent no-op when another live watcher owns the PR', async () => {
    const emitted = [];
    let wrotepid = false;
    const res = await watchLoop({
      dir, gather: async () => { throw new Error('must not gather'); },
      watcherRunning: () => true,
      writePid: () => { wrotepid = true; },
      removePid: () => {},
      emit: (e) => emitted.push(e), maxPasses: 3,
    });
    expect(res.started).toBe(false);
    expect(res.reason).toBe('watcher-already-running');
    expect(res.passes).toBe(0);
    expect(wrotepid).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  test('suppresses a flap: fail→green within one interval is never pushed', async () => {
    const green = snap({ checks: [{ name: 'ci', class: 'green' }] });
    const failed = snap({ checks: [{ name: 'ci', class: 'failed' }] });
    const emitted = [];
    await watchLoop({
      dir, gather: gatherQueue([green, failed, green]),
      now, rng: rngMid, sleep: async () => {}, maxPasses: 3,
      emit: (e) => emitted.push(e),
    });
    // The transient failure recovered next pass → the stream never pushed it.
    expect(emitted.map((e) => e.type)).not.toContain(T.CHECK_FAILED);
  });

  test('writes the pid on start and removes it on exit', async () => {
    const writes = [];
    const removes = [];
    await watchLoop({
      dir, gather: gatherQueue([snap()]),
      now, rng: rngMid, sleep: async () => {}, maxPasses: 1,
      writePid: (d) => writes.push(d),
      removePid: (d) => removes.push(d),
      emit: () => {},
    });
    expect(writes).toEqual([dir]);
    expect(removes).toEqual([dir]);
  });

  test('removes the pid even when a pass throws (finally cleanup)', async () => {
    const removes = [];
    await expect(watchLoop({
      dir, gather: async () => { throw new Error('boom'); },
      writePid: () => {}, removePid: (d) => removes.push(d),
      emit: () => {}, maxPasses: 1,
    })).rejects.toThrow('boom');
    expect(removes).toEqual([dir]);
  });
});

describe('jitter', () => {
  test('stays within ±20% of the base interval', () => {
    expect(jitter(1000, () => 0)).toBe(800);
    expect(jitter(1000, () => 0.9999999)).toBeLessThanOrEqual(1200);
    expect(jitter(1000, () => 0.5)).toBe(1000);
  });
});

describe('defaultSleep (abortable)', () => {
  test('resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await defaultSleep(10000, controller.signal); // would be 10s if it ignored abort
    expect(Date.now() - start).toBeLessThan(500);
  });

  test('resolves early when the signal aborts mid-sleep (Ctrl-C never waits out the interval)', async () => {
    const controller = new AbortController();
    const start = Date.now();
    const sleeping = defaultSleep(10000, controller.signal);
    controller.abort();
    await sleeping;
    expect(Date.now() - start).toBeLessThan(500);
  });

  test('a normal (un-aborted) sleep still honors the timer', async () => {
    const start = Date.now();
    await defaultSleep(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });
});

describe('defaultClaim (atomic watcher claim)', () => {
  test('two concurrent claims on the same PR: exactly ONE succeeds', async () => {
    // Simulate a cross-process pid via shared state; the journal lock must
    // serialize the check+write so both starts cannot both claim (and both begin
    // emitting duplicate NDJSON).
    let pid = null;
    const primitives = {
      watcherRunning: () => pid != null,
      writePid: () => { pid = 4242; },
    };
    const [a, b] = await Promise.all([
      defaultClaim(dir, primitives),
      defaultClaim(dir, primitives),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  test('a claim fails once the slot is already owned', async () => {
    let pid = null;
    const primitives = { watcherRunning: () => pid != null, writePid: () => { pid = 1; } };
    expect(await defaultClaim(dir, primitives)).toBe(true);
    expect(await defaultClaim(dir, primitives)).toBe(false);
  });
});
