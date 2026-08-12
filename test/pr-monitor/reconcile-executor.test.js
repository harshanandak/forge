'use strict';

const { describe, test, expect } = require('bun:test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const executor = require('../../lib/pr-monitor/reconcile-executor');
const shepherdLease = require('../../lib/pr-monitor/shepherd-lease');
const FOREIGN_LEASE_CHILD_EXIT_TIMEOUT_MS = 5000;

function tmpRepo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws4b-exec-'));
	return dir;
}

test('claim markers share one path across worktrees with the same common dir', () => {
	const base = tmpRepo();
	const gitCommonDir = path.join(base, 'main', '.git');
	const mainRoot = path.join(base, 'main');
	const worktreeRoot = path.join(base, 'feature');
	executor.writeClaimMarker(mainRoot, 'forge', 42, 'stamp', gitCommonDir);
	expect(executor.readClaimMarker(worktreeRoot, 'forge', 42, gitCommonDir)).toBe('stamp');
	const kills = [];
	expect(executor.verifiedKill(
		{ repo: 'forge', pr: 42, pid: 1234, startedAt: 'stamp' },
		{
			projectRoot: worktreeRoot,
			gitCommonDir,
			isAlive: () => true,
			kill: (pid) => kills.push(pid),
		},
	)).toBe(true);
	expect(kills).toEqual([1234]);
	fs.rmSync(base, { recursive: true, force: true });
});

describe('execute — watcher lifecycle', () => {
	test('rejects non-array actions with a distinct validation code', async () => {
		await expect(executor.execute(null)).rejects.toMatchObject({ code: 'INVALID_ACTIONS' });
	});
	test('processes oversized action sets in bounded resumable batches', async () => {
		let writes = 0;
		const diagnostics = [];
		const actions = Array.from({ length: 130 }, (_, index) => ({
			type: 'upsertPrRow', row: { number: index + 1 },
		}));
		await executor.execute(actions, {
			broker: { upsertPr: async () => { writes += 1; return true; } },
			watchers: [],
			recordDiagnostic: entry => diagnostics.push(entry),
		});
		expect(writes).toBe(128);
		expect(diagnostics).toContainEqual(expect.objectContaining({
			kind: 'actions-truncated', requested: 130, processed: 128,
		}));
	});
	test('persists and replays the public Flow process lifecycle across daemon restarts', async () => {
		const first = await executor.execute(
			[{ type: 'startWatcher', pr: { repo: 'forge', number: 42 } }],
			{
				projectRoot: '/repo', gitCommonDir: '/repo/.git', now: () => 1000,
				spawnWatcher: () => ({ pid: 1234 }), writeClaim: () => {}, watchers: [],
			},
		);
		expect(first[0].lifecycle.state).toMatchObject({ phase: 'RUNNING', attempts: 1 });

		const restarted = await executor.execute([], {
			projectRoot: '/repo', gitCommonDir: '/repo/.git', now: () => 2000, watchers: first,
		});
		expect(restarted).toEqual(first);
	});

	test('fails closed before process mutation when a persisted lifecycle checkpoint conflicts', async () => {
		let killed = false;
		await expect(executor.execute(
			[{ type: 'stopWatcher', pr: { number: 5 } }],
			{
				projectRoot: '/repo', gitCommonDir: '/repo/.git', now: () => 2000,
				watchers: [{
					pr: 5, repo: 'forge', pid: 999, startedAt: '1970-01-01T00:00:01.000Z',
					lifecycle: { processId: 'watcher:forge:5:999', events: [{ id: 'bad', type: 'exit', at: 1000, code: 0 }] },
				}],
				isAlive: () => true, readClaim: () => '1970-01-01T00:00:01.000Z', kill: () => { killed = true; },
			},
		)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
		expect(killed).toBe(false);
	});

	test('records cancellation acknowledgement and terminal reap before cleanup', async () => {
		const checkpoints = [];
		const cancelling = await executor.execute(
			[{ type: 'stopWatcher', pr: { number: 5 } }],
			{
				projectRoot: '/repo', gitCommonDir: '/repo/.git', now: () => 2000,
				watchers: [{ pr: 5, repo: 'forge', pid: 999, startedAt: '1970-01-01T00:00:01.000Z' }],
				isAlive: () => true, readClaim: () => '1970-01-01T00:00:01.000Z', kill: () => {},
				removeClaim: () => {}, onLifecycleCheckpoint: checkpoint => checkpoints.push(checkpoint),
			},
		);
		expect(cancelling[0].lifecycle.state.phase).toBe('CANCEL_REQUESTED');
		const watchers = await executor.execute(
			[{ type: 'stopWatcher', pr: { number: 5 } }],
			{
				projectRoot: '/repo', gitCommonDir: '/repo/.git', now: () => 2001,
				watchers: cancelling, isAlive: () => false, removeClaim: () => {},
				onLifecycleCheckpoint: checkpoint => checkpoints.push(checkpoint),
			},
		);
		expect(watchers).toEqual([]);
		expect(checkpoints.at(-1).state).toMatchObject({
			phase: 'TERMINAL', status: 'CANCELLED', terminationAcknowledged: true, childReaped: true,
		});
	});

	test('resumes a persisted termination acknowledgement by reaping the dead watcher', async () => {
		const checkpoints = [];
		const cancelling = await executor.execute(
			[{ type: 'stopWatcher', pr: { number: 5 } }],
			{
				projectRoot: '/repo', gitCommonDir: '/repo/.git', now: () => 2000,
				watchers: [{ pr: 5, repo: 'forge', pid: 999, startedAt: '1970-01-01T00:00:01.000Z' }],
				isAlive: () => true, readClaim: () => '1970-01-01T00:00:01.000Z', kill: () => {},
				removeClaim: () => {},
				onLifecycleCheckpoint: checkpoint => checkpoints.push(checkpoint),
			},
		);
		await executor.execute(
			[{ type: 'stopWatcher', pr: { number: 5 } }],
			{
				projectRoot: '/repo', gitCommonDir: '/repo/.git', now: () => 2001,
				watchers: cancelling, isAlive: () => false, removeClaim: () => {},
				onLifecycleCheckpoint: checkpoint => checkpoints.push(checkpoint),
			},
		);
		const acknowledged = checkpoints.find(checkpoint => checkpoint.state.phase === 'TERMINATION_ACKNOWLEDGED');
		expect(acknowledged).toBeDefined();
		const resumed = await executor.execute(
			[{ type: 'stopWatcher', pr: { number: 5 } }],
			{
				projectRoot: '/repo', gitCommonDir: '/repo/.git', now: () => 2002,
				watchers: [{
					pr: 5, repo: 'forge', pid: 999, startedAt: '1970-01-01T00:00:01.000Z', lifecycle: acknowledged,
				}],
				isAlive: () => false, removeClaim: () => {},
			},
		);
		expect(resumed).toEqual([]);
	});

	test('terminates a newly spawned watcher when its authority checkpoint fails', async () => {
		let writes = 0;
		const killed = [];
		await expect(executor.execute(
			[{ type: 'startWatcher', pr: { repo: 'forge', number: 42 } }],
			{
				projectRoot: '/repo', gitCommonDir: '/repo/.git', now: () => 1000, watchers: [],
				spawnWatcher: () => ({ pid: 1234 }),
				persistLifecycleCheckpoint: () => { writes += 1; return writes === 1; },
				writeClaim: () => {}, readClaim: () => '1970-01-01T00:00:01.000Z',
				isAlive: () => true, kill: (pid, signal) => killed.push([pid, signal]),
			},
		)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
		expect(killed).toEqual([[1234, 'SIGKILL']]);
	});

	test('terminates every watcher spawned earlier in a batch when a later checkpoint fails', async () => {
		let writes = 0;
		let nextPid = 1000;
		const killed = [];
		await expect(executor.execute([
			{ type: 'startWatcher', pr: { repo: 'forge', number: 41 } },
			{ type: 'startWatcher', pr: { repo: 'forge', number: 42 } },
		], {
			projectRoot: '/repo', gitCommonDir: '/repo/.git', now: () => 1000, watchers: [],
			spawnWatcher: () => ({ pid: nextPid++ }),
			persistLifecycleCheckpoint: () => { writes += 1; return writes < 4; },
			writeClaim: () => {}, removeClaim: () => {}, readClaim: () => '1970-01-01T00:00:01.000Z',
			isAlive: () => true, kill: (pid, signal) => killed.push([pid, signal]),
		})).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });

		expect(killed.sort((a, b) => a[0] - b[0])).toEqual([
			[1000, 'SIGKILL'], [1001, 'SIGKILL'],
		]);
	});

	test('force-kills only after cancellation grace expires and reaps after acknowledgement', async () => {
		const signals = [];
		const cancelling = await executor.execute(
			[{ type: 'stopWatcher', pr: { number: 5 } }],
			{
				projectRoot: '/repo', gitCommonDir: '/repo/.git', now: () => 2000,
				watchers: [{ pr: 5, repo: 'forge', pid: 999, startedAt: '1970-01-01T00:00:01.000Z' }],
				isAlive: () => true, readClaim: () => '1970-01-01T00:00:01.000Z',
				kill: (_pid, signal) => signals.push(signal),
			},
		);
		const forced = await executor.execute(
			[{ type: 'stopWatcher', pr: { number: 5 } }],
			{
				projectRoot: '/repo', gitCommonDir: '/repo/.git', now: () => 32000,
				watchers: cancelling, isAlive: () => true,
				readClaim: () => '1970-01-01T00:00:01.000Z', kill: (_pid, signal) => signals.push(signal),
			},
		);
		expect(signals).toEqual([undefined, 'SIGKILL']);
		expect(forced[0].lifecycle.state.phase).toBe('FORCE_KILL_REQUESTED');

		const reaped = await executor.execute(
			[{ type: 'stopWatcher', pr: { number: 5 } }],
			{ projectRoot: '/repo', gitCommonDir: '/repo/.git', now: () => 32001, watchers: forced, isAlive: () => false },
		);
		expect(reaped).toEqual([]);
	});

	test('provider loss fails closed before terminating a watcher', async () => {
		let killed = false;
		await expect(executor.execute(
			[{ type: 'stopWatcher', pr: { number: 5 } }],
			{
				projectRoot: '/repo', gitCommonDir: '/repo/.git', now: () => 2000,
				watchers: [{ pr: 5, repo: 'forge', pid: 999, startedAt: '1970-01-01T00:00:01.000Z' }],
				persistLifecycleCheckpoint: () => false,
				isAlive: () => true, readClaim: () => '1970-01-01T00:00:01.000Z', kill: () => { killed = true; },
			},
		)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
		expect(killed).toBe(false);
	});
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
		expect(watchers[0]).toMatchObject({ pr: 42, repo: 'forge', pid: 1234, startedAt: '2026-07-20T00:00:00.000Z' });
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

	test('a live orphan escalates to SIGKILL after its grace deadline and is reaped after exit', async () => {
		const kills = [];
		const action = [{ type: 'reapOrphan', pid: 999, startedAt: 't1' }];
		const common = {
			projectRoot: '/repo', readClaim: () => 't1',
			kill: (pid, signal) => kills.push([pid, signal || 'SIGTERM']), broker: {},
		};
		let watchers = await executor.execute(action, {
			...common, watchers: [{ ...baseEntry }], now: () => 1_000, isAlive: () => true,
		});
		watchers = await executor.execute(action, {
			...common, watchers, now: () => 31_001, isAlive: () => true,
		});
		watchers = await executor.execute(action, {
			...common, watchers, now: () => 31_002, isAlive: () => false,
		});

		expect(kills).toEqual([[999, 'SIGTERM'], [999, 'SIGKILL']]);
		expect(watchers).toEqual([]);
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
		let exited = false;
		const res = await executor.runDaemon('/repo', {
			gitCommonDir: '/repo/.git',
			acquire: () => ({ ok: false, held: { pid: 4242 } }),
			startHeartbeat: () => { heartbeatStarted = true; return {}; },
			exit: (code) => { exited = code === 0; },
			once: true,
			gatherDesired: async () => { converged = true; return { openPrs: [], gitCommonDir: '/repo/.git' }; },
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toBe('foreign-lease');
		expect(heartbeatStarted).toBe(false);
		expect(converged).toBe(false);
		expect(exited).toBe(true);
	});

	test('acquire winner with no open PRs → converges once then self-retires (release + stopHeartbeat)', async () => {
		let released = false;
		let heartbeatStopped = false;
		const diagnostics = [];
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
			recordDiagnostic: (entry) => diagnostics.push(entry),
		});
		expect(res.ok).toBe(true);
		expect(released).toBe(true);
		expect(heartbeatStopped).toBe(true);
		expect(diagnostics.some((entry) => entry.kind === 'retired-no-open-prs')).toBe(true);
	});

	test('real isolated lease is removed after no-open self-retirement', async () => {
		const gitCommonDir = tmpRepo();
		await executor.runDaemon(gitCommonDir, {
			gitCommonDir,
			once: true,
			broker: { listOpenPrs: async () => [] },
			gatherDesired: async () => ({ openPrs: [], gitCommonDir }),
			gatherObserved: async () => ({
				lease: null, leaseFresh: false, prRows: [], liveWatcherPids: [],
			}),
		});
		expect(fs.existsSync(shepherdLease.lockFilePath(gitCommonDir, { gitCommonDir }))).toBe(false);
		fs.rmSync(gitCommonDir, { recursive: true, force: true });
	});

	test('foreign-lease loser exits even when another ref-ed handle would keep Bun alive', async () => {
		const modulePath = path.join(__dirname, '..', '..', 'lib', 'pr-monitor', 'reconcile-executor.js');
		const script = [
			`const { runDaemon } = require(${JSON.stringify(modulePath)});`,
			'setInterval(() => {}, 1000);',
			"runDaemon('/repo', { gitCommonDir: '/repo/.git', acquire: () => ({ ok: false }) });",
		].join('\n');
		const child = spawn(process.execPath, ['-e', script], {
			windowsHide: true,
			stdio: 'ignore',
		});
		const result = await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				try { child.kill(); } catch { /* best effort */ }
				child.unref?.();
				reject(new Error(`foreign-lease loser child did not exit within ${FOREIGN_LEASE_CHILD_EXIT_TIMEOUT_MS}ms`));
			}, FOREIGN_LEASE_CHILD_EXIT_TIMEOUT_MS);
			child.once('error', (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			child.once('exit', (status, signal) => {
				clearTimeout(timeout);
				resolve({ status, signal });
			});
		});
		expect(result.status).toBe(0);
	});

	test('a failed converge pass records its failure and leaves the cadence alive for retry', async () => {
		const diagnostics = [];
		const res = await executor.runDaemon('/repo', {
			gitCommonDir: '/repo/.git',
			acquire: () => ({ ok: true, token: 'tok' }),
			startHeartbeat: () => null,
			stopHeartbeat: () => {},
			release: () => {},
			buildBroker: async () => { throw new Error('kernel unavailable'); },
			convergeOnce: async () => { throw new Error('gh unavailable'); },
			recordDiagnostic: (entry) => diagnostics.push(entry),
			exit: false,
			intervalMs: 60000,
		});
		clearInterval(res.timer);
		expect(diagnostics).toContainEqual(expect.objectContaining({
			kind: 'converge-failed',
			detail: 'gh unavailable',
		}));
	});

	test('a throwing converge cannot keep the daemon alive after its lease is lost', async () => {
		let owned = true;
		let passes = 0;
		let exited = false;
		const diagnostics = [];
		const res = await executor.runDaemon('/repo', {
			gitCommonDir: '/repo/.git',
			acquire: () => ({ ok: true, token: 'tok' }),
			ownsLease: () => owned,
			startHeartbeat: () => null,
			stopHeartbeat: () => {},
			release: () => {},
			buildBroker: async () => { throw new Error('kernel unavailable'); },
			convergeOnce: async () => {
				passes += 1;
				if (passes === 2) owned = false;
				throw new Error('gh unavailable');
			},
			recordDiagnostic: (entry) => diagnostics.push(entry),
			exit: (code) => { exited = code === 0; },
			intervalMs: 10,
		});
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(passes).toBe(2);
		expect(exited).toBe(true);
		expect(diagnostics.some((entry) => entry.kind === 'lease-lost')).toBe(true);
		clearInterval(res.timer);
	});

	test('a 30s blocked listing that loses ownership exits even when listingOk is false', async () => {
		let ownershipChecks = 0;
		let clock = 0;
		let exited = false;
		const diagnostics = [];
		const res = await executor.runDaemon('/repo', {
			gitCommonDir: '/repo/.git',
			acquire: () => ({ ok: true, token: 'old-token' }),
			ownsLease: () => {
				ownershipChecks += 1;
				return ownershipChecks === 1;
			},
			startHeartbeat: () => null,
			stopHeartbeat: () => {},
			release: () => {},
			buildBroker: async () => { throw new Error('kernel unavailable'); },
			convergeOnce: async () => {
				clock += 30000;
				return {
					actions: [], watchers: [], desiredCount: null, listingOk: false,
				};
			},
			now: () => clock,
			recordDiagnostic: (entry) => diagnostics.push(entry),
			exit: (code) => { exited = code === 0; },
		});
		expect(res.retired).toBe(true);
		expect(clock).toBe(30000);
		expect(exited).toBe(true);
		expect(diagnostics.some((entry) => entry.kind === 'lease-lost')).toBe(true);
	});
});

describe('watcher marker cleanup + superseded-daemon stop', () => {
	test('stopWatcher/reapOrphan remove the start-time marker (a reused PID cannot match a stale one)', async () => {
		const removed = [];
		const cancelling = await executor.execute(
			[{ type: 'stopWatcher', pr: { number: 5 } }],
			{
				projectRoot: '/repo', now: () => 1000,
				watchers: [{ pr: 5, repo: 'forge', pid: 999, startedAt: 't1' }],
				isAlive: () => true, readClaim: () => 't1', kill: () => {},
				removeClaim: (e) => removed.push(e),
				broker: {},
			},
		);
		await executor.execute(
			[{ type: 'stopWatcher', pr: { number: 5 } }],
			{
				projectRoot: '/repo', watchers: cancelling, now: () => 2000,
				isAlive: () => false, removeClaim: (e) => removed.push(e), broker: {},
			},
		);
		expect(removed).toHaveLength(1);
		expect(removed[0].pr).toBe(5);
	});

	test('convergeOnce reports leaseLost when updateWatchers is rejected (stale/superseded token)', async () => {
		const conv = await executor.convergeOnce('/repo', {
			gitCommonDir: '/repo/.git',
			token: 'stale-tok',
			gatherDesired: async () => ({ openPrs: [{ repo: 'forge', number: 1, branch: 'b', headSha: 's', issueId: null, worktreeId: null, journalPtr: null }], gitCommonDir: '/repo/.git' }),
			gatherObserved: async () => ({ lease: null, leaseFresh: false, prRows: [], liveWatcherPids: [] }),
			broker: { upsertPr: async () => ({ ok: true }), retirePr: async () => ({ ok: true }) },
			spawnWatcher: () => ({ pid: 1 }),
			writeClaim: () => {},
			updateWatchers: () => false, // lock reclaimed by a newer daemon → publish rejected
		});
		expect(conv.leaseLost).toBe(true);
	});

	test('daemon self-exits when superseded (updateWatchers rejects its stale token)', async () => {
		let exited = false;
		let released = false;
		const diagnostics = [];
		const res = await executor.runDaemon('/repo', {
			gitCommonDir: '/repo/.git',
			acquire: () => ({ ok: true, token: 'stale' }),
			startHeartbeat: () => ({}), stopHeartbeat: () => {},
			release: () => { released = true; }, // token-guarded in prod; a no-op vs the new owner
			broker: { upsertPr: async () => ({ ok: true }), retirePr: async () => ({ ok: true }) },
			gatherDesired: async () => ({ openPrs: [{ repo: 'forge', number: 1, branch: 'b', headSha: 's', issueId: null, worktreeId: null, journalPtr: null }], gitCommonDir: '/repo/.git' }),
			gatherObserved: async () => ({ lease: null, leaseFresh: false, prRows: [], liveWatcherPids: [] }),
			spawnWatcher: () => ({ pid: 1 }),
			writeClaim: () => {}, // inject the FS seam — no real watch.startedat marker written to /repo
			updateWatchers: () => false, // superseded on the immediate converge
			exit: () => { exited = true; },
			recordDiagnostic: (entry) => diagnostics.push(entry),
		});
		expect(exited).toBe(true);
		expect(res.retired).toBe(true);
		expect(released).toBe(true); // retire ran (release is token-guarded in prod, so harmless to the new owner)
		expect(diagnostics.some((entry) => entry.kind === 'lease-lost')).toBe(true);
	});
});

describe('fireAndForget — dispatch safety + cold-tick arbitration', () => {
	test('a throwing tick is swallowed — fireAndForget never throws (dispatch-safety contract)', () => {
		expect(() => executor.fireAndForget({
			projectRoot: '/repo',
			gitCommonDir: '/repo/.git',
			env: {},
			kernelInitialized: () => true, // reach the tick so the throw-swallow is actually exercised
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
			env: {},
			kernelInitialized: () => true, // bypass the no-lazy-create guard for this arbitration test
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

	test('no kernel DB → creates NOTHING (no-lazy-create invariant; setup/init/dry-run safe)', () => {
		const repo = tmpRepo(); // fresh dir, no kernel DB
		const launches = [];
		let acquired = false;
		executor.fireAndForget({
			projectRoot: repo,
			gitCommonDir: repo,
			acquire: () => { acquired = true; return { ok: true, token: 't' }; },
			launch: (c) => launches.push(c),
			tick: ({ enumerate, execute }) => { enumerate(); execute(); },
		});
		expect(acquired).toBe(false); // never even arbitrated the lease
		expect(launches).toHaveLength(0);
		// The trigger created no shepherd state under the repo.
		expect(fs.existsSync(path.join(repo, 'forge', 'shepherd.lock'))).toBe(false);
		fs.rmSync(repo, { recursive: true, force: true });
	});

	test('dry-run → no-op even when the kernel exists', () => {
		const launches = [];
		let acquired = false;
		executor.fireAndForget({
			projectRoot: '/repo',
			gitCommonDir: '/repo/.git',
			dryRun: true,
			kernelInitialized: () => true,
			acquire: () => { acquired = true; return { ok: true, token: 't' }; },
			launch: (c) => launches.push(c),
			tick: ({ enumerate, execute }) => { enumerate(); execute(); },
		});
		expect(acquired).toBe(false);
		expect(launches).toHaveLength(0);
	});
});

// Regression for the wave-review MAJOR finding: the daemon must use a REAL
// createLocalBroker (listOpenPrs/upsertPr/retirePr are INSTANCE methods) — the broker
// MODULE namespace has none, so the kernel half would silently no-op behind the catch
// while unit tests (injecting mock brokers) stayed green. These exercise the un-mocked
// real broker so a regression to the namespace default is caught.
describe('real kernel broker wiring (no module-namespace default)', () => {
	const { createLocalBroker } = require('../../lib/kernel/broker');
	const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

	async function realBroker(dir) {
		const driver = createBuiltinSQLiteDriver({});
		const broker = createLocalBroker({ projectRoot: dir, gitCommonDir: '/gcd/.git', databasePath: path.join(dir, 'kernel.sqlite'), driver });
		await broker.initialize();
		return { broker, driver };
	}

	test('execute upsertPrRow actually writes a kernel_pr row via a real broker instance', async () => {
		const dir = tmpRepo();
		const { broker, driver } = await realBroker(dir);
		try {
			await executor.execute(
				[{ type: 'upsertPrRow', row: { git_common_dir: '/gcd/.git', repo: 'owner/a', number: 5, branch: 'feat/5', head_sha: 'sha5' } }],
				{ broker, gitCommonDir: '/gcd/.git', projectRoot: dir, watchers: [] },
			);
			const rows = await broker.listOpenPrs('/gcd/.git');
			expect(rows.some((r) => r.number === 5 && r.repo === 'owner/a')).toBe(true);
		} finally {
			driver.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('runDaemon threads its broker end-to-end: a desired PR is registered in kernel_pr', async () => {
		const dir = tmpRepo();
		const { broker, driver } = await realBroker(dir);
		try {
			const res = await executor.runDaemon(dir, {
				once: true,
				gitCommonDir: '/gcd/.git',
				acquire: () => ({ ok: true, token: 'tok' }),
				startHeartbeat: () => null, stopHeartbeat: () => {}, release: () => {},
				broker, // injected real broker → threaded through convergeArgs → execute
				gatherDesired: async () => ({ gitCommonDir: '/gcd/.git', openPrs: [{ repo: 'owner/a', number: 7, branch: 'feat/7', headSha: 'sha7', issueId: null, worktreeId: null, journalPtr: null }] }),
				gatherObserved: async () => ({ lease: null, leaseFresh: false, prRows: [], liveWatcherPids: [] }),
				spawnWatcher: () => ({ pid: 111 }),
				updateWatchers: () => {},
			});
			expect(res.ok).toBe(true);
			const rows = await broker.listOpenPrs('/gcd/.git');
			expect(rows.some((r) => r.number === 7)).toBe(true);
		} finally {
			driver.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('defaultBuildBroker returns a createLocalBroker-backed broker (instance methods present)', async () => {
		const dir = tmpRepo();
		// gitCommonDir must live UNDER the test's tmp dir — a fake absolute path like
		// '/gcd/.git' resolves to an unwritable fs-root on Linux CI (and to a real,
		// pollution-prone C:\gcd on Windows). Keep the DB inside `dir`.
		const built = await executor.defaultBuildBroker({ projectRoot: dir, gitCommonDir: path.join(dir, '.git') });
		try {
			expect(typeof built.broker.listOpenPrs).toBe('function');
			expect(typeof built.broker.upsertPr).toBe('function');
			expect(typeof built.broker.retirePr).toBe('function');
		} finally {
			if (built.driver && built.driver.close) built.driver.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('launchDaemon — capability classification + detached spawn options', () => {
	test('bg-shell capability present → launches via bg-shell (classified by capability, not name)', () => {
		const calls = [];
		const res = executor.launchDaemon({
			projectRoot: '/repo',
			harness: { hasBgShell: true, runBgShell: (argv) => calls.push(argv) },
		});
		expect(res.via).toBe('bg-shell');
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual([
			process.execPath,
			path.join(__dirname, '..', '..', 'bin', 'forge.js'),
			'shepherd',
			'daemon',
		]);
	});

	test('bg-shell adapter runs from the stable common root', () => {
		const calls = [];
		const res = executor.launchDaemon({
			projectRoot: '/repo/.worktrees/feature',
			gitCommonDir: '/repo/.git',
			harness: { hasBgShell: true, runBgShell: (argv, options) => calls.push({ argv, options }) },
		});
		expect(res.via).toBe('bg-shell');
		expect(calls).toHaveLength(1);
		expect(calls[0].options).toEqual({ cwd: '/repo' });
	});

	test('throwing bg-shell adapter falls back detached from the stable common root', () => {
		let opts = null;
		const res = executor.launchDaemon({
			projectRoot: '/repo/.worktrees/feature',
			gitCommonDir: '/repo/.git',
			harness: { hasBgShell: true, runBgShell: () => { throw new Error('host shell unavailable'); } },
			spawnProcess: (_bin, _args, spawnOpts) => {
				opts = spawnOpts;
				return { pid: 1, on: () => {}, unref: () => {} };
			},
		});
		expect(res.via).toBe('detached');
		expect(opts.cwd).toBe('/repo');
	});

	test('no bg-shell capability → detached spawn with windowsHide + unref + error listener', () => {
		let opts = null; let unrefed = false; let errorListener = false;
		const fakeChild = {
			pid: 999,
			on: (ev) => { if (ev === 'error') errorListener = true; },
			unref: () => { unrefed = true; },
		};
		const res = executor.launchDaemon({
			projectRoot: '/repo/.worktrees/feature',
			gitCommonDir: '/repo/.git',
			spawnProcess: (_bin, _args, o) => { opts = o; return fakeChild; },
		});
		expect(res.via).toBe('detached');
		expect(opts.cwd).toBe('/repo');
		expect(opts.detached).toBe(true);
		expect(opts.stdio).toBe('ignore');
		expect(opts.windowsHide).toBe(true); // containment: never flash a console
		expect(unrefed).toBe(true);          // never keep the triggering command's event loop alive
		expect(errorListener).toBe(true);    // a failed launch degrades to "not started", never throws
	});

	test('uncertain capability (empty harness) → detached fallback (fail-safe)', () => {
		let spawned = false;
		const res = executor.launchDaemon({
			projectRoot: '/repo',
			harness: {},
			spawnProcess: () => { spawned = true; return { pid: 1, on: () => {}, unref: () => {} }; },
		});
		expect(res.via).toBe('detached');
		expect(spawned).toBe(true);
	});

	test('failed detached spawn records a durable launch-failed diagnostic', () => {
		const diagnostics = [];
		const res = executor.launchDaemon({
			projectRoot: '/repo',
			gitCommonDir: '/repo/.git',
			spawnProcess: () => { throw new Error('spawn denied'); },
			recordDiagnostic: (entry) => diagnostics.push(entry),
		});
		expect(res.launched).toBe(false);
		expect(diagnostics).toContainEqual(expect.objectContaining({
			kind: 'launch-failed',
			detail: 'spawn denied',
		}));
	});
});

describe('daemon lifecycle diagnostics', () => {
	test('writes diagnostic content without moving the reconcile throttle mtime', () => {
		const gitCommonDir = tmpRepo();
		const forgeDir = path.join(gitCommonDir, 'forge');
		const sentinel = path.join(forgeDir, 'shepherd.reconcile');
		const status = path.join(forgeDir, 'shepherd.status.json');
		fs.mkdirSync(forgeDir, { recursive: true });
		fs.writeFileSync(sentinel, '');
		const fixed = new Date('2026-07-29T00:00:00.000Z');
		fs.utimesSync(sentinel, fixed, fixed);

		executor.writeDaemonDiagnostic(gitCommonDir, {
			kind: 'lease-lost',
			detail: 'token superseded',
		}, { now: () => Date.parse('2026-07-29T01:00:00.000Z'), pid: 123 });

		const written = JSON.parse(fs.readFileSync(status, 'utf8'));
		expect(written).toMatchObject({
			kind: 'lease-lost',
			detail: 'token superseded',
			pid: 123,
			at: '2026-07-29T01:00:00.000Z',
		});
		expect(fs.statSync(sentinel).mtimeMs).toBe(fixed.getTime());
		fs.rmSync(gitCommonDir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// W-S4b daemon-lifecycle review fixes (findings 1-10). Each test fails without
// its corresponding fix in reconcile-executor.js.
// ---------------------------------------------------------------------------

describe('finding 1 — a failed gh listing is a no-op, never a teardown', () => {
	test('gatherDesired reports listingOk:false when the gh call throws', async () => {
		const desired = await executor.gatherDesired('/g', {
			repo: 'forge', broker: null,
			runGh: () => { throw new Error('network/auth/rate-limit'); },
		});
		expect(desired.listingOk).toBe(false);
		expect(desired.openPrs).toEqual([]);
	});

	test('gatherDesired reports listingOk:true on a successful listing', async () => {
		const desired = await executor.gatherDesired('/g', {
			repo: 'forge', broker: null, runGh: () => '[]',
		});
		expect(desired.listingOk).toBe(true);
	});

	test('gatherDesired uses canonical owner/repo identity and carries legacy linkage forward', async () => {
		const calls = [];
		const desired = await executor.gatherDesired('/g', {
			projectRoot: '/repo',
			runGh: (args) => {
				calls.push(args);
				if (args[0] === 'repo') return JSON.stringify({ owner: { login: 'harshanandak' }, name: 'forge' });
				return JSON.stringify([{ number: 7, headRefName: 'feat/7', headRefOid: 'sha7' }]);
			},
			broker: { listOpenPrs: async () => [
				{ repo: 'forge', number: 7, head_sha: 'old-sha7', issue_id: 'ISSUE-7', worktree_id: 'WT-7' },
			] },
		});
		expect(calls.some((args) => args.join(' ') === 'repo view --json owner,name')).toBe(true);
		expect(desired.openPrs[0]).toMatchObject({
			repo: 'harshanandak/forge', issueId: 'ISSUE-7', worktreeId: 'WT-7',
		});
	});

	test('gatherDesired fails closed when the GitHub repository identity is malformed or unreadable', async () => {
		for (const repoResponse of [
			JSON.stringify({ owner: { login: 'bad owner' }, name: 'forge' }),
			JSON.stringify({ owner: { login: 123 }, name: 'forge' }),
			JSON.stringify({ owner: { login: 'harshanandak' }, name: ['forge'] }),
			() => { throw new Error('gh unavailable'); },
		]) {
			const desired = await executor.gatherDesired('/g', {
				projectRoot: '/repo',
				runGh: (args) => {
					if (args[0] === 'repo') return typeof repoResponse === 'function' ? repoResponse() : repoResponse;
					return JSON.stringify([{ number: 7, headRefName: 'feat/7', headRefOid: 'sha7' }]);
				},
			});
			expect(desired.listingOk).toBe(false);
			expect(desired.openPrs).toEqual([]);
		}
	});

	test('gatherDesired does not alias cross-repository or ambiguous basename rows', async () => {
		const desired = await executor.gatherDesired('/g', {
			projectRoot: '/repo',
			runGh: (args) => args[0] === 'repo'
				? JSON.stringify({ owner: { login: 'harshanandak' }, name: 'forge' })
				: JSON.stringify([{ number: 7, headRefName: 'feat/7', headRefOid: 'sha7' }]),
			broker: { listOpenPrs: async () => [
				{ repo: 'other/forge', number: 7, head_sha: 'sha7', issue_id: 'CROSS', worktree_id: 'CROSS' },
				{ repo: 'forge', number: 7, head_sha: 'sha7', issue_id: 'LEGACY-1', worktree_id: 'WT-1' },
				{ repo: 'forge', number: 7, head_sha: 'sha7', issue_id: 'LEGACY-2', worktree_id: 'WT-2' },
			] },
		});
		expect(desired.listingOk).toBe(false);
		expect(desired.openPrs).toEqual([]);
	});

	test('convergeOnce rewrites a legacy row under canonical repo while preserving its issue link', async () => {
		const row = { repo: 'forge', number: 7, head_sha: 'old-sha7', issue_id: 'ISSUE-7', worktree_id: 'WT-7', state: 'open' };
		const upserts = [];
		const retires = [];
		const conv = await executor.convergeOnce('/repo', {
			gitCommonDir: '/g',
			runGh: (args) => args[0] === 'repo'
				? JSON.stringify({ owner: { login: 'harshanandak' }, name: 'forge' })
				: JSON.stringify([{ number: 7, headRefName: 'feat/7', headRefOid: 'new-sha7' }]),
			broker: {
				listOpenPrs: async () => [row],
				upsertPr: async (value) => { upserts.push(value); },
				retirePr: async (value) => { retires.push(value); },
			},
			gatherObserved: async () => ({ lease: null, leaseFresh: false, prRows: [row], liveWatcherPids: [] }),
			spawnWatcher: () => ({ pid: 17 }),
			writeClaim: () => {},
		});
		expect(conv.actions).toContainEqual(expect.objectContaining({
			type: 'upsertPrRow',
			row: expect.objectContaining({ repo: 'harshanandak/forge', issue_id: 'ISSUE-7', worktree_id: 'WT-7' }),
		}));
		expect(conv.actions).toContainEqual({ type: 'retire', pr: { repo: 'forge', number: 7 } });
		expect(upserts[0]).toMatchObject({ repo: 'harshanandak/forge', issue_id: 'ISSUE-7' });
		expect(retires[0]).toMatchObject({ repo: 'forge', number: 7 });
	});

	test('convergeOnce self-heals a canonical plus matching legacy row and retires only the legacy row', async () => {
		const rows = [
			{ repo: 'harshanandak/forge', number: 7, head_sha: 'new-sha7', issue_id: null, worktree_id: null, journal_ptr: null, state: 'open' },
			{ repo: 'forge', number: 7, head_sha: 'old-sha7', issue_id: 'ISSUE-7', worktree_id: 'WT-7', journal_ptr: 'JOURNAL-7', state: 'open' },
		];
		const upserts = [];
		const retires = [];
		const conv = await executor.convergeOnce('/repo', {
			gitCommonDir: '/g',
			runGh: (args) => args[0] === 'repo'
				? JSON.stringify({ owner: { login: 'harshanandak' }, name: 'forge' })
				: JSON.stringify([{ number: 7, headRefName: 'feat/7', headRefOid: 'new-sha7' }]),
			broker: {
				listOpenPrs: async () => rows,
				upsertPr: async (value) => { upserts.push(value); },
				retirePr: async (value) => { retires.push(value); },
			},
			gatherObserved: async () => ({ lease: null, leaseFresh: false, prRows: rows, liveWatcherPids: [] }),
			spawnWatcher: () => ({ pid: 17 }),
			writeClaim: () => {},
		});
		expect(conv.actions).toContainEqual(expect.objectContaining({
			type: 'upsertPrRow',
			row: expect.objectContaining({
				repo: 'harshanandak/forge',
				issue_id: 'ISSUE-7',
				worktree_id: 'WT-7',
				journal_ptr: 'JOURNAL-7',
			}),
		}));
		expect(conv.actions).toContainEqual({ type: 'retire', pr: { repo: 'forge', number: 7 } });
		expect(upserts).toContainEqual(expect.objectContaining({
			repo: 'harshanandak/forge',
			issue_id: 'ISSUE-7',
			worktree_id: 'WT-7',
			journal_ptr: 'JOURNAL-7',
		}));
		expect(retires).toEqual([{ git_common_dir: '/g', repo: 'forge', number: 7 }]);
	});

	test('convergeOnce does not retire the legacy row when canonical upsert fails', async () => {
		const rows = [
			{ repo: 'harshanandak/forge', number: 7, head_sha: 'new-sha7', issue_id: null, worktree_id: null, journal_ptr: null, state: 'open' },
			{ repo: 'forge', number: 7, head_sha: 'old-sha7', issue_id: 'ISSUE-7', worktree_id: 'WT-7', journal_ptr: 'JOURNAL-7', state: 'open' },
		];
		const retires = [];
		const conv = await executor.convergeOnce('/repo', {
			gitCommonDir: '/g',
			runGh: (args) => args[0] === 'repo'
				? JSON.stringify({ owner: { login: 'harshanandak' }, name: 'forge' })
				: JSON.stringify([{ number: 7, headRefName: 'feat/7', headRefOid: 'new-sha7' }]),
			broker: {
				listOpenPrs: async () => rows,
				upsertPr: async () => { throw new Error('canonical write failed'); },
				retirePr: async (value) => { retires.push(value); },
			},
			gatherObserved: async () => ({ lease: null, leaseFresh: false, prRows: rows, liveWatcherPids: [] }),
			spawnWatcher: () => ({ pid: 17 }),
			writeClaim: () => {},
		});
		expect(conv.actions).toContainEqual(expect.objectContaining({ type: 'upsertPrRow' }));
		expect(conv.actions).toContainEqual({ type: 'retire', pr: { repo: 'forge', number: 7 } });
		expect(retires).toEqual([]);
	});

	test('execute treats an explicit false upsert result as a failed dependency', async () => {
		const retires = [];
		await executor.execute([
			{ type: 'upsertPrRow', row: { repo: 'harshanandak/forge', number: 7 } },
			{ type: 'retire', pr: { repo: 'forge', number: 7 } },
		], {
			broker: {
				upsertPr: async () => false,
				retirePr: async (value) => { retires.push(value); },
			},
		});
		expect(retires).toEqual([]);
	});

	test('convergeOnce fails closed when canonical and legacy rows have conflicting linkage', async () => {
		for (const field of ['issue_id', 'worktree_id', 'journal_ptr']) {
			let observed = false;
			let writes = 0;
			const rows = [
				{ repo: 'harshanandak/forge', number: 7, head_sha: 'new-sha7', [field]: `${field}-CANONICAL`, state: 'open' },
				{ repo: 'forge', number: 7, head_sha: 'old-sha7', [field]: `${field}-LEGACY`, state: 'open' },
			];
			const conv = await executor.convergeOnce('/repo', {
				gitCommonDir: '/g',
				runGh: (args) => args[0] === 'repo'
					? JSON.stringify({ owner: { login: 'harshanandak' }, name: 'forge' })
					: JSON.stringify([{ number: 7, headRefName: 'feat/7', headRefOid: 'new-sha7' }]),
				broker: {
					listOpenPrs: async () => rows,
					upsertPr: async () => { writes += 1; },
					retirePr: async () => { writes += 1; },
				},
				gatherObserved: async () => { observed = true; return { lease: null, leaseFresh: false, prRows: rows, liveWatcherPids: [] }; },
			});
			expect(conv.actions).toEqual([]);
			expect(conv.desiredCount).toBeNull();
			expect(observed).toBe(false);
			expect(writes).toBe(0);
		}
	});

	test('convergeOnce skips all teardown when repository identity lookup fails', async () => {
		let observed = false;
		const conv = await executor.convergeOnce('/repo', {
			gitCommonDir: '/g',
			runGh: (args) => {
				if (args[0] === 'repo') throw new Error('gh unavailable');
				return JSON.stringify([{ number: 7, headRefName: 'feat/7', headRefOid: 'sha7' }]);
			},
			gatherObserved: async () => { observed = true; return { lease: null, leaseFresh: false, prRows: [{ repo: 'forge', number: 7, state: 'open' }], liveWatcherPids: [] }; },
		});
		expect(conv.actions).toEqual([]);
		expect(observed).toBe(false);
		expect(conv.desiredCount).toBeNull();
	});

	test('convergeOnce fails closed on a cross-owner row for an open PR number', async () => {
		let observed = false;
		let writes = 0;
		const crossOwner = { repo: 'other/forge', number: 7, head_sha: 'sha7', state: 'open' };
		const conv = await executor.convergeOnce('/repo', {
			gitCommonDir: '/g',
			runGh: (args) => args[0] === 'repo'
				? JSON.stringify({ owner: { login: 'harshanandak' }, name: 'forge' })
				: JSON.stringify([{ number: 7, headRefName: 'feat/7', headRefOid: 'sha7' }]),
			broker: {
				listOpenPrs: async () => [crossOwner],
				upsertPr: async () => { writes += 1; },
				retirePr: async () => { writes += 1; },
			},
			gatherObserved: async () => { observed = true; return { lease: null, leaseFresh: false, prRows: [crossOwner], liveWatcherPids: [] }; },
		});
		expect(conv.actions).toEqual([]);
		expect(conv.desiredCount).toBeNull();
		expect(observed).toBe(false);
		expect(writes).toBe(0);
	});

	test('convergeOnce fails closed on duplicate legacy rows for an open PR number', async () => {
		let observed = false;
		let writes = 0;
		const legacyRows = [
			{ repo: 'forge', number: 7, head_sha: 'sha7', issue_id: 'ISSUE-1', state: 'open' },
			{ repo: 'forge', number: 7, head_sha: 'sha7', issue_id: 'ISSUE-2', state: 'open' },
		];
		const conv = await executor.convergeOnce('/repo', {
			gitCommonDir: '/g',
			runGh: (args) => args[0] === 'repo'
				? JSON.stringify({ owner: { login: 'harshanandak' }, name: 'forge' })
				: JSON.stringify([{ number: 7, headRefName: 'feat/7', headRefOid: 'sha7' }]),
			broker: {
				listOpenPrs: async () => legacyRows,
				upsertPr: async () => { writes += 1; },
				retirePr: async () => { writes += 1; },
			},
			gatherObserved: async () => { observed = true; return { lease: null, leaseFresh: false, prRows: legacyRows, liveWatcherPids: [] }; },
		});
		expect(conv.actions).toEqual([]);
		expect(conv.desiredCount).toBeNull();
		expect(observed).toBe(false);
		expect(writes).toBe(0);
	});

	test('convergeOnce SKIPS reconcile+execute when listingOk===false (zero retire/stop, no observe)', async () => {
		let observed = false;
		const conv = await executor.convergeOnce('/repo', {
			gitCommonDir: '/g',
			repo: 'forge',
			now: () => 1000,
			gatherDesired: async () => ({ openPrs: [], gitCommonDir: '/g', listingOk: false }),
			gatherObserved: async () => { observed = true; return { lease: null, leaseFresh: false, prRows: [], liveWatcherPids: [] }; },
			broker: { upsertPr: async () => ({}), retirePr: async () => ({}) },
			spawnWatcher: () => ({ pid: 1 }),
			writeClaim: () => {},
		});
		expect(conv.actions).toEqual([]);
		expect(conv.actions.some((a) => a.type === 'retire' || a.type === 'stopWatcher')).toBe(false);
		expect(observed).toBe(false); // early return — no observe, no reconcile, no execute
		expect(conv.desiredCount).not.toBe(0); // must not look like "no PRs" (would trigger self-retire)
	});
});

describe('finding 2 — daemon threads the live watcher set across converge passes', () => {
	test('runDaemon feeds pass N\'s returned watchers into pass N+1\'s lock (not a fresh lease:null each tick)', async () => {
		const locksSeen = [];
		// Inject convergeOnce to capture the lock the daemon threads in per pass, and
		// echo a started watcher so a later pass should observe it as the live set.
		const converge = async (_root, o) => {
			locksSeen.push(o.lock ? o.lock.watchers : null);
			return { actions: [], watchers: [{ pr: 5, repo: 'forge', pid: 111, startedAt: 't' }], desiredCount: 1 };
		};
		const res = await executor.runDaemon('/repo', {
			gitCommonDir: '/g',
			intervalMs: 5,
			acquire: () => ({ ok: true, token: 't' }),
			startHeartbeat: () => ({}), stopHeartbeat: () => {}, release: () => {},
			exit: () => {},
			convergeOnce: converge,
		});
		await new Promise((r) => setTimeout(r, 40));
		if (res && res.timer) clearInterval(res.timer);
		expect(locksSeen.length).toBeGreaterThanOrEqual(2); // immediate pass + ≥1 interval tick
		expect(locksSeen[0]).toEqual([]);                    // cold start: empty threaded set
		// A later pass MUST see the watcher the prior pass returned — without threading
		// the daemon would pass a null/empty lock every tick (lease:null → re-start forever).
		expect(locksSeen.some((w) => Array.isArray(w) && w.some((x) => x.pid === 111))).toBe(true);
	});
});

describe('finding 3 — the non-once daemon converges immediately on cold start', () => {
	test('runDaemon invokes convergeOnce once before the interval fires', async () => {
		let calls = 0;
		const res = await executor.runDaemon('/repo', {
			gitCommonDir: '/g',
			intervalMs: 100000, // far larger than the test window: only the immediate pass can run
			acquire: () => ({ ok: true, token: 't' }),
			startHeartbeat: () => ({}), stopHeartbeat: () => {}, release: () => {},
			exit: () => {},
			convergeOnce: async () => { calls += 1; return { actions: [], watchers: [], desiredCount: 1 }; },
		});
		expect(calls).toBe(1);
		if (res && res.timer) clearInterval(res.timer);
	});
});

describe('finding 4 — retire never strands an un-exited zombie on release failure', () => {
	test('release throws during retire → the daemon still calls exit', async () => {
		let exited = null;
		const res = await executor.runDaemon('/repo', {
			gitCommonDir: '/g',
			intervalMs: 100000,
			acquire: () => ({ ok: true, token: 't' }),
			startHeartbeat: () => ({}), stopHeartbeat: () => {},
			release: () => { throw new Error('release boom'); },
			exit: (code) => { exited = code; },
			convergeOnce: async () => ({ actions: [], watchers: [], desiredCount: 0 }),
		});
		expect(exited).toBe(0);
		if (res && res.timer) clearInterval(res.timer);
	});
});

describe('daemon retirement waits for watcher termination', () => {
	test('no desired PRs does not retire while a cancellation-requested watcher is retained', async () => {
		let released = false;
		let exited = false;
		const watcher = {
			pr: 5, repo: 'forge', pid: 999, startedAt: '1970-01-01T00:00:01.000Z',
			lifecycle: { state: { phase: 'CANCEL_REQUESTED', terminal: false } },
		};
		const res = await executor.runDaemon('/repo', {
			gitCommonDir: '/g', intervalMs: 100000,
			acquire: () => ({ ok: true, token: 't' }),
			startHeartbeat: () => ({}), stopHeartbeat: () => {},
			release: () => { released = true; },
			exit: () => { exited = true; },
			convergeOnce: async () => ({ actions: [], watchers: [watcher], desiredCount: 0 }),
		});

		expect(res.retired).not.toBe(true);
		expect(released).toBe(false);
		expect(exited).toBe(false);
		clearInterval(res.timer);
	});

	test('once mode keeps the lease when cancellation is still awaiting acknowledgement', async () => {
		let released = false;
		const res = await executor.runDaemon('/repo', {
			gitCommonDir: '/g', once: true,
			acquire: () => ({ ok: true, token: 't' }),
			startHeartbeat: () => ({}), stopHeartbeat: () => {},
			release: () => { released = true; },
			convergeOnce: async () => ({
				actions: [], desiredCount: 0,
				watchers: [{ pr: 5, pid: 999, lifecycle: { state: { phase: 'CANCEL_REQUESTED', terminal: false } } }],
			}),
		});

		expect(released).toBe(false);
		expect(res.watchers).toHaveLength(1);
	});
});

describe('finding 5 — re-entrancy guard on the converge interval', () => {
	test('a slow converge → overlapping ticks never run two passes concurrently', async () => {
		let concurrent = 0; let maxConcurrent = 0; let calls = 0;
		const converge = async () => {
			calls += 1; concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent);
			await new Promise((r) => setTimeout(r, 40));
			concurrent -= 1;
			return { actions: [], watchers: [], desiredCount: 1 };
		};
		const res = await executor.runDaemon('/repo', {
			gitCommonDir: '/g',
			intervalMs: 5, // ticks fire far faster than a 40ms converge → would overlap without the guard
			acquire: () => ({ ok: true, token: 't' }),
			startHeartbeat: () => ({}), stopHeartbeat: () => {}, release: () => {},
			exit: () => {},
			convergeOnce: converge,
		});
		await new Promise((r) => setTimeout(r, 140));
		if (res && res.timer) clearInterval(res.timer);
		expect(maxConcurrent).toBe(1);
		expect(calls).toBeGreaterThan(1);
	});
});

describe('finding 6 — gatherObserved verifies the journal marker before reporting a pid live', () => {
	test('pid alive but marker mismatch → NOT live → reconcile emits startWatcher (PR stays monitored)', async () => {
		const observed = await executor.gatherObserved('/g',
			{ watchers: [{ pr: 9, repo: 'forge', pid: 999, startedAt: 't1' }], heartbeatAt: new Date().toISOString() },
			{ isAlive: () => true, readClaim: () => 't2', projectRoot: '/repo' });
		expect(observed.liveWatcherPids).toHaveLength(0);
		const { reconcile } = require('../../lib/pr-monitor/reconcile');
		const { actions } = reconcile(
			{ openPrs: [{ repo: 'forge', number: 9, branch: 'b', headSha: 's' }], gitCommonDir: '/g' },
			observed, Date.now());
		expect(actions.some((a) => a.type === 'startWatcher' && a.pr.number === 9)).toBe(true);
	});

	test('pid alive AND marker matches → reported live', async () => {
		const observed = await executor.gatherObserved('/g',
			{ watchers: [{ pr: 9, repo: 'forge', pid: 999, startedAt: 't1' }], heartbeatAt: new Date().toISOString() },
			{ isAlive: () => true, readClaim: () => 't1', projectRoot: '/repo' });
		expect(observed.liveWatcherPids).toEqual([{ pid: 999, startedAt: 't1' }]);
	});
});

describe('finding 7 — rowByNumber uses a (repo, number) composite key', () => {
	test('two kernel rows, same number, different repo → the desired PR gets ITS repo row', async () => {
		const desired = await executor.gatherDesired('/g', {
			repo: 'forge', projectRoot: '/repo',
			runGh: () => JSON.stringify([{ number: 5, headRefName: 'b', headRefOid: 'sha5' }]),
			// The correct ('forge') row is FIRST, the wrong ('other') row LAST — a
			// number-only key would let the last write win and attach 'other'. The
			// composite (repo, number) key must still pick 'forge'.
			broker: { listOpenPrs: async () => [
				{ repo: 'forge', number: 5, issue_id: 'ISSUE-FORGE', worktree_id: 'WT-FORGE' },
				{ repo: 'other', number: 5, issue_id: 'ISSUE-OTHER', worktree_id: 'WT-OTHER' },
			] },
		});
		expect(desired.openPrs).toHaveLength(1);
		expect(desired.openPrs[0].issueId).toBe('ISSUE-FORGE');
		expect(desired.openPrs[0].worktreeId).toBe('WT-FORGE');
	});
});

describe('finding 8 — fireAndForget respects the rail.auto_shepherd gate', () => {
	test('rail disabled → fully inert (no acquire, no launch)', () => {
		let acquired = false; const launches = [];
		executor.fireAndForget({
			projectRoot: '/repo', gitCommonDir: '/g',
			env: {},
			kernelInitialized: () => true, // isolate the RAIL gate — else the kernel guard short-circuits first (vacuous pass)
			railEnabled: () => false,
			acquire: () => { acquired = true; return { ok: true, token: 't' }; },
			release: () => {},
			launch: (c) => launches.push(c),
			tick: ({ enumerate, execute }) => { enumerate(); execute(); },
		});
		expect(acquired).toBe(false);
		expect(launches).toHaveLength(0);
	});

	test('rail enabled → arbitration proceeds (acquire is called)', () => {
		let acquired = false;
		executor.fireAndForget({
			projectRoot: '/repo', gitCommonDir: '/g',
			env: {},
			kernelInitialized: () => true, // isolate the RAIL gate from the kernel-exists guard
			railEnabled: () => true,
			acquire: () => { acquired = true; return { ok: false }; },
			release: () => {},
			launch: () => {},
			tick: ({ enumerate, execute }) => { enumerate(); execute(); },
		});
		expect(acquired).toBe(true);
	});
});

describe('finding 9 — execute dispatches every action type via the handler map', () => {
	test('all five action types run with identical behavior after the refactor', async () => {
		const upserts = []; const retires = []; const spawns = []; const kills = [];
		const watchers = await executor.execute([
			{ type: 'startWatcher', pr: { repo: 'forge', number: 1 } },
			{ type: 'upsertPrRow', row: { repo: 'forge', number: 1 } },
			{ type: 'reapOrphan', pid: 900, startedAt: 't9' },
			{ type: 'retire', pr: { repo: 'forge', number: 2 } },
			{ type: 'stopWatcher', pr: { number: 3 } },
		], {
			projectRoot: '/repo', repo: 'forge', gitCommonDir: '/g',
			now: () => Date.parse('2026-07-20T00:00:00.000Z'),
			watchers: [
				{ pr: 3, repo: 'forge', pid: 300, startedAt: 't3' },
				{ pr: 4, repo: 'forge', pid: 900, startedAt: 't9' },
			],
			isAlive: () => true,
			readClaim: (e) => (e.pid === 900 ? 't9' : (e.pid === 300 ? 't3' : null)),
			kill: (pid) => kills.push(pid),
			spawnWatcher: (o) => { spawns.push(o.prNumber); return { pid: 111 }; },
			writeClaim: () => {},
			broker: { upsertPr: async (r) => upserts.push(r), retirePr: async (k) => retires.push(k) },
		});
		expect(spawns).toEqual([1]);
		expect(upserts).toHaveLength(1);
		expect(retires).toHaveLength(1);
		expect(kills.slice().sort()).toEqual([300, 900]);
		expect(watchers.some((w) => w.pr === 1)).toBe(true);
		expect(watchers.find((w) => w.pr === 3).lifecycle.state.phase).toBe('CANCEL_REQUESTED');
		expect(watchers.find((w) => w.pid === 900).lifecycle.state.phase).toBe('ORPHANED');
	});
});

describe('finding 10 — gh pr list is paginated with a high --limit', () => {
	test('gatherDesired passes a --limit large enough to cover >30 open PRs', async () => {
		let argv = null;
		await executor.gatherDesired('/g', { repo: 'forge', broker: null, runGh: (a) => { argv = a; return '[]'; } });
		expect(argv).toContain('--limit');
		const i = argv.indexOf('--limit');
		expect(Number(argv[i + 1])).toBeGreaterThanOrEqual(100);
	});
});
