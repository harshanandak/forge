'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const { reconcile } = require('../../lib/pr-monitor/reconcile');

// W-S4a §1/§6: the reconciler is a PURE diff of desired (GitHub ∩ kernel) vs
// observed (kernel rows + lease watchers + live pids). Zero I/O — every case here
// is a fixture in, action-set out. `now` is injected (unused by current rules).
const NOW = 1_700_000_000_000;

function pr(number, headSha, extra = {}) {
	return { repo: 'owner/r', number, branch: `feat/${number}`, headSha, issueId: null, worktreeId: null, journalPtr: null, ...extra };
}
function kRow(number, headSha, state = 'open') {
	return { id: `x#${number}`, number, repo: 'owner/r', head_sha: headSha, state };
}

describe('reconcile() — pure diff rules', () => {
	test('new PR (D has #5, K empty, W empty) → upsertPrRow then startWatcher', () => {
		const desired = { gitCommonDir: '/r/.git', openPrs: [pr(5, 'sha5')] };
		const observed = { lease: null, leaseFresh: false, prRows: [], liveWatcherPids: [] };

		const { actions } = reconcile(desired, observed, NOW);

		expect(actions.map(a => a.type)).toEqual(['upsertPrRow', 'startWatcher']);
		expect(actions[0].row.number).toBe(5);
		expect(actions[0].row.head_sha).toBe('sha5');
		// git_common_dir is part of the kernel_pr natural key — must be carried from
		// desired so broker.upsertPr(action.row) is directly writable (Codex #426).
		expect(actions[0].row.git_common_dir).toBe('/r/.git');
		expect(actions[1].pr.number).toBe(5);
	});

	test('closed PR (D empty, K open #5, W watcher{pr:5}) → stopWatcher then retire', () => {
		const desired = { gitCommonDir: '/r/.git', openPrs: [] };
		const observed = {
			lease: { watchers: [{ pr: 5, pid: null, startedAt: null }] },
			leaseFresh: true, prRows: [kRow(5, 'sha5')], liveWatcherPids: [],
		};

		const { actions } = reconcile(desired, observed, NOW);

		expect(actions.map(a => a.type)).toEqual(['stopWatcher', 'retire']);
		expect(actions[0].pr.number).toBe(5);
		expect(actions[1].pr.number).toBe(5);
	});

	test('orphan PID (D empty, live watcher pid still claiming #5) → reapOrphan', () => {
		const desired = { gitCommonDir: '/r/.git', openPrs: [] };
		const observed = {
			lease: { watchers: [{ pr: 5, pid: 999, startedAt: 't0' }] },
			leaseFresh: true, prRows: [], liveWatcherPids: [{ pid: 999, startedAt: 't0' }],
		};

		const { actions } = reconcile(desired, observed, NOW);

		expect(actions).toContainEqual({ type: 'reapOrphan', pid: 999, startedAt: 't0' });
	});

	test('already-converged (D=K=W agree) → no actions', () => {
		const desired = { gitCommonDir: '/r/.git', openPrs: [pr(5, 'sha5')] };
		const observed = {
			lease: { watchers: [{ pr: 5, pid: 100, startedAt: 't0' }] },
			leaseFresh: true, prRows: [kRow(5, 'sha5')], liveWatcherPids: [{ pid: 100, startedAt: 't0' }],
		};

		expect(reconcile(desired, observed, NOW)).toEqual({ actions: [] });
	});

	test('head drift (D #5@shaB, K #5@shaA) → upsertPrRow with head_sha=shaB', () => {
		const desired = { gitCommonDir: '/r/.git', openPrs: [pr(5, 'shaB')] };
		const observed = {
			lease: { watchers: [{ pr: 5, pid: 100, startedAt: 't0' }] },
			leaseFresh: true, prRows: [kRow(5, 'shaA')], liveWatcherPids: [{ pid: 100, startedAt: 't0' }],
		};

		const { actions } = reconcile(desired, observed, NOW);

		const upsert = actions.find(a => a.type === 'upsertPrRow');
		expect(upsert).toBeDefined();
		expect(upsert.row.head_sha).toBe('shaB');
		expect(actions.some(a => a.type === 'startWatcher')).toBe(false);
	});

	test('legacy numeric watcher entry is never reaped (unverifiable pid)', () => {
		const desired = { gitCommonDir: '/r/.git', openPrs: [] };
		const observed = {
			lease: { watchers: [7] }, // legacy shape: bare pr number, no pid/startedAt
			leaseFresh: true, prRows: [], liveWatcherPids: [{ pid: 7, startedAt: 't0' }],
		};

		const { actions } = reconcile(desired, observed, NOW);

		expect(actions.some(a => a.type === 'reapOrphan')).toBe(false);
		expect(actions).toContainEqual({ type: 'stopWatcher', pr: { number: 7 } });
	});

	test('PURITY: twice with frozen inputs → deep-equal, inputs unmutated', () => {
		const desired = Object.freeze({ gitCommonDir: '/r/.git', openPrs: Object.freeze([Object.freeze(pr(5, 'sha5'))]) });
		const observed = Object.freeze({
			lease: Object.freeze({ watchers: Object.freeze([Object.freeze({ pr: 9, pid: 42, startedAt: 't0' })]) }),
			leaseFresh: false, prRows: Object.freeze([Object.freeze(kRow(9, 'sha9'))]),
			liveWatcherPids: Object.freeze([Object.freeze({ pid: 42, startedAt: 't0' })]),
		});

		const first = reconcile(desired, observed, NOW);
		const second = reconcile(desired, observed, NOW);
		expect(second).toEqual(first);
	});

	test('PURITY: source requires neither fs nor child_process', () => {
		const src = fs.readFileSync(require.resolve('../../lib/pr-monitor/reconcile.js'), 'utf8');
		expect(src).not.toMatch(/require\(\s*['"]node:fs['"]/);
		expect(src).not.toMatch(/require\(\s*['"]fs['"]/);
		expect(src).not.toMatch(/require\(\s*['"](node:)?child_process['"]/);
		expect(src).not.toMatch(/require\(/); // pure module: no requires at all
	});
});
