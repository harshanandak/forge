'use strict';

const { describe, expect, test } = require('bun:test');
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
});
