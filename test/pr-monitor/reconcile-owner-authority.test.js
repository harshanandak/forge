'use strict';

const { describe, expect, test } = require('bun:test');
const { decideLifecycle } = require('../../lib/pr-monitor/reconcile');

const NOW = '2026-08-19T00:00:00.000Z';

function desired(openPrs, controllerPid = null) {
	return { openPrs, controllerPid, listingOk: true, repositoryOk: true, gitCommonDir: '/repo/.git' };
}

function observed(ownerRows, overrides = {}) {
	return {
		ownerRows,
		ownerRowsOk: true,
		migrationGate: { state: 'complete', snapshot_hash: 'a'.repeat(64) },
		prRows: [],
		...overrides,
	};
}

function pr(repo = 'acme/project', number = 7) {
	return { repo, number, branch: 'topic', headSha: 'abc' };
}

function owner(repo, number, phase, fields = {}) {
	return {
		version: 1,
		repo,
		pr: number,
		generation: `generation-${repo}-${number}`,
		phase,
		controllerPid: null,
		watcherPid: null,
		startedAt: NOW,
		updatedAt: NOW,
		heartbeatAt: null,
		terminalReceiptId: null,
		blockReason: null,
		legacyEvidenceHash: null,
		...fields,
	};
}

describe('reconcile owner-row authority', () => {
	test('fails closed without a complete migration gate and never consults lease watchers', () => {
		const result = decideLifecycle(desired([pr()]), {
			prRows: [], ownerRows: [], ownerRowsOk: true,
			lease: { watchers: [{ pr: 7, pid: 99, startedAt: NOW }] },
		});
		expect(result).toMatchObject({ status: 'INCOMPLETE', actions: [] });
	});

	test('reserves by exact canonical repo and PR identity', () => {
		const other = owner('other/project', 7, 'running', {
			watcherPid: 55, heartbeatAt: NOW, watcherAlive: true,
		});
		const result = decideLifecycle(desired([pr()]), observed([other]));
		expect(result.status).toBe('PASS');
		expect(result.actions).toContainEqual({ type: 'reserveWatcher', pr: pr() });
	});

	test('recovers dead owners while leaving live closed owners authoritative', () => {
		const openStarting = owner('acme/project', 7, 'starting', {
			controllerPid: 101, controllerAlive: false,
		});
		const closedRunning = owner('acme/project', 8, 'running', {
			watcherPid: 202, heartbeatAt: NOW, watcherAlive: true,
		});
		const result = decideLifecycle(desired([pr()]), observed([openStarting, closedRunning]));
		expect(result.actions).toContainEqual({ type: 'recoverStarting', owner: openStarting, pr: pr() });
		expect(result.actions.some(action => action.type === 'requestStop')).toBe(false);
		expect(result.actions.filter(action => action.owner === closedRunning)).toEqual([]);
		expect(result.actions.some(action => action.type === 'reapOrphan')).toBe(false);
	});

	test('retries an abandoned start owned by this daemon without stealing another live controller', () => {
		const abandoned = owner('acme/project', 7, 'starting', {
			controllerPid: 101, controllerAlive: true,
		});
		const ownResult = decideLifecycle(desired([pr()], 101), observed([abandoned]));
		expect(ownResult.actions).toContainEqual({ type: 'retryStarting', owner: abandoned, pr: pr() });

		const foreignResult = decideLifecycle(desired([pr()], 202), observed([abandoned]));
		expect(foreignResult.actions.some(action => /Starting$/.test(action.type))).toBe(false);
	});

	test('replays terminal completion and reopens only from the exact complete row', () => {
		const pending = owner('acme/project', 8, 'terminal_pending', {
			watcherPid: 88, watcherAlive: false, terminalReceiptId: 'receipt-8',
		});
		const complete = owner('acme/project', 7, 'complete', {
			terminalReceiptId: 'receipt-7',
		});
		const result = decideLifecycle(desired([pr()]), observed([pending, complete]));
		expect(result.actions).toContainEqual({ type: 'completeTerminal', owner: pending });
		expect(result.actions).toContainEqual({ type: 'reopenWatcher', owner: complete, pr: pr() });
	});

	test('rejects duplicate or non-canonical owner identities', () => {
		const duplicate = owner('acme/project', 7, 'complete', { terminalReceiptId: 'r' });
		const dup = decideLifecycle(desired([pr()]), observed([duplicate, { ...duplicate }]));
		expect(dup).toMatchObject({ status: 'CONFLICT', actions: [] });

		const malformed = decideLifecycle(desired([pr()]), observed([owner('Acme/Project', 7, 'complete')]));
		expect(malformed).toMatchObject({ status: 'INCOMPLETE', actions: [] });
	});
});
