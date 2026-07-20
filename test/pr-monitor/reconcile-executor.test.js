'use strict';

const { describe, test, expect } = require('bun:test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const executor = require('../../lib/pr-monitor/reconcile-executor');
const shepherdLease = require('../../lib/pr-monitor/shepherd-lease');

function tmpRepo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws4b-exec-'));
	return dir;
}

describe('execute — watcher lifecycle', () => {
	test('startWatcher spawns a watcher and records a {pr,repo,pid,startedAt} entry + start-time marker', async () => {
		const spawned = [];
		const claims = [];
		const watchers = await executor.execute(
			[{ type: 'startWatcher', pr: { repo: 'forge', number: 42, branch: 'feat', headSha: 'sha1' } }],
			{
				projectRoot: '/repo',
				repo: 'forge',
				now: () => Date.parse('2026-07-20T00:00:00.000Z'),
				spawnWatcher: (o) => { spawned.push(o); return { started: true, pid: 1234 }; },
				writeClaim: (e) => claims.push(e),
				watchers: [],
			},
		);
		expect(spawned).toHaveLength(1);
		expect(spawned[0].prNumber).toBe(42);
		expect(watchers).toHaveLength(1);
		expect(watchers[0]).toEqual({ pr: 42, repo: 'forge', pid: 1234, startedAt: '2026-07-20T00:00:00.000Z' });
		expect(claims).toHaveLength(1);
		expect(claims[0].startedAt).toBe('2026-07-20T00:00:00.000Z');
	});

	test('hand-opened PR (kernel has no row) → upsertPrRow writes a kernel_pr row (issue/worktree null) AND a watcher starts, ZERO user invocation', async () => {
		const upserts = [];
		let spawnedPr = null;
		// Drive purely from a converge tick: reconcile sees a desired PR absent from
		// kernel and with no live watcher, so it self-registers + starts a watcher.
		const conv = await executor.convergeOnce('/repo', {
			gitCommonDir: '/repo/.git',
			repo: 'forge',
			now: () => 1000,
			gatherDesired: async () => ({
				openPrs: [{ repo: 'forge', number: 77, branch: 'hand', headSha: 'shaX', issueId: null, worktreeId: null, journalPtr: null }],
				gitCommonDir: '/repo/.git',
			}),
			gatherObserved: async () => ({ lease: null, leaseFresh: false, prRows: [], liveWatcherPids: [] }),
			broker: { upsertPr: async (row) => { upserts.push(row); return { ok: true }; }, retirePr: async () => ({ ok: true }) },
			spawnWatcher: (o) => { spawnedPr = o.prNumber; return { started: true, pid: 5 }; },
			writeClaim: () => {},
		});
		expect(upserts).toHaveLength(1);
		expect(upserts[0].number).toBe(77);
		expect(upserts[0].issue_id ?? null).toBeNull();
		expect(upserts[0].worktree_id ?? null).toBeNull();
		expect(spawnedPr).toBe(77);
		expect(conv.desiredCount).toBe(1);
	});

	test('killed watcher → next converge emits startWatcher and the executor respawns (self-healing)', async () => {
		let spawnCount = 0;
		const conv = await executor.convergeOnce('/repo', {
			gitCommonDir: '/repo/.git',
			repo: 'forge',
			now: () => 2000,
			// Desired PR #9 open; lease says a watcher existed (pid 999) but it is NOT
			// among liveWatcherPids (it was killed) → reconcile must restart it.
			gatherDesired: async () => ({
				openPrs: [{ repo: 'forge', number: 9, branch: 'b', headSha: 's', issueId: null, worktreeId: null, journalPtr: null }],
				gitCommonDir: '/repo/.git',
			}),
			gatherObserved: async () => ({
				lease: { watchers: [{ pr: 9, repo: 'forge', pid: 999, startedAt: 't' }] },
				leaseFresh: true,
				prRows: [{ repo: 'forge', number: 9, head_sha: 's', state: 'open' }],
				liveWatcherPids: [],
			}),
			broker: { upsertPr: async () => ({ ok: true }), retirePr: async () => ({ ok: true }) },
			spawnWatcher: () => { spawnCount += 1; return { started: true, pid: 111 }; },
			writeClaim: () => {},
		});
		expect(spawnCount).toBe(1);
		expect(conv.actions.some((a) => a.type === 'startWatcher' && a.pr.number === 9)).toBe(true);
	});
});

describe('verifiedKill — orphan reaping start-time re-verification (risk #4)', () => {
	const baseEntry = { pr: 5, repo: 'forge', pid: 999, startedAt: 't1' };

	test('MISMATCH: pid alive but journal marker startedAt differs → kill is NOT called', async () => {
		const kills = [];
		await executor.execute(
			[{ type: 'reapOrphan', pid: 999, startedAt: 't1' }],
			{
				projectRoot: '/repo',
				watchers: [{ ...baseEntry }],
				isAlive: () => true,
				readClaim: () => 't2', // marker says a DIFFERENT start time → PID reuse
				kill: (pid) => kills.push(pid),
				broker: {},
			},
		);
		expect(kills).toHaveLength(0);
	});

	test('MATCH: pid alive AND marker startedAt equals watcher entry → kill called exactly once', async () => {
		const kills = [];
		await executor.execute(
			[{ type: 'reapOrphan', pid: 999, startedAt: 't1' }],
			{
				projectRoot: '/repo',
				watchers: [{ ...baseEntry }],
				isAlive: () => true,
				readClaim: () => 't1', // marker matches
				kill: (pid) => kills.push(pid),
				broker: {},
			},
		);
		expect(kills).toEqual([999]);
	});

	test('legacy/null startedAt → never killed (unverifiable)', async () => {
		const kills = [];
		await executor.execute(
			[{ type: 'reapOrphan', pid: 999, startedAt: null }],
			{
				projectRoot: '/repo',
				watchers: [{ pr: 5, repo: 'forge', pid: 999, startedAt: null }],
				isAlive: () => true,
				readClaim: () => null,
				kill: (pid) => kills.push(pid),
				broker: {},
			},
		);
		expect(kills).toHaveLength(0);
	});

	test('absent marker → never killed', async () => {
		const kills = [];
		await executor.execute(
			[{ type: 'stopWatcher', pr: { number: 5 } }],
			{
				projectRoot: '/repo',
				watchers: [{ ...baseEntry }],
				isAlive: () => true,
				readClaim: () => null, // no marker on disk
				kill: (pid) => kills.push(pid),
				broker: {},
			},
		);
		expect(kills).toHaveLength(0);
	});
});

describe('runDaemon — singleton lease lifecycle', () => {
	test('acquire {ok:false} (live foreign lease) → daemon exits, spawns NOTHING, no heartbeat', async () => {
		let heartbeatStarted = false;
		let converged = false;
		const res = await executor.runDaemon('/repo', {
			gitCommonDir: '/repo/.git',
			acquire: () => ({ ok: false, held: { pid: 4242 } }),
			startHeartbeat: () => { heartbeatStarted = true; return {}; },
			once: true,
			gatherDesired: async () => { converged = true; return { openPrs: [], gitCommonDir: '/repo/.git' }; },
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toBe('foreign-lease');
		expect(heartbeatStarted).toBe(false);
		expect(converged).toBe(false);
	});

	test('acquire winner with no open PRs → converges once then self-retires (release + stopHeartbeat)', async () => {
		let released = false;
		let heartbeatStopped = false;
		const res = await executor.runDaemon('/repo', {
			gitCommonDir: '/repo/.git',
			once: true,
			acquire: () => ({ ok: true, token: 'tok-1' }),
			startHeartbeat: () => ({ id: 'hb' }),
			stopHeartbeat: () => { heartbeatStopped = true; },
			release: (_root, { token }) => { released = token === 'tok-1'; },
			gatherDesired: async () => ({ openPrs: [], gitCommonDir: '/repo/.git' }),
			gatherObserved: async () => ({ lease: null, leaseFresh: false, prRows: [], liveWatcherPids: [] }),
			broker: { upsertPr: async () => ({ ok: true }), retirePr: async () => ({ ok: true }) },
			updateWatchers: () => true,
		});
		expect(res.ok).toBe(true);
		expect(released).toBe(true);
		expect(heartbeatStopped).toBe(true);
	});
});

describe('fireAndForget — dispatch safety + cold-tick arbitration', () => {
	test('a throwing tick is swallowed — fireAndForget never throws (dispatch-safety contract)', () => {
		expect(() => executor.fireAndForget({
			projectRoot: '/repo',
			gitCommonDir: '/repo/.git',
			tick: () => { throw new Error('boom in tick'); },
		})).not.toThrow();
	});

	test('missing projectRoot → no-op, never throws', () => {
		expect(() => executor.fireAndForget({})).not.toThrow();
	});

	test('cold-tick: two concurrent triggers, one lease → only the acquire-winner launches; the loser backs off', () => {
		const repo = tmpRepo();
		const gitCommonDir = repo;
		const launches = [];
		let pidSeq = 1000;
		// Real O_EXCL lease as the atomic arbiter; distinct pids per trigger so the
		// second sees a live FOREIGN owner (same-process pid would look like "ours").
		const acquire = (root, o) => shepherdLease.acquire(root, { ...o, pid: (pidSeq += 1), isAlive: () => true });
		// Passthrough tick isolates the acquire race (bypasses G1/G2 sentinel timing).
		const passthroughTick = ({ enumerate, execute }) => {
			const { desired, observed } = enumerate();
			const { reconcile } = require('../../lib/pr-monitor/reconcile');
			const { actions } = reconcile(desired, observed, Date.now());
			execute(actions);
		};
		const ctx = {
			projectRoot: repo,
			gitCommonDir,
			acquire,
			release: () => {}, // keep the winner's lock in place so the loser truly loses
			launch: (c) => launches.push(c),
			tick: passthroughTick,
		};
		executor.fireAndForget(ctx); // winner
		executor.fireAndForget(ctx); // loser (fresh foreign lock present)

		expect(launches).toHaveLength(1);
		fs.rmSync(repo, { recursive: true, force: true });
	});
});
