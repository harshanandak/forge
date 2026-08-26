'use strict';

const { describe, expect, test } = require('bun:test');
const { processIdentityAlive, PID_START_SKEW_MS } = require('../../lib/pr-monitor/process-identity');

const MARKER = '2026-08-19T00:00:00.000Z';

function probe(overrides = {}) {
	return processIdentityAlive({
		pid: 44,
		startedAt: MARKER,
		isPidAlive: async () => true,
		pidStartedAt: async () => Date.parse(MARKER) - 1000,
		...overrides,
	});
}

describe('process identity', () => {
	test('reports a gone PID as dead without consulting the start time', async () => {
		let probed = false;
		expect(await probe({
			isPidAlive: async () => false,
			pidStartedAt: async () => { probed = true; return 0; },
		})).toBe('dead');
		expect(probed).toBe(false);
	});

	test('proves reuse only when the process booted materially after the marker', async () => {
		const marker = Date.parse(MARKER);
		expect(await probe({ pidStartedAt: async () => marker + PID_START_SKEW_MS + 1 })).toBe('reused');
		// Inside the slack the process may still be the owner that wrote the marker.
		expect(await probe({ pidStartedAt: async () => marker + PID_START_SKEW_MS })).toBe('alive');
		expect(await probe({ pidStartedAt: async () => marker - 60_000 })).toBe('alive');
	});

	test('keeps a live PID alive when identity cannot be established', async () => {
		// Every non-Linux platform answers null today; behaviour must not change there.
		expect(await probe({ pidStartedAt: async () => null })).toBe('alive');
		expect(await probe({ pidStartedAt: async () => { throw new Error('unavailable'); } })).toBe('alive');
		expect(await probe({ startedAt: null })).toBe('alive');
		expect(await probe({ startedAt: 'not-a-timestamp' })).toBe('alive');
	});

	test('reports unknown when liveness itself is unavailable, never reused', async () => {
		expect(await probe({ isPidAlive: async () => null })).toBe('unknown');
		expect(await probe({ pid: 0 })).toBe('unknown');
		expect(await probe({ pid: 'forty-four' })).toBe('unknown');
		expect(await probe({ isPidAlive: undefined })).toBe('unknown');
	});

	test('propagates a rejecting liveness probe to the caller, as the bare probes did', async () => {
		await expect(probe({ isPidAlive: async () => { throw new Error('probe failed'); } })).rejects.toThrow('probe failed');
	});
});
