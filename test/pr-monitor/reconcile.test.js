'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const { reconcile, decideLifecycle, LIFECYCLE_STATUS } = require('../../lib/pr-monitor/reconcile');

const REPO = 'acme/forge';
const NOW = '2026-08-19T00:00:00.000Z';
const GATE = { state: 'complete', snapshot_hash: 'a'.repeat(64) };

function pr(number, fields = {}) {
	return {
		repo: REPO, number, branch: `pr-${number}`, headSha: `sha-${number}`,
		issueId: null, worktreeId: null, journalPtr: null, ...fields,
	};
}

function owner(number, phase, fields = {}) {
	return {
		version: 1, repo: REPO, pr: number, generation: `generation-${number}`,
		phase, controllerPid: null, watcherPid: null, startedAt: NOW, updatedAt: NOW,
		heartbeatAt: null, terminalReceiptId: null, blockReason: null,
		legacyEvidenceHash: null, ...fields,
	};
}

function desired(openPrs = []) {
	return { openPrs, repo: REPO, gitCommonDir: '/repo/.git', listingOk: true, repositoryOk: true };
}

function observed(prRows = [], ownerRows = [], fields = {}) {
	return { prRows, ownerRows, ownerRowsOk: true, migrationGate: GATE, ...fields };
}

describe('reconcile() — owner-row diff rules', () => {
	test('new desired PR upserts linkage before reserving one watcher generation', () => {
		const actions = reconcile(desired([pr(5)]), observed()).actions;
		expect(actions.map(action => action.type)).toEqual(['upsertPrRow', 'reserveWatcher']);
		expect(actions[0].row).toMatchObject({ repo: REPO, number: 5, head_sha: 'sha-5' });
		expect(actions[1].pr).toMatchObject({ repo: REPO, number: 5 });
	});

	test('closed PR retires linkage while a live watcher remains authoritative', () => {
		const row = { repo: REPO, number: 5, state: 'open', head_sha: 'sha-5' };
		const running = owner(5, 'running', { watcherPid: 55, watcherAlive: true });
		const actions = reconcile(desired(), observed([row], [running])).actions;
		expect(actions.map(action => action.type)).toEqual(['retire']);
		expect(actions.some(action => action.type === 'requestStop')).toBe(false);
	});

	test('dead terminal owner is completed before the closed linkage is retired', () => {
		const row = { repo: REPO, number: 5, state: 'open', head_sha: 'sha-5' };
		const terminal = owner(5, 'terminal_pending', {
			watcherPid: 55, watcherAlive: false, terminalReceiptId: 'receipt-5',
		});
		const actions = reconcile(desired(), observed([row], [terminal])).actions;
		expect(actions.map(action => action.type)).toEqual(['completeTerminal', 'retire']);
	});

	test('dead starting and running owners recover through their exact row fences', () => {
		const starting = reconcile(desired([pr(5)]), observed([], [
			owner(5, 'starting', { controllerPid: 50, controllerAlive: false }),
		])).actions;
		expect(starting.map(action => action.type)).toEqual(['upsertPrRow', 'recoverStarting']);

		const running = reconcile(desired([pr(5)]), observed([], [
			owner(5, 'running', { watcherPid: 55, watcherAlive: false }),
		])).actions;
		expect(running.map(action => action.type)).toEqual(['upsertPrRow', 'recoverWatcher']);
	});

	test('an open PR reopens only from its exact complete generation and receipt', () => {
		const complete = owner(5, 'complete', { terminalReceiptId: 'receipt-5' });
		const actions = reconcile(desired([pr(5)]), observed([], [complete])).actions;
		expect(actions.map(action => action.type)).toEqual(['upsertPrRow', 'reopenWatcher']);
		expect(actions[1].owner).toEqual(complete);
	});

	test('head or soft-link drift refreshes the exact repository row without duplicating ownership', () => {
		const kernelRow = {
			repo: REPO, number: 5, state: 'open', branch: 'pr-5', head_sha: 'old',
			issue_id: null, worktree_id: null, journal_ptr: null,
		};
		const actions = reconcile(desired([pr(5, { issueId: 'issue-5' })]), observed([
			kernelRow,
		], [owner(5, 'running', { watcherPid: 55, watcherAlive: true })])).actions;
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ type: 'upsertPrRow', row: { head_sha: 'sha-5', issue_id: 'issue-5' } });
	});

	test('repository plus PR is the key, so a renamed-slug row is ignored during canonical reconciliation', () => {
		const stale = { repo: 'old/forge', number: 5, state: 'open', head_sha: 'sha-5' };
		const actions = reconcile(desired([pr(5)]), observed([stale])).actions;
		expect(actions.map(action => action.type)).toEqual(['upsertPrRow', 'reserveWatcher']);
	});

	test('bare legacy repository rows are coalesced into canonical linkage and retired', () => {
		const canonical = { repo: REPO, number: 5, state: 'open', issue_id: 'issue-5' };
		const legacy = { repo: 'forge', number: 5, state: 'open', head_sha: 'sha-5', worktree_id: 'tree-5' };
		const actions = reconcile(desired([pr(5)]), observed([canonical, legacy])).actions;
		expect(actions.map(action => action.type)).toEqual(['upsertPrRow', 'reserveWatcher', 'retire']);
		expect(actions[0].row).toMatchObject({
			repo: REPO, number: 5, head_sha: 'sha-5', issue_id: 'issue-5', worktree_id: 'tree-5',
		});
		expect(actions[2].pr).toEqual({ repo: 'forge', number: 5 });

		const conflict = decideLifecycle(desired([pr(5)]), observed([
			{ ...canonical, head_sha: 'canonical-sha' },
			{ ...legacy, head_sha: 'legacy-sha' },
		]), Date.parse(NOW));
		expect(conflict).toMatchObject({ status: LIFECYCLE_STATUS.CONFLICT });
	});

	test('ignores owner and PR rows from repositories other than the desired canonical repo', () => {
		const actions = reconcile(
			{ ...desired(), repo: REPO },
			observed([
				{ repo: 'other/project', number: 5, state: 'open', head_sha: 'sha-other' },
			], [
				owner(5, 'running', { repo: 'other/project', watcherAlive: true }),
			]),
		).actions;
		expect(actions).toEqual([]);
	});

	test('missing desired repository cannot retire or deactivate foreign rows', () => {
		const actions = reconcile(
			{ ...desired(), repo: undefined },
			observed([
				{ repo: 'other/project', number: 5, state: 'open', head_sha: 'sha-other' },
			], [
				owner(5, 'running', { repo: 'other/project', watcherAlive: false }),
			]),
		).actions;
		expect(actions).toEqual([]);
	});

	test('already-converged desired, linkage, and owner rows emit no actions', () => {
		const kernelRow = {
			repo: REPO, number: 5, state: 'open', branch: 'pr-5', head_sha: 'sha-5',
			issue_id: null, worktree_id: null, journal_ptr: null,
		};
		expect(reconcile(desired([pr(5)]), observed([
			kernelRow,
		], [owner(5, 'running', { watcherPid: 55, watcherAlive: true })])).actions).toEqual([]);
	});

	test('identical desired duplicates converge once while conflicting authority fails closed', () => {
		const duplicate = pr(5);
		const accepted = decideLifecycle(desired([duplicate, { ...duplicate }]), observed());
		expect(accepted.status).toBe(LIFECYCLE_STATUS.PASS);
		expect(accepted.actions.map(action => action.type)).toEqual(['upsertPrRow', 'reserveWatcher']);

		const conflict = decideLifecycle(desired([duplicate, { ...duplicate, headSha: 'other' }]), observed());
		expect(conflict).toMatchObject({ status: LIFECYCLE_STATUS.CONFLICT, actions: [] });

		const duplicateOwners = decideLifecycle(desired([duplicate]), observed([], [
			owner(5, 'running'), owner(5, 'running'),
		]));
		expect(duplicateOwners).toMatchObject({ status: LIFECYCLE_STATUS.CONFLICT, actions: [] });
	});

	test('incomplete listing, owner enumeration, or migration gate fails closed', () => {
		expect(decideLifecycle({ ...desired([pr(5)]), listingOk: false }, observed()).actions).toEqual([]);
		expect(decideLifecycle(desired([pr(5)]), observed([], [], { ownerRowsOk: false })).actions).toEqual([]);
		expect(decideLifecycle(desired([pr(5)]), observed([], [], {
			migrationGate: { state: 'quarantined' },
		})).actions).toEqual([]);
	});

	test('is deterministic, input-pure, and free of filesystem or process dependencies', () => {
		const left = Object.freeze(desired([Object.freeze(pr(5))]));
		const right = Object.freeze(observed());
		expect(reconcile(left, right, 1)).toEqual(reconcile(left, right, 2));
		const source = fs.readFileSync(path.join(__dirname, '../../lib/pr-monitor/reconcile.js'), 'utf8');
		expect(source).not.toContain("require('node:fs')");
		expect(source).not.toContain("require('node:child_process')");
	});
});
