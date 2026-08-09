'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const { reconcileClaims, reconcileKernelClaims } = require('../../lib/kernel/claim-reconciler');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
const { runIssueOperation } = require('../../lib/forge-issues');
const { createProcessTree, readProcessManifest } = require('../../scripts/process-tree');

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
	test('forwards claim read context and config to the driver', async () => {
		const received = [];
		const context = { actor: 'review-agent' };
		const config = { backend: 'kernel' };
		const result = await reconcileKernelClaims({
			driver: {
				listWorktrees: () => [],
				releaseExactClaimIfWorktreeMissing: () => false,
				listActiveClaims: (...args) => {
					received.push(args);
					return [];
				},
			},
			context,
			config,
		});

		expect(received).toEqual([[context, config]]);
		expect(result).toEqual({ examined: 0, released: [] });
	});

	test('uses one propagated runtime token for the process manifest and claim session', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claim-runtime-'));
		tempDirs.push(root);
		const manifestPath = path.join(root, 'run.json');
		const sessionId = 'session-runtime-propagation';
		const tree = createProcessTree({
			manifestPath,
			env: { FORGE_SESSION_ID: sessionId },
			processApi: { pid: 4400, kill() {} },
			getProcessIdentity: () => 'process-start-4400',
			reconcile: false,
		});
		const childEnv = tree.envFor({
			FORGE_SESSION_ID: sessionId,
			FORGE_WORKTREE_ID: 'worktree-runtime-propagation',
		});
		let claimContext;

		await runIssueOperation('claim', ['issue-runtime-propagation'], root, {
			env: childEnv,
			createService: () => ({
				async run(_operation, _args, context) {
					claimContext = context;
					return { success: true, ok: true };
				},
			}),
		});

		const manifest = readProcessManifest(manifestPath);
		expect(manifest.token).toBe(sessionId);
		expect(claimContext.sessionId).toBe(manifest.token);
		expect(claimContext.worktreeId).toBe('worktree-runtime-propagation');
		tree.cleanup('SIGTERM');
	});

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
			async releaseExactClaimIfWorktreeMissing(candidate, worktree, isMissing, receipt) {
				const currentWorktree = this.listWorktrees().find(row => row.id === worktree?.id
					&& row.path === worktree.path && row.registered_at === worktree.registered_at);
				if (!currentWorktree || isMissing(currentWorktree.path) !== true) return false;
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

	test('does not release when a missing worktree is re-registered before the guarded claim CAS', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claim-worktree-race-'));
		tempDirs.push(root);
		const databasePath = path.join(root, 'kernel.sqlite');
		const first = createBuiltinSQLiteDriver({ databasePath });
		const second = createBuiltinSQLiteDriver({ databasePath });
		await first.exec(`
			CREATE TABLE kernel_claims (
				id TEXT PRIMARY KEY, issue_id TEXT, actor TEXT, state TEXT,
				session_id TEXT, worktree_id TEXT, claimed_at TEXT, expires_at TEXT
			);
			CREATE TABLE kernel_worktrees (
				id TEXT PRIMARY KEY, git_common_dir TEXT, path TEXT, branch TEXT,
				actor TEXT, issue_id TEXT, work_folder TEXT, registered_at TEXT, state TEXT
			);
			INSERT INTO kernel_claims VALUES (
				'claim-race', 'issue-race', 'actor-race', 'active',
				'session-race', 'worktree-race', '2026-08-09T00:00:00.000Z', NULL
			);
			INSERT INTO kernel_worktrees VALUES (
				'worktree-race', '.git', 'missing-path', 'codex/race',
				'actor-race', 'issue-race', NULL, '2026-08-09T00:00:00.000Z', 'active'
			);
		`);
		let interleaved = false;
		const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
		const fsApi = {
			lstatSync() {
				if (!interleaved) {
					interleaved = true;
					void second.exec("UPDATE kernel_worktrees SET path = 'recreated-path', registered_at = '2026-08-09T00:01:00.000Z' WHERE id = 'worktree-race'");
				}
				throw missing;
			},
		};
		const candidate = claim('race', {
			id: 'claim-race', issue_id: 'issue-race', actor: 'actor-race',
			session_id: 'session-race', worktree_id: 'worktree-race',
		});

		const result = await reconcileKernelClaims({
			driver: first,
			fsApi,
			readManifest: () => manifestFor(candidate),
			isProcessAlive: () => false,
		});

		expect(interleaved).toBe(true);
		expect(result).toEqual({ examined: 1, released: [] });
		expect((await first.listActiveClaims()).map(row => row.id)).toEqual(['claim-race']);

		const settled = await reconcileKernelClaims({
			driver: first,
			fsApi,
			readManifest: () => manifestFor(candidate),
			isProcessAlive: () => false,
		});
		expect(settled).toEqual({ examined: 1, released: ['claim-race'] });
		expect(await first.listActiveClaims()).toEqual([]);
		first.close();
		second.close();
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
