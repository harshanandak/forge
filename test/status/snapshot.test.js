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
