'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readKernelSnapshot, readStatusSnapshot } = require('../../lib/status/snapshot.js');
const { formatZeroArgStatus } = require('../../lib/status/presenter.js');
const { runIssueOperation } = require('../../lib/forge-issues.js');

// Regression coverage for bug 40f35797: `forge status` built its one-glance snapshot
// from the retired Beads store (.beads/issues.jsonl), so on a kernel-default repo it
// showed "Ready: none" and the dead-end "/plan" fallback while the Kernel held a full
// backlog. These tests drive the REAL kernel read path end to end (create -> ready ->
// snapshot -> presenter) so the flagship view can never silently blank again.

// Point create/read ops at one throwaway kernel DB. Mirrors makeKernelDeps in
// test/forge-issues.test.js so the seed writes and the snapshot reads share a store.
function makeKernelRepo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-kernel-'));
	const gitCommonDir = path.join(dir, '.git');
	fs.mkdirSync(gitCommonDir, { recursive: true });
	const kernelDeps = {
		issueBackend: 'kernel',
		gitCommonDir,
		kernelDatabasePath: path.join(gitCommonDir, 'forge', 'kernel.sqlite'),
	};
	return { dir, kernelDeps };
}

// readKernelSnapshot invokes its injected reader as (operation, [], projectRoot, deps).
// Fold the throwaway-DB deps in so every bucket read resolves to the seeded kernel.
function kernelReaderFor(kernelDeps) {
	return (operation, args, projectRoot, deps) =>
		runIssueOperation(operation, args, projectRoot, { ...deps, ...kernelDeps });
}

async function createIssue(dir, kernelDeps, title) {
	const created = await runIssueOperation(
		'create',
		['--title', title, '--type', 'task'],
		dir,
		kernelDeps,
	);
	expect(created.ok).toBe(true);
	return created.data.id;
}

function cleanup(dir) {
	// The builtin SQLite driver keeps the DB file open for the process lifetime, so on
	// Windows rmSync can hit EBUSY during teardown. Cleanup is not the assertion.
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore: OS reclaims the temp dir.
	}
}

const baseContext = {
	branch: 'feat/status-kernel',
	inWorktree: true,
	worktreePath: '/repo/.worktrees/status-kernel',
	mainWorktree: '/repo',
	workingTree: { clean: true, summary: 'clean' },
};

describe('readKernelSnapshot — the flagship status snapshot reads the Kernel', () => {
	test('populates ready from a kernel that holds ready issues (bug 40f35797)', async () => {
		const { dir, kernelDeps } = makeKernelRepo();
		try {
			const idA = await createIssue(dir, kernelDeps, 'Kernel ready one');
			const idB = await createIssue(dir, kernelDeps, 'Kernel ready two');

			const snapshot = await readKernelSnapshot(dir, {
				runIssueOperation: kernelReaderFor(kernelDeps),
				env: {},
			});

			const readyIds = snapshot.ready.map(issue => issue.id);
			expect(readyIds).toContain(idA);
			expect(readyIds).toContain(idB);
			expect(snapshot.ready.length).toBe(2);
			// The Beads-shaped bucket contract the presenter consumes must be present.
			expect(Array.isArray(snapshot.blocked)).toBe(true);
			expect(Array.isArray(snapshot.stale)).toBe(true);
			expect(Array.isArray(snapshot.recentCompleted)).toBe(true);
		} finally {
			cleanup(dir);
		}
	}, 20000);

	test('the one-glance view shows the ready count and a claim fallback, not "/plan"', async () => {
		const { dir, kernelDeps } = makeKernelRepo();
		try {
			const idA = await createIssue(dir, kernelDeps, 'Top ready');
			const idB = await createIssue(dir, kernelDeps, 'Second ready');

			const snapshot = await readKernelSnapshot(dir, {
				runIssueOperation: kernelReaderFor(kernelDeps),
				env: {},
			});
			const out = formatZeroArgStatus({ context: baseContext, snapshot, workflowResult: null });

			expect(out).toContain('Ready: 2 more (forge issue ready)');
			// State-aware fallback points at the TOP ready issue — never the empty-state /plan dead end.
			const topReadyId = snapshot.ready[0].id;
			expect([idA, idB]).toContain(topReadyId);
			expect(out).toContain(`forge claim ${topReadyId}`);
			expect(out).not.toContain('no ready issues. Next: /plan');
		} finally {
			cleanup(dir);
		}
	}, 20000);
});

describe('readKernelSnapshot — parked (backlog) work is a visible bucket', () => {
	test('surfaces parked issues in a dedicated bucket, out of ready', async () => {
		const { dir, kernelDeps } = makeKernelRepo();
		try {
			const readyId = await createIssue(dir, kernelDeps, 'Active work');
			const parkedId = await createIssue(dir, kernelDeps, 'Parked idea');
			// open -> backlog is a legal move; park the second issue.
			const parked = await runIssueOperation('update', [parkedId, '--status', 'backlog'], dir, kernelDeps);
			expect(parked.ok).toBe(true);

			const snapshot = await readKernelSnapshot(dir, {
				runIssueOperation: kernelReaderFor(kernelDeps),
				env: {},
			});

			expect(Array.isArray(snapshot.parked)).toBe(true);
			const parkedIds = snapshot.parked.map(issue => issue.id);
			expect(parkedIds).toContain(parkedId);
			// Parked work must never leak into ready — it needs a promote first.
			expect(snapshot.ready.map(issue => issue.id)).not.toContain(parkedId);
			expect(snapshot.ready.map(issue => issue.id)).toContain(readyId);
		} finally {
			cleanup(dir);
		}
	}, 20000);

	test('the empty snapshot still exposes a parked bucket', async () => {
		const snapshot = await readKernelSnapshot('/repo', {
			runIssueOperation: async () => {
				throw new Error('forced hard failure');
			},
			env: {},
		});
		expect(Array.isArray(snapshot.parked)).toBe(true);
		expect(snapshot.parked).toEqual([]);
	});
});

describe('readStatusSnapshot — backend routing', () => {
	test('defaults to the Kernel reader when no backend is selected', async () => {
		const calls = [];
		const snapshot = await readStatusSnapshot('/repo', {
			env: {},
			runIssueOperation: async (operation) => {
				calls.push(operation);
				return { ok: true, data: { issues: [], count: 0 } };
			},
		});

		// It read the kernel (ready/blocked/stale/list), not the Beads jsonl file.
		expect(calls).toContain('ready');
		expect(snapshot.limits.join(' ')).toContain('Kernel');
	});
});

// Bucketing/sorting coverage ported from the deleted readBeadsSnapshot suite in
// test/status-command.test.js. The BEHAVIOUR survives the reader swap — readKernelSnapshot
// still derives activeAssigned from claims and still orders recentCompleted newest-first —
// so the assertions move to the kernel path rather than being dropped with the JSONL reader.
// (The JSONL-only cases — malformed rows, dependency-derived ready — die with it: the kernel
// returns ready/blocked as authoritative ops instead of deriving them from a file.)
describe('readKernelSnapshot — buckets and ordering', () => {
	// readKernelSnapshot reads ready/blocked/stale/list; serve each from a fixed envelope.
	function readerFor({ ready = [], blocked = [], stale = [], list = [] }) {
		const byOperation = { ready, blocked, stale, list };
		return async (operation) => ({
			ok: true,
			data: { issues: byOperation[operation] || [], count: (byOperation[operation] || []).length },
		});
	}

	test('activeAssigned keeps only open claimed issues held by the current actor', async () => {
		const snapshot = await readKernelSnapshot('/repo', {
			env: { FORGE_ACTOR: 'dev@example.com' },
			runIssueOperation: readerFor({
				list: [
					{ id: 'mine', status: 'open', claimed_by: 'dev@example.com', updated_at: '2026-07-20T10:00:00Z' },
					{ id: 'theirs', status: 'open', claimed_by: 'other@example.com', updated_at: '2026-07-20T11:00:00Z' },
					{ id: 'unclaimed', status: 'open', claimed_by: null, updated_at: '2026-07-20T12:00:00Z' },
				],
			}),
		});

		expect(snapshot.active.map(i => i.id)).toEqual(['theirs', 'mine']);
		expect(snapshot.activeAssigned.map(i => i.id)).toEqual(['mine']);
	});

	test('activeAssigned matches the actor case-insensitively', async () => {
		const snapshot = await readKernelSnapshot('/repo', {
			env: { FORGE_ACTOR: 'Dev@Example.com' },
			runIssueOperation: readerFor({
				list: [{ id: 'mine', status: 'open', claimed_by: 'dev@example.com', updated_at: '2026-07-20T10:00:00Z' }],
			}),
		});

		expect(snapshot.activeAssigned.map(i => i.id)).toEqual(['mine']);
	});

	test('recentCompleted sorts done issues by updated_at, newest first', async () => {
		const snapshot = await readKernelSnapshot('/repo', {
			env: {},
			runIssueOperation: readerFor({
				list: [
					{ id: 'older', status: 'done', updated_at: '2026-07-18T09:00:00Z' },
					{ id: 'newest', status: 'done', updated_at: '2026-07-21T09:00:00Z' },
					{ id: 'middle', status: 'done', updated_at: '2026-07-20T09:00:00Z' },
					{ id: 'still-open', status: 'open', updated_at: '2026-07-22T09:00:00Z' },
				],
			}),
		});

		expect(snapshot.recentCompleted.map(i => i.id)).toEqual(['newest', 'middle', 'older']);
	});

	test('missing and unparseable completion timestamps sort oldest, never crash', async () => {
		const snapshot = await readKernelSnapshot('/repo', {
			env: {},
			runIssueOperation: readerFor({
				list: [
					{ id: 'dated', status: 'done', updated_at: '2026-07-21T09:00:00Z' },
					{ id: 'undated', status: 'done' },
					{ id: 'garbage', status: 'done', updated_at: 'not-a-date' },
				],
			}),
		});

		expect(snapshot.recentCompleted[0].id).toBe('dated');
		expect(snapshot.recentCompleted.map(i => i.id).slice(1).sort()).toEqual(['garbage', 'undated']);
	});

	test('blocked and stale come from their kernel ops and are ordered newest-first', async () => {
		const snapshot = await readKernelSnapshot('/repo', {
			env: {},
			runIssueOperation: readerFor({
				blocked: [
					{ id: 'blocked-old', status: 'open', updated_at: '2026-07-10T09:00:00Z' },
					{ id: 'blocked-new', status: 'open', updated_at: '2026-07-19T09:00:00Z' },
				],
				stale: [{ id: 'stale-one', status: 'open', updated_at: '2026-06-01T09:00:00Z' }],
			}),
		});

		expect(snapshot.blocked.map(i => i.id)).toEqual(['blocked-new', 'blocked-old']);
		expect(snapshot.stale.map(i => i.id)).toEqual(['stale-one']);
	});

	test('a failing bucket read degrades to empty instead of blanking the whole snapshot', async () => {
		const snapshot = await readKernelSnapshot('/repo', {
			env: {},
			runIssueOperation: async (operation) => {
				if (operation === 'blocked') throw new Error('kernel read failed');
				return { ok: true, data: { issues: [{ id: 'r1', status: 'open' }], count: 1 } };
			},
		});

		expect(snapshot.blocked).toEqual([]);
		expect(snapshot.ready.map(i => i.id)).toEqual(['r1']);
	});
});
