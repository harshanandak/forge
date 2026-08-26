'use strict';

const { describe, test, expect } = require('bun:test');

const shepherd = require('../../lib/commands/shepherd');
const executor = require('../../lib/pr-monitor/reconcile-executor');
const { startPrWatcherDetached } = require('../../lib/pr-monitor/watch-lifecycle');

const REPOSITORY = 'acme/forge';
const PR = 42;
const STARTED_AT = '2026-08-19T12:00:00.000Z';

function contentionAuthority(expectedReservations) {
  let arrivals = 0;
  let releaseContenders;
  let row = null;
  let minted = 0;
  let binds = 0;
  const identities = [];
  const contendersReady = new Promise((resolve) => { releaseContenders = resolve; });

  return {
    async readMigrationGate() {
      return { ok: true, changed: false, reason: 'read', gate: { state: 'complete' } };
    },
    async reserveStarting(identity, input) {
      const arrival = arrivals;
      arrivals += 1;
      identities.push(identity);
      if (arrivals === expectedReservations) releaseContenders();
      await contendersReady;

      if (arrival === 0) {
        minted += 1;
        row = {
          repo: identity.repo,
          pr: identity.pr,
          generation: `store-generation-${minted}`,
          phase: 'starting',
          controllerPid: input.controllerPid,
          watcherPid: null,
          startedAt: STARTED_AT,
          updatedAt: STARTED_AT,
          heartbeatAt: null,
          terminalReceiptId: null,
          blockReason: null,
          legacyEvidenceHash: null,
        };
        return { ok: true, changed: true, reason: 'acquired', record: { ...row } };
      }
      return { ok: false, changed: false, reason: 'busy', record: { ...row } };
    },
    async bindRunning(identity, input) {
      if (row?.repo !== identity.repo || row?.pr !== identity.pr
        || row.generation !== input.generation || row.controllerPid !== input.controllerPid) {
        return { ok: false, changed: false, reason: 'conflict', record: row && { ...row } };
      }
      binds += 1;
      row = { ...row, phase: 'running', controllerPid: null, watcherPid: input.pid };
      return { ok: true, changed: true, reason: 'bound', record: { ...row } };
    },
    async abortStarting() {
      throw new Error('a successful spawn must not abort its reservation');
    },
    evidence() {
      return { arrivals, binds, identities: [...identities], minted, row: row && { ...row } };
    },
  };
}

function fakeChild(pid, spawns, source) {
  spawns.push({ pid, source });
  return { pid, on() {}, unref() {} };
}

describe('watch owner launch-path contention', () => {
  test('direct, daemon, and adopt contenders mint and launch exactly one watcher', async () => {
    const authority = contentionAuthority(3);
    const ownerOptions = { driver: {} };
    const spawns = [];

    const daemonRun = executor.execute([{
      type: 'reserveWatcher',
      pr: { repo: REPOSITORY, number: PR },
    }], {
      authority,
      ownerOptions,
      controllerPid: 9002,
      spawnWatcher: (options) => startPrWatcherDetached({
        ...options,
        spawn: () => fakeChild(9102, spawns, 'daemon'),
      }),
    });
    const directRun = shepherd.handleWatch(['watch', String(PR)], '/repo', {
      repository: REPOSITORY,
      dir: '/journal',
      gather: async () => ({}),
      store: {},
      owner: authority,
      ownerOptions,
      signal: { aborted: false },
      watchLoop: async () => {
        spawns.push({ pid: process.pid, source: 'direct' });
        return { started: true, passes: 0, stopped: false };
      },
    });
    const adoptRun = shepherd.handleWatch(['watch', '--adopt'], '/repo', {
      railEnabled: () => true,
      resolveRepository: () => REPOSITORY,
      listOpenPrs: () => [PR],
      owner: authority,
      ownerOptions,
      startWatcher: (options) => startPrWatcherDetached({
        ...options,
        controllerPid: 9003,
        spawn: () => fakeChild(9103, spawns, 'adopt'),
      }),
    });

    const [daemon, direct, adopt] = await Promise.all([daemonRun, directRun, adoptRun]);
    const evidence = authority.evidence();

    expect(evidence.identities).toEqual([
      { repo: REPOSITORY, pr: PR },
      { repo: REPOSITORY, pr: PR },
      { repo: REPOSITORY, pr: PR },
    ]);
    expect(evidence.minted).toBe(1);
    expect(evidence.binds).toBe(1);
    expect(evidence.row).toEqual(expect.objectContaining({
      repo: REPOSITORY,
      pr: PR,
      generation: 'store-generation-1',
      phase: 'running',
      watcherPid: 9102,
    }));
    expect(spawns).toEqual([{ pid: 9102, source: 'daemon' }]);
    expect(daemon.results[0].result).toEqual(expect.objectContaining({ ok: true, reason: 'bound' }));
    expect(direct).toEqual(expect.objectContaining({ started: false, reason: 'busy' }));
    expect(adopt).toEqual(expect.objectContaining({ adopted: [], total: 1 }));
  });
});
