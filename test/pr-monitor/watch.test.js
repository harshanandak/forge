'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const journal = require('../../lib/pr-monitor/journal');
const {
  watchLoop, runWatchPass, jitter, defaultSleep, DEFAULT_INTERVAL_MS,
} = require('../../lib/pr-monitor/watch');
const { EVENT_TYPES: T } = require('../../lib/pr-monitor/events');

const now = () => '2026-07-13T00:00:00.000Z';
const rngMid = () => 0.5;

function snap(over = {}) {
  return {
    repo: 'acme-forge', pr: '1', headSha: 'sha1', prState: 'OPEN', draft: false,
    verdict: { state: 'CLEAN-MERGEABLE', reason: null },
    checks: [], threads: [], reviews: [], comments: [], behind: 0, conflicts: false, degraded: [],
    ...over,
  };
}

function gatherQueue(snaps) {
  let i = 0;
  return async () => snaps[Math.min(i++, snaps.length - 1)];
}

function ownerContext(overrides = {}) {
  const record = {
    repo: 'acme/forge', pr: 1, generation: 'generation-1', phase: 'running',
    controllerPid: null, watcherPid: 202, startedAt: now(), updatedAt: now(), heartbeatAt: now(),
    terminalReceiptId: null, blockReason: null, legacyEvidenceHash: null,
  };
  const owner = {
    bindRunning: async () => ({ ok: true, changed: true, reason: 'bound', record }),
    readOwner: async () => ({ ok: true, changed: false, reason: 'read', record }),
    heartbeat: async () => ({ ok: true, changed: true, reason: 'heartbeat', record }),
    recordTerminal: async (_identity, input) => ({
      ok: true, changed: true, reason: 'terminal',
      record: { ...record, phase: 'terminal_pending', terminalReceiptId: input.terminalReceiptId },
    }),
    releaseNonterminal: async () => ({ ok: true, changed: true, reason: 'released', record: null }),
    ...overrides.owner,
  };
  return {
    repo: 'acme/forge', pr: 1, generation: 'generation-1', controllerPid: 101, pid: 202,
    ...overrides, owner,
  };
}

let root; let dir;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'prmon-w-'));
  dir = journal.journalDir({ root, repo: 'acme-forge', pr: '1' });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('runWatchPass', () => {
  test('replays a durable terminal receipt', async () => {
    const result = await runWatchPass({ pending: new Map() }, {
      runMonitorPass: async () => ({ events: [], terminalReceiptId: 'receipt-terminal' }),
    }, () => {});
    expect(result).toEqual({ terminal: true, terminalReceiptId: 'receipt-terminal' });
  });

  test('flushes held failures before the terminal event', async () => {
    const held = { type: T.CHECK_FAILED, key: 'held', data: { name: 'held' } };
    const terminal = { type: T.PR_MERGED, key: 'merged', data: {} };
    const emitted = [];
    const result = await runWatchPass({ pending: new Map([['held', held]]) }, {
      runMonitorPass: async () => ({ events: [terminal], terminalReceiptId: 'receipt-terminal' }),
    }, event => emitted.push(event));
    expect(result).toEqual({ terminal: true, terminalReceiptId: 'receipt-terminal' });
    expect(emitted).toEqual([held, terminal]);
  });

  test('a terminal event without a durable receipt remains retryable', async () => {
    const terminal = { type: T.PR_MERGED, key: 'merged', data: {} };
    const result = await runWatchPass({ pending: new Map() }, {
      runMonitorPass: async () => ({ events: [terminal] }),
    }, () => {});
    expect(result).toEqual({ terminal: false, receiptUnavailable: true });
  });

  test('streams journal-assigned compatibility sequences instead of raw Memory sequences', async () => {
    const compatibility = {
      seq: 2, ts: now(), type: T.VERDICT_CHANGED, key: 'state:ready', repo: 'acme-forge', pr: '1', data: {},
    };
    const emitted = [];
    await runWatchPass({ pending: new Map() }, {
      dir,
      runMonitorPass: async () => {
        journal.appendEvents(dir, [{ ...compatibility, seq: 1, type: T.COMMENT_POSTED, key: 'pre-pass' }]);
        journal.appendEvents(dir, [compatibility]);
        return { journalCursor: 1, events: [{ ...compatibility, seq: 3 }] };
      },
    }, event => emitted.push(event));
    expect(emitted).toEqual([compatibility]);
  });
});

describe('watchLoop owner rows', () => {
  test('heartbeats during a long provider pass and clears the independent timer', async () => {
    let fireHeartbeat;
    let clearCount = 0;
    let heartbeatCalls = 0;
    let finishPass;
    const timerReady = new Promise(resolve => {
      fireHeartbeat = callback => { resolve(); return callback; };
    });
    const providerPass = new Promise(resolve => { finishPass = resolve; });
    let scheduled;
    const running = watchLoop({
      ...ownerContext({ owner: {
        heartbeat: async () => { heartbeatCalls += 1; return { ok: true }; },
      } }),
      runMonitorPass: async () => providerPass,
      maxPasses: 1,
      emit: () => {},
      setInterval: callback => {
        scheduled = fireHeartbeat(callback);
        return 17;
      },
      clearInterval: timer => { expect(timer).toBe(17); clearCount += 1; },
    });
    await timerReady;
    await scheduled();
    expect(heartbeatCalls).toBe(1);
    finishPass({ events: [] });
    await running;
    expect(heartbeatCalls).toBe(2);
    expect(clearCount).toBe(1);
  });

  test('contains an independent heartbeat failure and exits after the active pass', async () => {
    let scheduled;
    let finishPass;
    const providerPass = new Promise(resolve => { finishPass = resolve; });
    const running = watchLoop({
      ...ownerContext({ owner: {
        heartbeat: async () => ({ ok: false, reason: 'stale_generation' }),
      } }),
      runMonitorPass: async () => providerPass,
      maxPasses: 2,
      emit: () => {},
      setInterval: callback => { scheduled = callback; return 19; },
      clearInterval: () => {},
    });
    while (!scheduled) await Promise.resolve();
    await scheduled();
    finishPass({ events: [] });
    expect(await running).toMatchObject({ started: true, passes: 1, reason: 'stale_generation' });
  });

  test('streams a confirmed failed check', async () => {
    const green = snap({ checks: [{ name: 'ci', class: 'green' }] });
    const failed = snap({ checks: [{ name: 'ci', class: 'failed' }] });
    const emitted = [];
    const result = await watchLoop({
      ...ownerContext(), dir, gather: gatherQueue([green, failed, failed]),
      now, rng: rngMid, sleep: async () => {}, maxPasses: 3, emit: event => emitted.push(event),
    });
    expect(result).toMatchObject({ started: true, passes: 3, stopped: false });
    expect(emitted.map(event => event.type)).toContain(T.CHECK_FAILED);
  });

  test('suppresses a one-pass failure flap', async () => {
    const green = snap({ checks: [{ name: 'ci', class: 'green' }] });
    const failed = snap({ checks: [{ name: 'ci', class: 'failed' }] });
    const emitted = [];
    await watchLoop({
      ...ownerContext(), dir, gather: gatherQueue([green, failed, green]),
      now, rng: rngMid, sleep: async () => {}, maxPasses: 3, emit: event => emitted.push(event),
    });
    expect(emitted.map(event => event.type)).not.toContain(T.CHECK_FAILED);
  });

  test('records terminal receipt and retains terminal_pending', async () => {
    let pass = 0;
    let released = false;
    const terminal = { type: T.PR_MERGED, key: 'merged', data: {} };
    const result = await watchLoop({
      ...ownerContext({ owner: {
        releaseNonterminal: async () => { released = true; return { ok: true }; },
      } }),
      runMonitorPass: async () => (++pass === 1
        ? { events: [] }
        : { events: [terminal], terminalReceiptId: 'receipt-terminal' }),
      now, rng: rngMid, sleep: async () => {}, maxPasses: 5, emit: () => {},
    });
    expect(result).toMatchObject({ stopped: true, passes: 2, reason: 'terminal-pending' });
    expect(released).toBe(false);
  });

  test('a conflicting bind is an idempotent no-op', async () => {
    const result = await watchLoop({
      ...ownerContext({ owner: { bindRunning: async () => ({ ok: false, reason: 'busy' }) } }),
      gather: async () => { throw new Error('must not gather'); },
    });
    expect(result).toEqual({ started: false, passes: 0, stopped: false, reason: 'busy' });
  });

  test('releases owner authority on normal and exceptional nonterminal exit', async () => {
    const calls = [];
    await watchLoop({
      ...ownerContext({ owner: {
        bindRunning: async () => { calls.push('bind'); return { ok: true }; },
        requestStop: async () => { calls.push('request-stop'); return { ok: true }; },
        releaseNonterminal: async () => { calls.push('release'); return { ok: true }; },
      } }),
      dir, gather: gatherQueue([snap()]), maxPasses: 1, emit: () => {},
    });
    expect(calls).toEqual(['bind', 'request-stop', 'release']);

    let released = false;
    let stopRequested = false;
    await expect(watchLoop({
      ...ownerContext({ owner: {
        requestStop: async () => { stopRequested = true; return { ok: true }; },
        releaseNonterminal: async () => { released = true; return { ok: true }; },
      } }),
      dir, gather: async () => { throw new Error('boom'); }, maxPasses: 1, emit: () => {},
    })).rejects.toThrow('boom');
    expect(stopRequested).toBe(true);
    expect(released).toBe(true);
  });

  test('a stop request exits cooperatively before provider work', async () => {
    let gathered = false;
    const stopping = ownerContext();
    stopping.owner.readOwner = async () => ({
      ok: true,
      record: {
        ...(await ownerContext().owner.readOwner()).record,
        phase: 'stop_requested',
      },
    });
    const result = await watchLoop({
      ...stopping, gather: async () => { gathered = true; return snap(); }, emit: () => {},
    });
    expect(result).toMatchObject({ stopped: true, passes: 0, reason: 'stop-requested' });
    expect(gathered).toBe(false);
  });
});

describe('timing helpers', () => {
  test('jitter stays within 20 percent', () => {
    expect(jitter(1000, () => 0)).toBe(800);
    expect(jitter(1000, () => 0.9999999)).toBeLessThanOrEqual(1200);
    expect(jitter(1000, () => 0.5)).toBe(1000);
  });

  test('abortable sleep resolves before a very long timer', async () => {
    const controller = new AbortController();
    const sleeping = defaultSleep(1_000_000_000, controller.signal);
    controller.abort();
    await sleeping;
    expect(controller.signal.aborted).toBe(true);
  });

  test('normal sleep and default interval remain available', async () => {
    await defaultSleep(1);
    expect(DEFAULT_INTERVAL_MS).toBe(60_000);
  });
});
