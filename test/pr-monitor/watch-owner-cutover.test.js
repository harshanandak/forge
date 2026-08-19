'use strict';

const { describe, test, expect } = require('bun:test');

const { startPrWatcherDetached } = require('../../lib/pr-monitor/watch-lifecycle');
const { watchLoop } = require('../../lib/pr-monitor/watch');
const shepherd = require('../../lib/commands/shepherd');

const NOW = '2026-08-19T12:00:00.000Z';
const readCompleteGate = async () => ({
	ok: true, changed: false, reason: 'read', gate: { state: 'complete' },
});

function ownerRecord(overrides = {}) {
	return {
		repo: 'harshanandak/forge', pr: 42, generation: 'generation-1',
		phase: 'starting', controllerPid: 101, watcherPid: null,
		startedAt: NOW, updatedAt: NOW, heartbeatAt: null,
		terminalReceiptId: null, blockReason: null, legacyEvidenceHash: null,
		...overrides,
	};
}

describe('watch owner production cutover', () => {
	test('reserves the exact upstream identity before spawning and passes the reservation to the child', async () => {
		const order = [];
		let spawnArgs;
		const result = await startPrWatcherDetached({
			prNumber: 42,
			cwd: '/fork-checkout',
			controllerPid: 101,
			repository: 'HarshaNandak/Forge',
			owner: {
				readMigrationGate: readCompleteGate,
				reserveStarting: async (identity, input) => {
					order.push(['reserve', identity, input]);
					return { ok: true, changed: true, reason: 'acquired', record: ownerRecord() };
				},
				abortStarting: async () => ({ ok: true, changed: true, reason: 'aborted', record: null }),
			},
			spawn: (_bin, args) => {
				order.push(['spawn']);
				spawnArgs = args;
				return { pid: 202, on() {}, unref() {} };
			},
		});

		expect(order[0][0]).toBe('reserve');
		expect(order[0][1]).toEqual({ repo: 'harshanandak/forge', pr: 42 });
		expect(order[1][0]).toBe('spawn');
		expect(spawnArgs).toEqual(expect.arrayContaining([
			'--repo', 'harshanandak/forge', '--generation', 'generation-1',
			'--controller-pid', '101', '--started-at', NOW,
		]));
		expect(result).toEqual(expect.objectContaining({
			started: true, pid: 202, generation: 'generation-1', repository: 'harshanandak/forge',
	}));
	});

	test('spawns from an exact pre-reserved recovery envelope without reserving twice', async () => {
		let reserveCalls = 0;
		let spawnArgs;
		const record = ownerRecord();
		const result = await startPrWatcherDetached({
			prNumber: 42,
			cwd: '/repo',
			repository: 'harshanandak/forge',
			controllerPid: 101,
			reservation: { ok: true, changed: true, reason: 'recovered', record },
			owner: {
				readMigrationGate: readCompleteGate,
				reserveStarting: async () => { reserveCalls += 1; throw new Error('must not reserve'); },
				abortStarting: async () => ({ ok: true }),
			},
			spawn: (_bin, args) => { spawnArgs = args; return { pid: 203, on() {}, unref() {} }; },
		});

		expect(reserveCalls).toBe(0);
		expect(spawnArgs).toEqual(expect.arrayContaining(['--generation', 'generation-1']));
		expect(result.started).toBe(true);
	});

	test.each([
		['repository', { repo: 'someone/else' }],
		['PR', { pr: 43 }],
		['controller', { controllerPid: 102 }],
		['generation', { generation: '' }],
		['started-at', { startedAt: 'not-a-timestamp' }],
		['phase', { phase: 'running' }],
	])('rejects a pre-reserved envelope with a mismatched %s fence', async (_field, overrides) => {
		let spawnCalls = 0;
		const result = await startPrWatcherDetached({
			prNumber: 42,
			repository: 'harshanandak/forge',
			controllerPid: 101,
			reservation: {
				ok: true, changed: true, reason: 'recovered', record: ownerRecord(overrides),
			},
			owner: {
				readMigrationGate: readCompleteGate,
				abortStarting: async () => ({ ok: true }),
			},
			spawn: () => { spawnCalls += 1; return { pid: 203, on() {}, unref() {} }; },
		});

		expect(result).toEqual({ started: false, reason: 'invalid-reservation' });
		expect(spawnCalls).toBe(0);
	});

	test('child binds and checkpoints through owner rows without PID-file writers', async () => {
		const calls = [];
		const result = await watchLoop({
			repo: 'harshanandak/forge', pr: 42, generation: 'generation-1',
			controllerPid: 101, pid: 202, dir: '/journal', maxPasses: 1,
			owner: {
				bindRunning: async (_identity, input) => {
					calls.push(['bind', input]);
					return { ok: true, changed: true, reason: 'bound', record: ownerRecord({
						phase: 'running', controllerPid: null, watcherPid: 202, heartbeatAt: NOW,
					}) };
				},
				readOwner: async () => ({ ok: true, record: ownerRecord({
					phase: 'running', controllerPid: null, watcherPid: 202, heartbeatAt: NOW,
				}) }),
				heartbeat: async (_identity, input) => {
					calls.push(['heartbeat', input]);
					return { ok: true, changed: true, reason: 'heartbeat', record: null };
				},
				requestStop: async (_identity, input) => {
					calls.push(['request-stop', input]);
					return { ok: true, changed: true, reason: 'stop-requested', record: null };
				},
				releaseNonterminal: async () => ({ ok: true, changed: true, reason: 'released', record: null }),
			},
			runMonitorPass: async () => ({ events: [], journalCursor: 0 }),
		});

		expect(result.started).toBe(true);
		expect(calls.map(([kind]) => kind)).toEqual(['bind', 'heartbeat', 'request-stop']);
	});

	test('a direct watch reserves before entering the loop and passes the exact owner identity', async () => {
		const order = [];
		let loopContext;
		const owner = {
			readMigrationGate: readCompleteGate,
			reserveStarting: async (identity, input) => {
				order.push(['reserve', identity, input]);
				return { ok: true, changed: true, reason: 'acquired', record: ownerRecord({ controllerPid: process.pid }) };
			},
		};
		const result = await shepherd.handler(['watch', '42', '--repo', 'harshanandak/forge'], {}, '/repo', {
			dir: '/journal',
			gather: async () => ({}),
			store: {},
			owner,
			ownerOptions: { driver: {} },
			signal: { aborted: false },
			watchLoop: async (ctx) => {
				order.push(['loop']);
				loopContext = ctx;
				return { started: true, passes: 0, stopped: false };
			},
		});

		expect(order[0]).toEqual(['reserve', { repo: 'harshanandak/forge', pr: 42 }, { controllerPid: process.pid }]);
		expect(order[1]).toEqual(['loop']);
		expect(loopContext).toEqual(expect.objectContaining({
			repo: 'harshanandak/forge', pr: 42, generation: 'generation-1',
			controllerPid: process.pid, owner,
		}));
		expect(result.success).toBe(true);
	});

	test('cooperatively acknowledges stop_requested without running a pass or signaling a PID', async () => {
		let monitorCalled = false;
		let released = false;
		const owner = {
			bindRunning: async () => ({ ok: true, record: ownerRecord({ phase: 'running', watcherPid: 202 }) }),
			readOwner: async () => ({ ok: true, record: ownerRecord({
				phase: 'stop_requested', controllerPid: null, watcherPid: 202, heartbeatAt: NOW,
			}) }),
			releaseNonterminal: async () => { released = true; return { ok: true }; },
		};
		const result = await watchLoop({
			repo: 'harshanandak/forge', pr: 42, generation: 'generation-1',
			controllerPid: 101, pid: 202, owner,
			runMonitorPass: async () => { monitorCalled = true; return { events: [] }; },
		});

		expect(result).toEqual(expect.objectContaining({ stopped: true, reason: 'stop-requested', passes: 0 }));
		expect(monitorCalled).toBe(false);
		expect(released).toBe(true);
	});

	test('retries terminal work until a durable receipt can be recorded, then retains terminal_pending', async () => {
		let pass = 0;
		let recordCalls = 0;
		let recordedReceiptId;
		let released = false;
		const running = ownerRecord({
			phase: 'running', controllerPid: null, watcherPid: 202, heartbeatAt: NOW,
		});
		const owner = {
			bindRunning: async () => ({ ok: true, record: running }),
			readOwner: async () => ({ ok: true, record: running }),
			heartbeat: async () => ({ ok: true, changed: true, reason: 'heartbeat' }),
			recordTerminal: async (_identity, input) => {
				recordCalls += 1;
				recordedReceiptId = input.terminalReceiptId;
				return { ok: true, changed: true, reason: 'terminal', record: ownerRecord({ phase: 'terminal_pending' }) };
			},
			releaseNonterminal: async () => { released = true; return { ok: true }; },
		};
		const result = await watchLoop({
			repo: 'harshanandak/forge', pr: 42, generation: 'generation-1',
			controllerPid: 101, pid: 202, owner, maxPasses: 2,
			emit: () => {},
			sleep: async () => {},
			runMonitorPass: async () => {
				pass += 1;
				return pass === 1
					? { events: [{ type: 'pr.merged' }] }
					: { events: [], terminalReceiptId: 'receipt-42' };
			},
		});

		expect(pass).toBe(2);
		expect(recordCalls).toBe(1);
		expect(recordedReceiptId).toBe('receipt-42');
		expect(released).toBe(false);
		expect(result).toEqual(expect.objectContaining({ stopped: true, reason: 'terminal-pending', passes: 2 }));
	});

	test('retains a running owner after a terminal receipt attempt fails, including an interrupt', async () => {
		for (const mode of ['transient', 'throw']) {
			let recordCalls = 0;
			let released = false;
			const signal = { aborted: false };
			const owner = {
				bindRunning: async () => ({ ok: true, record: ownerRecord({
					phase: 'running', controllerPid: null, watcherPid: 202, heartbeatAt: NOW,
				}) }),
				readOwner: async () => ({ ok: true, record: ownerRecord({
					phase: 'running', controllerPid: null, watcherPid: 202, heartbeatAt: NOW,
				}) }),
				recordTerminal: async () => {
					recordCalls += 1;
					if (mode === 'throw') throw new Error('receipt write failed');
					return { ok: false, changed: false, reason: 'receipt-unavailable' };
				},
				heartbeat: async () => { signal.aborted = true; return { ok: true, changed: true }; },
				releaseNonterminal: async () => { released = true; return { ok: true }; },
			};
			const run = watchLoop({
				repo: 'harshanandak/forge', pr: 42, generation: 'generation-1',
				controllerPid: 101, pid: 202, owner, signal, maxPasses: 2,
				emit: () => {}, runMonitorPass: async () => ({
					events: [], terminalReceiptId: 'receipt-42',
				}),
			});
			if (mode === 'throw') await expect(run).rejects.toThrow('receipt write failed');
			else await run;
			expect(recordCalls).toBe(1);
			expect(released).toBe(false);
		}
	});

});
