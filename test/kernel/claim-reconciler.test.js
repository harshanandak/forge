'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const { reconcileClaims, reconcileKernelClaims } = require('../../lib/kernel/claim-reconciler');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

const tempDirs = [];

afterEach(() => {
	while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function claim(id, overrides = {}) {
	return {
		id,
		issue_id: `issue-${id}`,
		actor: 'forge-agent',
		session_id: `session-${id}`,
		worktree_id: `worktree-${id}`,
		state: 'active',
		...overrides,
	};
}

function manifestFor(candidate, overrides = {}) {
	return {
		version: 1,
		token: candidate.session_id,
		owner: {
			pid: 4100,
			identity: 'process-start-4100',
			startedAt: '2026-08-09T00:00:00.000Z',
		},
		children: [],
		...overrides,
	};
}

describe('kernel claim reconciler', () => {
	test('releases only a manifest-verified dead run whose linked worktree is missing', async () => {
		const eligible = claim('eligible');
		const live = claim('live');
		const activeWorktree = claim('active-worktree');
		const missingMarker = claim('missing-marker');
		const markerMismatch = claim('marker-mismatch');
		const unverifiable = claim('unverifiable');
		const released = [];
		const manifests = new Map([
			[eligible.session_id, manifestFor(eligible)],
			[live.session_id, manifestFor(live, { owner: { pid: 4200, identity: 'live-4200', startedAt: '2026-08-09T00:00:00.000Z' } })],
			[activeWorktree.session_id, manifestFor(activeWorktree)],
			[markerMismatch.session_id, manifestFor(markerMismatch, { token: 'another-session' })],
			[unverifiable.session_id, manifestFor(unverifiable, { owner: { pid: 4300, identity: null, startedAt: '2026-08-09T00:00:00.000Z' } })],
		]);

		const result = await reconcileClaims({
			claims: [eligible, live, activeWorktree, missingMarker, markerMismatch, unverifiable],
			readManifest: (sessionId) => manifests.get(sessionId) || null,
			worktreeExists: (worktreeId) => worktreeId === activeWorktree.worktree_id,
			isProcessAlive: (pid) => pid === 4200,
			getProcessIdentity: (pid) => (pid === 4200 ? 'live-4200' : null),
			releaseClaim: async (candidate, evidence) => released.push({ candidate, evidence }),
		});

		expect(released).toHaveLength(1);
		expect(released[0].candidate).toBe(eligible);
		expect(released[0].evidence).toEqual(expect.objectContaining({
			claim_id: eligible.id,
			issue_id: eligible.issue_id,
			session_id: eligible.session_id,
			worktree_id: eligible.worktree_id,
			owner_pid: 4100,
			owner_identity: 'process-start-4100',
			manifest_token: eligible.session_id,
		}));
		expect(result).toEqual({ examined: 6, released: [eligible.id] });
	});

	test('fails closed when a process manifest contains a malformed child entry', async () => {
		const candidate = claim('malformed-child');
		const released = [];

		const result = await reconcileClaims({
			claims: [candidate],
			readManifest: () => manifestFor(candidate, { children: [{}] }),
			worktreeExists: () => false,
			isProcessAlive: () => false,
			getProcessIdentity: () => null,
			releaseClaim: async (exactClaim) => released.push(exactClaim),
		});

		expect(result).toEqual({ examined: 1, released: [] });
		expect(released).toEqual([]);
	});

	test('production adapter conditionally releases one exact claim once with stable manifest evidence', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claim-reconcile-'));
		tempDirs.push(root);
		const manifestDir = path.join(root, 'manifests');
		const liveWorktreePath = path.join(root, 'live-worktree');
		fs.mkdirSync(manifestDir);
		fs.mkdirSync(liveWorktreePath);

		const eligible = claim('eligible-stateful');
		const unrelated = claim('unrelated-stateful');
		for (const candidate of [eligible, unrelated]) {
			fs.writeFileSync(
				path.join(manifestDir, `run-${candidate.id}.json`),
				JSON.stringify(manifestFor(candidate)),
				'utf8',
			);
		}

		const state = [eligible, unrelated];
		const evidence = [];
		let mutations = 0;
		const driver = {
			async issueOperation(operation) {
				expect(operation).toBe('claims');
				return { data: { claims: state.filter(candidate => candidate.state === 'active') } };
			},
			listWorktrees() {
				return [
					{ id: eligible.worktree_id, issue_id: eligible.issue_id, path: path.join(root, 'missing-worktree'), state: 'active' },
					{ id: unrelated.worktree_id, issue_id: unrelated.issue_id, path: liveWorktreePath, state: 'active' },
				];
			},
			async releaseExactClaim(candidate, receipt) {
				const stored = state.find(row => row.id === candidate.id
					&& row.issue_id === candidate.issue_id
					&& row.session_id === candidate.session_id
					&& row.worktree_id === candidate.worktree_id
					&& row.state === 'active');
				if (!stored) return false;
				stored.state = 'released';
				mutations += 1;
				evidence.push(receipt);
				return true;
			},
		};
		const options = { driver, manifestDir, isProcessAlive: () => false };

		expect(await reconcileKernelClaims(options)).toEqual({ examined: 2, released: [eligible.id] });
		const stableEvidence = JSON.stringify(evidence[0]);
		expect(Object.isFrozen(evidence[0])).toBe(true);
		expect(eligible.state).toBe('released');
		expect(unrelated.state).toBe('active');
		expect(mutations).toBe(1);

		expect(await reconcileKernelClaims(options)).toEqual({ examined: 1, released: [] });
		expect(mutations).toBe(1);
		expect(JSON.stringify(evidence[0])).toBe(stableEvidence);
	});

	test('SQLite exact release rejects stale ownership evidence and mutates once', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claim-exact-sqlite-'));
		tempDirs.push(root);
		const driver = createBuiltinSQLiteDriver({ databasePath: path.join(root, 'kernel.sqlite') });
		await driver.exec(`
			CREATE TABLE kernel_claims (
				id TEXT PRIMARY KEY, issue_id TEXT, actor TEXT, state TEXT,
				session_id TEXT, worktree_id TEXT, claimed_at TEXT, expires_at TEXT
			);
			INSERT INTO kernel_claims VALUES (
				'claim-exact', 'issue-exact', 'actor-exact', 'active',
				'session-exact', 'worktree-exact', '2026-08-09T00:00:00.000Z', NULL
			);
		`);
		const exact = {
			id: 'claim-exact', issue_id: 'issue-exact', actor: 'actor-exact',
			session_id: 'session-exact', worktree_id: 'worktree-exact',
		};

		expect(await driver.releaseExactClaim({ ...exact, session_id: 'stale-session' })).toBe(false);
		expect((await driver.listActiveClaims()).map(row => row.id)).toEqual(['claim-exact']);
		expect(await driver.releaseExactClaim(exact)).toBe(true);
		expect(await driver.releaseExactClaim(exact)).toBe(false);
		expect(await driver.listActiveClaims()).toEqual([]);
		driver.close();
	});

	test('fails closed for incomplete claims and dependency errors', async () => {
		const incomplete = claim('incomplete', { session_id: null });
		const unreadable = claim('unreadable');
		const released = [];

		const result = await reconcileClaims({
			claims: [incomplete, unreadable],
			readManifest: () => { throw new Error('marker cannot be inspected'); },
			worktreeExists: () => { throw new Error('worktree cannot be inspected'); },
			isProcessAlive: () => { throw new Error('process cannot be inspected'); },
			getProcessIdentity: () => { throw new Error('identity cannot be inspected'); },
			releaseClaim: async (candidate) => released.push(candidate),
		});

		expect(result).toEqual({ examined: 2, released: [] });
		expect(released).toEqual([]);
	});
});
