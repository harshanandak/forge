'use strict';

const { describe, expect, test } = require('bun:test');

const { reconcileClaims } = require('../../lib/kernel/claim-reconciler');

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

	test('is idempotent when the release reports that the claim is already inactive', async () => {
		const candidate = claim('once');
		let calls = 0;
		const options = {
			claims: [candidate],
			readManifest: () => manifestFor(candidate),
			worktreeExists: () => false,
			isProcessAlive: () => false,
			getProcessIdentity: () => null,
			releaseClaim: async () => {
				calls += 1;
				return calls === 1;
			},
		};

		expect(await reconcileClaims(options)).toEqual({ examined: 1, released: [candidate.id] });
		expect(await reconcileClaims(options)).toEqual({ examined: 1, released: [] });
		expect(calls).toBe(2);
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
