'use strict';

const { describe, expect, test } = require('bun:test');
const {
	execute,
	gatherObserved,
	convergeOnce,
} = require('../../lib/pr-monitor/reconcile-executor');
const { decideLifecycle } = require('../../lib/pr-monitor/reconcile');
const { defaultPidStartedAt } = require('../../lib/pr-monitor/process-identity');

const NOW = '2026-08-19T00:00:00.000Z';
const PR = { repo: 'acme/project', number: 7, branch: 'topic', headSha: 'abc' };
const RECORD = {
	version: 1, repo: PR.repo, pr: PR.number, generation: 'g1', phase: 'running',
	controllerPid: null, watcherPid: 44, startedAt: NOW, updatedAt: NOW,
	heartbeatAt: NOW, terminalReceiptId: null, blockReason: null,
	legacyEvidenceHash: null,
};

describe('reconcile executor owner-row authority', () => {
	test('reserves, spawns, and binds through owner APIs without writing lease watcher state', async () => {
		const calls = [];
		const authority = {
			reserveStarting: async (_ctx, input) => {
				calls.push(['reserve', input.controllerPid]);
				return { ok: true, changed: true, record: { ...RECORD, phase: 'starting', controllerPid: input.controllerPid } };
			},
			bindRunning: async (_ctx, input) => {
				calls.push(['bind', input.generation, input.pid]);
				return { ok: true, changed: true, record: { ...RECORD, watcherPid: input.pid } };
			},
		};
		const result = await execute([{ type: 'reserveWatcher', pr: PR }], {
			authority,
			controllerPid: 11,
			spawnWatcher: input => {
				calls.push(['spawn', input.repository, input.prNumber, input.reservation.record.generation]);
				return { started: true, pid: 44, generation: input.reservation.record.generation };
			},
			projectRoot: '/repo',
			gitCommonDir: '/repo/.git',
		});
		expect(calls).toEqual([
			['reserve', 11],
			['spawn', PR.repo, PR.number, 'g1'],
			['bind', 'g1', 44],
		]);
		expect(result).toMatchObject({ ok: true, changed: true });
	});

	test('requests cooperative stop without signaling the persisted watcher PID', async () => {
		let killed = false;
		const calls = [];
		await execute([{ type: 'requestStop', owner: RECORD }], {
			authority: {
				requestStop: async (_ctx, input) => {
					calls.push(input);
					return { ok: true, changed: true, record: { ...RECORD, phase: 'stop_requested' } };
				},
			},
			kill: () => { killed = true; },
		});
		expect(killed).toBe(false);
		expect(calls).toEqual([{ generation: 'g1', pid: 44 }]);
	});

	test('enumerates owner rows before checking PID liveness outside authority access', async () => {
		const order = [];
		const result = await gatherObserved('/repo/.git', null, {
			broker: { listOpenPrs: async () => [] },
			authority: {
				enumerateOwners: async () => {
					order.push('enumerate');
					return { ok: true, records: [RECORD] };
				},
				readMigrationGate: async () => ({ ok: true, gate: { state: 'complete', snapshot_hash: 'a'.repeat(64) } }),
			},
			isAlive: pid => { order.push(`pid:${pid}`); return true; },
			now: () => Date.parse(NOW),
		});
		expect(order).toEqual(['enumerate', 'pid:44']);
		expect(result.ownerRows[0]).toMatchObject({ watcherAlive: true });
		expect(result.migrationGate).toMatchObject({ state: 'complete' });
	});

	test('never pairs an injected liveness probe with the built-in start-time probe', async () => {
		// Fabricated PIDs have no real process behind them. Handing the built-in /proc
		// probe to an injected liveness answer read an unrelated live process's start
		// time and "proved" reuse on Linux, while Windows (null probe) saw nothing.
		const seen = [];
		const authority = {
			enumerateOwners: async (_ctx, options) => {
				seen.push(options.pidStartedAt);
				return { ok: true, records: [] };
			},
			readMigrationGate: async () => ({ ok: true, gate: { state: 'complete', snapshot_hash: 'a'.repeat(64) } }),
		};
		const broker = { listOpenPrs: async () => [] };
		await gatherObserved('/repo/.git', null, { broker, authority, isAlive: () => true });
		expect(seen).toEqual([null]);

		// The built-in pair still travels together for the real daemon.
		await gatherObserved('/repo/.git', null, { broker, authority });
		expect(seen[1]).toBe(defaultPidStartedAt);
	});

	test('treats a reused watcher PID as dead and carries the reuse proof into recovery', async () => {
		const gather = pidStartedAt => gatherObserved('/repo/.git', null, {
			broker: { listOpenPrs: async () => [] },
			authority: {
				enumerateOwners: async () => ({ ok: true, records: [RECORD] }),
				readMigrationGate: async () => ({ ok: true, gate: { state: 'complete', snapshot_hash: 'a'.repeat(64) } }),
			},
			isAlive: () => true,
			pidStartedAt,
			now: () => Date.parse(NOW),
		});

		// PID 44 exists, but the process holding it booted an hour after the watcher
		// wrote this row's heartbeat, so it cannot be that watcher.
		const reused = await gather(async () => Date.parse('2026-08-19T01:00:00.000Z'));
		expect(reused.ownerRows[0]).toMatchObject({ watcherAlive: false, watcherPidReuseProven: true });

		// An unknown process start time (every non-Linux platform today) keeps the
		// previous bare-PID behaviour exactly.
		const unknown = await gather(async () => null);
		expect(unknown.ownerRows[0]).toMatchObject({ watcherAlive: true });
		expect(unknown.ownerRows[0].watcherPidReuseProven).toBeUndefined();

		const inputs = [];
		await execute([{ type: 'recoverWatcher', owner: reused.ownerRows[0], pr: PR, providerState: 'open' }], {
			authority: {
				recoverDeadWatcher: async (_ctx, input) => {
					inputs.push(input);
					return { ok: true, changed: true, record: { ...RECORD, phase: 'starting', controllerPid: 12 } };
				},
				bindRunning: async () => ({ ok: true, changed: true, record: RECORD }),
			},
			controllerPid: 12,
			spawnWatcher: () => ({ started: true, pid: 55 }),
		});
		expect(inputs[0]).toMatchObject({ pid: 44, recoveryControllerPid: 12, pidReuseProven: true });
	});

	test('recovers a starting row whose controller PID was reused instead of deferring to it', async () => {
		const starting = {
			...RECORD, phase: 'starting', controllerPid: 33, watcherPid: null, heartbeatAt: null,
		};
		const observed = await gatherObserved('/repo/.git', null, {
			broker: { listOpenPrs: async () => [] },
			authority: {
				enumerateOwners: async () => ({ ok: true, records: [starting] }),
				readMigrationGate: async () => ({ ok: true, gate: { state: 'complete', snapshot_hash: 'a'.repeat(64) } }),
			},
			isAlive: () => true,
			// PID 33 exists, but its process booted after the controller wrote this row.
			pidStartedAt: async () => Date.parse('2026-08-19T01:00:00.000Z'),
			now: () => Date.parse(NOW),
		});
		const row = observed.ownerRows[0];
		expect(row).toMatchObject({ controllerAlive: false, controllerPidReuseProven: true });

		// A foreign reused controller PID must not leave the PR unwatched: reconciliation
		// recovers the abandoned start rather than deferring to the live stranger.
		const decided = decideLifecycle({
			openPrs: [PR], controllerPid: 12, listingOk: true, repositoryOk: true, gitCommonDir: '/repo/.git',
		}, {
			ownerRows: [row], ownerRowsOk: true, prRows: [],
			migrationGate: { state: 'complete', snapshot_hash: 'a'.repeat(64) },
		});
		expect(decided.actions).toContainEqual({ type: 'recoverStarting', owner: row, pr: PR });

		const inputs = [];
		await execute(decided.actions.filter(action => action.type === 'recoverStarting'), {
			authority: {
				recoverDeadStarting: async (_ctx, input) => {
					inputs.push(input);
					return { ok: true, changed: true, record: { ...starting, controllerPid: 12 } };
				},
				bindRunning: async () => ({ ok: true, changed: true, record: RECORD }),
			},
			controllerPid: 12,
			spawnWatcher: () => ({ started: true, pid: 55 }),
		});
		expect(inputs[0]).toMatchObject({ controllerPid: 33, recoveryControllerPid: 12, pidReuseProven: true });
	});

	test('converges without reading or publishing lease watcher arrays', async () => {
		let published = false;
		const result = await convergeOnce('/repo', {
			gitCommonDir: '/repo/.git',
			lock: { watchers: [{ pr: 999, pid: 999 }] },
			gatherDesired: async () => ({ openPrs: [], listingOk: true, repositoryOk: true }),
			gatherObserved: async () => ({
				ownerRows: [], ownerRowsOk: true,
				migrationGate: { state: 'complete', snapshot_hash: 'a'.repeat(64) },
				prRows: [],
			}),
			reconcile: () => ({ actions: [] }),
			execute: async () => ({ ok: true, changed: false }),
			updateWatchers: () => { published = true; },
			authority: { enumerateOwners: async () => ({ ok: true, records: [] }) },
		});
		expect(published).toBe(false);
		expect(result).toMatchObject({ desiredCount: 0, activeOwnerCount: 0, authorityOk: true });
	});

	test('reports failed action execution so an empty daemon cannot retire', async () => {
		const result = await convergeOnce('/repo', {
			gitCommonDir: '/repo/.git',
			gatherDesired: async () => ({ openPrs: [], listingOk: true, repositoryOk: true }),
			gatherObserved: async () => ({
				ownerRows: [], ownerRowsOk: true,
				migrationGate: { state: 'complete', snapshot_hash: 'a'.repeat(64) },
				prRows: [],
			}),
			reconcile: () => ({ actions: [{ type: 'upsertPrRow', pr: PR }] }),
			execute: async () => ({ ok: false, changed: false }),
			authority: { enumerateOwners: async () => ({ ok: true, records: [] }) },
		});
		expect(result).toMatchObject({ executionOk: false, authorityOk: true, activeOwnerCount: 0 });
	});

	test('retries terminal completion until the durable receipt verifier succeeds', async () => {
		let attempts = 0;
		const pending = { ...RECORD, phase: 'terminal_pending', terminalReceiptId: 'receipt-7' };
		const authority = {
			completeTerminal: async (_identity, _input) => {
				attempts += 1;
				return attempts === 1
					? { ok: false, changed: false, reason: 'receipt_unverified', record: pending }
					: { ok: true, changed: true, reason: 'complete', record: { ...pending, phase: 'complete' } };
			},
		};
		const action = { type: 'completeTerminal', owner: pending };
		expect(await execute([action], { authority })).toMatchObject({ ok: false, changed: false });
		expect(await execute([action], { authority })).toMatchObject({ ok: true, changed: true });
		expect(attempts).toBe(2);
	});
});
