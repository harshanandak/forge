'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const journal = require('../../lib/pr-monitor/journal');
const { pollEvents } = require('../../lib/pr-monitor/monitor');

describe('monitor owner signal', () => {
	test('never uses journal PID-file state to decide whether an inline pass may run', async () => {
		expect(journal.watcherRunning).toBeUndefined();
		let gathered = 0;
		const result = await pollEvents({
			dir: '/unused',
			gather: async () => { gathered += 1; return {}; },
			isOwnerRunning: async () => true,
			readEventsSince: () => [],
		});
		expect(result.ranPass).toBe(false);
		expect(gathered).toBe(0);
	});

	test('fails closed when owner authority is unavailable', async () => {
		let gathered = 0;
		const result = await pollEvents({
			dir: '/unused',
			gather: async () => { gathered += 1; return {}; },
			readEventsSince: () => [],
		});
		expect(result).toMatchObject({ ranPass: false, authorityUnavailable: true });
		expect(gathered).toBe(0);
	});

	test('reads the Kernel owner row when the caller provides owner identity and options', async () => {
		let reads = 0;
		const result = await pollEvents({
			dir: '/unused',
			repo: 'acme/project',
			pr: 7,
			ownerOptions: { driver: {} },
			owner: {
				readOwner: async (identity, _options) => {
					reads += 1;
					expect(identity).toEqual({ repo: 'acme/project', pr: 7 });
					return { ok: true, record: { phase: 'running', watcherPid: 44 } };
				},
			},
			gather: async () => { throw new Error('inline pass must not run'); },
			readEventsSince: () => [],
		});
		expect(reads).toBe(1);
		expect(result).toMatchObject({ ranPass: false });
		expect(result.authorityUnavailable).toBeUndefined();
	});

	test('refuses the inline pass unless the shared migration gate proves EXACTLY complete', async () => {
		const idleOwner = async () => ({ ok: true, record: null });
		const gateStates = ['quarantined', 'conflict', 'pending', 'unknown', null, undefined];
		for (const state of gateStates) {
			let gathered = 0;
			const result = await pollEvents({
				dir: '/unused',
				repo: 'acme/project',
				pr: 7,
				ownerOptions: { driver: {} },
				owner: {
					readOwner: idleOwner,
					readMigrationGate: async () => ({ ok: true, gate: state == null ? null : { state } }),
				},
				gather: async () => { gathered += 1; return {}; },
				readEventsSince: () => [],
			});
			expect(result).toMatchObject({ ranPass: false, migrationGateIncomplete: true });
			expect(gathered).toBe(0);
		}
	});

	test('fails closed when the migration gate read itself is unavailable or throws', async () => {
		const idleOwner = async () => ({ ok: true, record: null });
		for (const readMigrationGate of [
			async () => ({ ok: false, reason: 'authority_unavailable', gate: null }),
			async () => { throw new Error('gate read exploded'); },
			undefined,
		]) {
			let gathered = 0;
			const result = await pollEvents({
				dir: '/unused',
				repo: 'acme/project',
				pr: 7,
				ownerOptions: { driver: {} },
				owner: { readOwner: idleOwner, readMigrationGate },
				gather: async () => { gathered += 1; return {}; },
				readEventsSince: () => [],
			});
			expect(result).toMatchObject({ ranPass: false, migrationGateIncomplete: true });
			expect(gathered).toBe(0);
		}
	});

	test('runs the inline pass once the migration gate reports complete', async () => {
		let gathered = 0;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-monitor-gate-'));
		const result = await pollEvents({
			dir,
			repo: 'acme/project',
			pr: 7,
			ownerOptions: { driver: {} },
			owner: {
				readOwner: async () => ({ ok: true, record: null }),
				readMigrationGate: async () => ({ ok: true, gate: { state: 'complete' } }),
			},
			gather: async () => {
				gathered += 1;
				return { repo: 'project', pr: '7', verdict: 'GREEN', checks: [], threads: [] };
			},
			readEventsSince: () => [],
			now: () => '2026-07-13T00:00:00.000Z',
		});
		expect(result.ranPass).toBe(true);
		expect(result.migrationGateIncomplete).toBeUndefined();
		expect(gathered).toBe(1);
	});
});
