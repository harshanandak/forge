'use strict';

const { describe, expect, test } = require('bun:test');
const { runDaemon } = require('../../lib/pr-monitor/reconcile-executor');

function base(overrides = {}) {
	return {
		gitCommonDir: '/repo/.git',
		repo: 'acme/repo',
		acquire: () => ({ ok: true, token: 'lease-token' }),
		startHeartbeat: () => ({ timer: true }),
		stopHeartbeat: () => {},
		release: () => {},
		buildBroker: async () => ({
			broker: { close: async () => {} },
			driver: {},
			databaseConfig: { databasePath: '/repo/.git/forge/kernel.sqlite' },
		}),
		migrateLegacyAuthority: async () => ({ ok: true, state: 'complete' }),
		exit: () => {},
		...overrides,
	};
}

describe('owner-authority daemon lifecycle', () => {
	test('a foreign election lease exits before migration or reconciliation', async () => {
		let touched = false;
		const result = await runDaemon('/repo', base({
			acquire: () => ({ ok: false }),
			migrateLegacyAuthority: async () => { touched = true; },
			convergeOnce: async () => { touched = true; },
		}));
		expect(result).toEqual({ ok: false, reason: 'foreign-lease' });
		expect(touched).toBe(false);
	});

	test('once mode retires only after a complete owner enumeration', async () => {
		let releases = 0;
		const retired = await runDaemon('/repo', base({
			once: true,
			release: () => { releases += 1; },
			convergeOnce: async () => ({ desiredCount: 0, authorityOk: true, activeOwnerCount: 0 }),
		}));
		expect(retired.ok).toBe(true);
		expect(releases).toBe(1);

		const retained = await runDaemon('/repo', base({
			once: true,
			release: () => { releases += 1; },
			convergeOnce: async () => ({ desiredCount: 0, authorityOk: true, activeOwnerCount: 1 }),
		}));
		expect(retained.ok).toBe(true);
		expect(releases).toBe(1);
	});

	test('once mode retains the daemon when reconciliation execution failed', async () => {
		let releases = 0;
		const result = await runDaemon('/repo', base({
			once: true,
			release: () => { releases += 1; },
			convergeOnce: async () => ({
				desiredCount: 0, authorityOk: true, activeOwnerCount: 0, executionOk: false,
			}),
		}));
		expect(result.ok).toBe(true);
		expect(releases).toBe(0);
	});

	test('never closes a caller-owned broker while retiring its lease', async () => {
		let closes = 0;
		let built = false;
		await runDaemon('/repo', base({
			once: true,
			buildBroker: async () => { built = true; return { broker: null, driver: null }; },
			broker: { close: async () => { closes += 1; } },
			driver: {},
			convergeOnce: async () => ({
				desiredCount: 0, authorityOk: true, activeOwnerCount: 0, executionOk: true,
			}),
		}));
		expect(closes).toBe(0);
		expect(built).toBe(false);
	});

	test('lease loss after a pass retires without another convergence pass', async () => {
		let ownsCalls = 0;
		let passes = 0;
		let releases = 0;
		let exits = 0;
		const result = await runDaemon('/repo', base({
			ownsLease: () => { ownsCalls += 1; return ownsCalls === 1; },
			convergeOnce: async () => {
				passes += 1;
				return { desiredCount: 1, authorityOk: true, activeOwnerCount: 1 };
			},
			release: () => { releases += 1; },
			exit: () => { exits += 1; },
		}));
		expect(result).toMatchObject({ ok: true, retired: true });
		expect({ passes, releases, exits }).toEqual({ passes: 1, releases: 1, exits: 1 });
	});

	test('missing Kernel driver fails closed before migration or reconciliation', async () => {
		let touched = false;
		const result = await runDaemon('/repo', base({
			buildBroker: async () => ({ broker: null, driver: null }),
			migrateLegacyAuthority: async () => { touched = true; },
			convergeOnce: async () => { touched = true; },
		}));
		expect(result).toEqual({ ok: false, reason: 'authority-unavailable' });
		expect(touched).toBe(false);
	});

	test('threads the broker-built terminal receipt verifier into migration', async () => {
		const verifier = async () => true;
		let received;
		await runDaemon('/repo', base({
			once: true,
			buildBroker: async () => ({
				broker: { close: async () => {} }, driver: {}, databaseConfig: {},
				verifyTerminalReceipt: verifier,
			}),
			migrateLegacyAuthority: async (_root, opts) => {
				received = opts.verifyTerminalReceipt;
				return { ok: true, state: 'complete' };
			},
			convergeOnce: async () => ({
				desiredCount: 0, authorityOk: true, activeOwnerCount: 0, executionOk: true,
			}),
		}));
		expect(received).toBe(verifier);
	});
});
