'use strict';

const { describe, test, expect } = require('bun:test');

const shepherd = require('../../lib/commands/shepherd');
const { startPrWatcherDetached } = require('../../lib/pr-monitor/watch-lifecycle');

const REPOSITORY = 'acme/forge';
const PR = 42;
const STARTED_AT = '2026-08-20T00:00:00.000Z';
const BLOCKED_GATES = [
  ['absent', { ok: false, changed: false, reason: 'absent', gate: null }],
  ['quarantined', { ok: true, changed: false, reason: 'read', gate: { state: 'quarantined' } }],
  ['conflict', { ok: true, changed: false, reason: 'read', gate: { state: 'conflict' } }],
  ['corrupt', { ok: false, changed: false, reason: 'corrupt', gate: null }],
  ['unavailable', { ok: false, changed: false, reason: 'authority_unavailable', gate: null }],
];
const COMPLETE_GATE = {
  ok: true, changed: false, reason: 'read', gate: { state: 'complete' },
};

function ownerHarness(gateResult) {
  const counters = { gateReads: 0, reservations: 0, spawns: 0, binds: 0 };
  return {
    counters,
    owner: {
      readMigrationGate: async () => {
        counters.gateReads += 1;
        return gateResult;
      },
      reserveStarting: async (identity, input) => {
        counters.reservations += 1;
        return {
          ok: true,
          changed: true,
          reason: 'acquired',
          record: {
            repo: identity.repo,
            pr: identity.pr,
            generation: 'store-generation-1',
            phase: 'starting',
            controllerPid: input.controllerPid,
            watcherPid: null,
            startedAt: STARTED_AT,
            updatedAt: STARTED_AT,
            heartbeatAt: null,
            terminalReceiptId: null,
            blockReason: null,
            legacyEvidenceHash: null,
          },
        };
      },
      abortStarting: async () => ({ ok: true, changed: true, reason: 'aborted', record: null }),
    },
  };
}

function fakeSpawn(counters, pid = 9200) {
  return () => {
    counters.spawns += 1;
    return { pid, on() {}, unref() {} };
  };
}

async function runDirect(gateResult) {
  const harness = ownerHarness(gateResult);
  const result = await shepherd.handleWatch(['watch', String(PR)], '/repo', {
    repository: REPOSITORY,
    dir: '/journal',
    gather: async () => ({}),
    store: {},
    owner: harness.owner,
    ownerOptions: { driver: {} },
    signal: { aborted: false },
    watchLoop: async () => {
      harness.counters.binds += 1;
      return { started: true, passes: 0, stopped: false };
    },
  });
  return { ...harness, result };
}

async function runAdopt(gateResult) {
  const harness = ownerHarness(gateResult);
  const result = await shepherd.handleWatch(['watch', '--adopt'], '/repo', {
    railEnabled: () => true,
    resolveRepository: () => REPOSITORY,
    listOpenPrs: () => [PR],
    owner: harness.owner,
    ownerOptions: { driver: {} },
    startWatcher: options => startPrWatcherDetached({
      ...options,
      spawn: fakeSpawn(harness.counters),
    }),
  });
  return { ...harness, result };
}

async function runPreReservedAndChild(gateResult) {
  const harness = ownerHarness(gateResult);
  const reservation = {
    ok: true,
    changed: true,
    reason: 'acquired',
    record: {
      repo: REPOSITORY,
      pr: PR,
      generation: 'store-generation-1',
      phase: 'starting',
      controllerPid: 9001,
      watcherPid: null,
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
      heartbeatAt: null,
      terminalReceiptId: null,
      blockReason: null,
      legacyEvidenceHash: null,
    },
  };
  const lifecycle = await startPrWatcherDetached({
    prNumber: PR,
    repository: REPOSITORY,
    controllerPid: 9001,
    reservation,
    owner: harness.owner,
    ownerOptions: { driver: {} },
    spawn: fakeSpawn(harness.counters),
  });
  const child = await shepherd.handleWatch([
    'watch', String(PR), '--repo', REPOSITORY, '--generation', 'store-generation-1',
    '--controller-pid', '9001', '--started-at', STARTED_AT,
  ], '/repo', {
    dir: '/journal',
    gather: async () => ({}),
    store: {},
    owner: harness.owner,
    ownerOptions: { driver: {} },
    signal: { aborted: false },
    watchLoop: async () => {
      harness.counters.binds += 1;
      return { started: true, passes: 0, stopped: false };
    },
  });
  return { ...harness, lifecycle, child };
}

describe('watch owner migration launch gate', () => {
  test.each(BLOCKED_GATES)('direct watch blocks %s gate before reservation or bind', async (_state, gate) => {
    const { counters, result } = await runDirect(gate);
    expect(counters).toEqual(expect.objectContaining({ reservations: 0, spawns: 0, binds: 0 }));
    expect(result).toEqual(expect.objectContaining({ started: false }));
  });

  test.each(BLOCKED_GATES)('adopt blocks %s gate before reservation or spawn', async (_state, gate) => {
    const { counters, result } = await runAdopt(gate);
    expect(counters).toEqual(expect.objectContaining({ reservations: 0, spawns: 0, binds: 0 }));
    expect(result).toEqual(expect.objectContaining({ adopted: [], total: 1 }));
  });

  test.each(BLOCKED_GATES)('pre-reserved lifecycle and child block %s gate before spawn or bind', async (_state, gate) => {
    const { counters, lifecycle, child } = await runPreReservedAndChild(gate);
    expect(counters).toEqual(expect.objectContaining({ reservations: 0, spawns: 0, binds: 0 }));
    expect(lifecycle).toEqual(expect.objectContaining({ started: false }));
    expect(child).toEqual(expect.objectContaining({ started: false }));
  });

  test('complete gate permits direct reservation and bind', async () => {
    const { counters, result } = await runDirect(COMPLETE_GATE);
    expect(counters.gateReads).toBeGreaterThan(0);
    expect(counters).toEqual(expect.objectContaining({ reservations: 1, spawns: 0, binds: 1 }));
    expect(result).toEqual(expect.objectContaining({ started: true }));
  });

  test('complete gate permits adopt reservation and spawn', async () => {
    const { counters, result } = await runAdopt(COMPLETE_GATE);
    expect(counters.gateReads).toBeGreaterThan(0);
    expect(counters).toEqual(expect.objectContaining({ reservations: 1, spawns: 1, binds: 0 }));
    expect(result).toEqual(expect.objectContaining({ adopted: [PR], total: 1 }));
  });

  test('complete gate permits pre-reserved spawn and child bind without a second reservation', async () => {
    const { counters, lifecycle, child } = await runPreReservedAndChild(COMPLETE_GATE);
    expect(counters.gateReads).toBeGreaterThan(0);
    expect(counters).toEqual(expect.objectContaining({ reservations: 0, spawns: 1, binds: 1 }));
    expect(lifecycle).toEqual(expect.objectContaining({ started: true }));
    expect(child).toEqual(expect.objectContaining({ started: true }));
  });
});
