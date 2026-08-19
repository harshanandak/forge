'use strict';

const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
	execute,
	gatherDesired,
	gatherObserved,
	convergeOnce,
	runDaemon,
	launchDaemon,
	writeDaemonDiagnostic,
	fireAndForget,
} = require('../../lib/pr-monitor/reconcile-executor');

const REPO = 'acme/forge';
const NOW = '2026-08-19T00:00:00.000Z';
const GATE = { state: 'complete', snapshot_hash: 'a'.repeat(64) };
const PR = { repo: REPO, number: 7, branch: 'topic', headSha: 'abc' };
const OWNER = {
	version: 1, repo: REPO, pr: 7, generation: 'generation-7', phase: 'running',
	controllerPid: null, watcherPid: 70, startedAt: NOW, updatedAt: NOW,
	heartbeatAt: NOW, terminalReceiptId: null, blockReason: null,
	legacyEvidenceHash: null,
};

test('default provider reads use the shared secure gh executable resolver', () => {
	const source = fs.readFileSync(path.resolve(__dirname, '../../lib/pr-monitor/reconcile-executor.js'), 'utf8');
	const start = source.indexOf('async function defaultReadProviderState');
	const end = source.indexOf('\nasync function ', start + 1);
	const providerReader = source.slice(start, end);

	expect(source).toContain("secureExecFileSync('gh'");
	expect(providerReader).toContain('githubRunner(opts)');
	expect(providerReader).not.toContain("execFileSync('gh'");
});

const temporaryRoots = [];
afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function daemonOptions(overrides = {}) {
	return {
		gitCommonDir: '/repo/.git',
		repo: REPO,
		acquire: () => ({ ok: true, token: 'lease-token' }),
		ownsLease: () => true,
		startHeartbeat: () => ({ timer: true }),
		stopHeartbeat: () => {},
		release: () => {},
		buildBroker: async () => ({
			broker: { close: async () => {} }, driver: {}, databaseConfig: {},
		}),
		migrateLegacyAuthority: async () => ({ ok: true, state: 'complete' }),
		exit: () => {},
		...overrides,
	};
}

describe('execute — owner-row watcher lifecycle', () => {
	test('rejects non-array actions with a distinct validation code', async () => {
		await expect(execute(null)).rejects.toMatchObject({ code: 'INVALID_ACTIONS' });
	});

	test('processes oversized action sets in bounded resumable batches', async () => {
		let writes = 0;
		const actions = Array.from({ length: 129 }, (_, number) => ({
			type: 'upsertPrRow', row: { repo: REPO, number: number + 1 },
		}));
		const result = await execute(actions, {
			broker: { upsertPr: async () => { writes += 1; } },
		});
		expect(result.ok).toBe(true);
		expect(writes).toBe(128);
		expect(result.results).toHaveLength(128);
	});

	test('reserves, spawns, and binds one exact upstream owner generation', async () => {
		const calls = [];
		const starting = { ...OWNER, phase: 'starting', controllerPid: 11, watcherPid: null };
		const authority = {
			reserveStarting: async (identity, input) => {
				calls.push(['reserve', identity, input.controllerPid]);
				return { ok: true, changed: true, record: starting };
			},
			bindRunning: async (identity, input) => {
				calls.push(['bind', identity, input]);
				return { ok: true, changed: true, record: { ...OWNER, watcherPid: input.pid } };
			},
		};
		const result = await execute([{ type: 'reserveWatcher', pr: PR }], {
			authority, controllerPid: 11, projectRoot: '/repo', gitCommonDir: '/repo/.git',
			spawnWatcher: async input => {
				calls.push(['spawn', input.repository, input.prNumber, input.reservation.record.generation]);
				return { started: true, pid: 70, generation: starting.generation };
			},
		});
		expect(result).toMatchObject({ ok: true, changed: true });
		expect(calls).toEqual([
			['reserve', { repo: REPO, pr: 7 }, 11],
			['spawn', REPO, 7, 'generation-7'],
			['bind', { repo: REPO, pr: 7 }, { generation: 'generation-7', controllerPid: 11, pid: 70 }],
		]);
	});

	test('aborts the exact starting row when detached launch fails', async () => {
		let aborted;
		const starting = { ...OWNER, phase: 'starting', controllerPid: 11, watcherPid: null };
		const result = await execute([{ type: 'reserveWatcher', pr: PR }], {
			controllerPid: 11,
			authority: {
				reserveStarting: async () => ({ ok: true, changed: true, record: starting }),
				abortStarting: async (identity, input) => {
					aborted = { identity, input };
					return { ok: true, changed: true, reason: 'aborted', record: null };
				},
			},
			spawnWatcher: async () => ({ started: false }),
		});
		expect(result.ok).toBe(true);
		expect(aborted).toEqual({
			identity: { repo: REPO, pr: 7 },
			input: { generation: 'generation-7', controllerPid: 11 },
		});
	});

	test('retries this daemon abandoned start by aborting before a new reservation and spawn', async () => {
		const calls = [];
		const abandoned = { ...OWNER, phase: 'starting', controllerPid: 11, watcherPid: null };
		const replacement = { ...abandoned, generation: 'generation-retry' };
		const result = await execute([{ type: 'retryStarting', owner: abandoned, pr: PR }], {
			controllerPid: 11,
			authority: {
				abortStarting: async (identity, input) => {
					calls.push(['abort', identity, input]);
					return { ok: true, changed: true, record: null };
				},
				reserveStarting: async (identity, input) => {
					calls.push(['reserve', identity, input]);
					return { ok: true, changed: true, record: replacement };
				},
				bindRunning: async (identity, input) => {
					calls.push(['bind', identity, input]);
					return { ok: true, changed: true, record: { ...replacement, phase: 'running', watcherPid: input.pid } };
				},
			},
			spawnWatcher: async () => ({ started: true, pid: 70 }),
		});

		expect(result.ok).toBe(true);
		expect(calls).toEqual([
			['abort', { repo: REPO, pr: 7 }, { generation: 'generation-7', controllerPid: 11 }],
			['reserve', { repo: REPO, pr: 7 }, { controllerPid: 11 }],
			['bind', { repo: REPO, pr: 7 }, { generation: 'generation-retry', controllerPid: 11, pid: 70 }],
		]);
	});

	test('does not reserve or spawn when the abandoned generation was not released', async () => {
		let continued = false;
		const abandoned = { ...OWNER, phase: 'starting', controllerPid: 11, watcherPid: null };
		const result = await execute([{ type: 'retryStarting', owner: abandoned, pr: PR }], {
			controllerPid: 11,
			authority: {
				abortStarting: async () => ({ ok: true, changed: false, reason: 'stale_evidence', record: abandoned }),
				reserveStarting: async () => { continued = true; },
			},
			spawnWatcher: async () => { continued = true; },
		});

		expect(result.results[0].result).toMatchObject({ changed: false, reason: 'stale_evidence' });
		expect(continued).toBe(false);
	});

	test('requests cooperative stop without invoking any process signal seam', async () => {
		let request;
		let signals = 0;
		const result = await execute([{ type: 'requestStop', owner: OWNER }], {
			authority: {
				requestStop: async (identity, input) => {
					request = { identity, input };
					return { ok: true, changed: true, record: { ...OWNER, phase: 'stop_requested' } };
				},
			},
			kill: () => { signals += 1; },
		});
		expect(result.ok).toBe(true);
		expect(signals).toBe(0);
		expect(request).toEqual({
			identity: { repo: REPO, pr: 7 },
			input: { generation: 'generation-7', pid: 70 },
		});
	});

	test('retries terminal completion through the durable receipt fence', async () => {
		let attempts = 0;
		const terminal = { ...OWNER, phase: 'terminal_pending', terminalReceiptId: 'receipt-7' };
		const authority = {
			completeTerminal: async (_identity, input) => {
				attempts += 1;
				expect(input).toEqual({ generation: 'generation-7', pid: 70, terminalReceiptId: 'receipt-7' });
				return attempts === 1
					? { ok: false, changed: false, reason: 'receipt_unverified', record: terminal }
					: { ok: true, changed: true, reason: 'complete', record: { ...terminal, phase: 'complete' } };
			},
		};
		expect((await execute([{ type: 'completeTerminal', owner: terminal }], { authority })).ok).toBe(false);
		expect((await execute([{ type: 'completeTerminal', owner: terminal }], { authority })).ok).toBe(true);
		expect(attempts).toBe(2);
	});

	test('upsert and retire use the Kernel broker without filesystem owner markers', async () => {
		const calls = [];
		const result = await execute([
			{ type: 'upsertPrRow', row: { repo: REPO, number: 7 } },
			{ type: 'retire', pr: PR },
		], {
			gitCommonDir: '/repo/.git', now: () => Date.parse(NOW),
			broker: {
				upsertPr: async row => { calls.push(['upsert', row]); },
				retirePr: async (identity, input) => { calls.push(['retire', identity, input]); },
			},
		});
		expect(result.ok).toBe(true);
		expect(calls).toEqual([
			['upsert', { repo: REPO, number: 7 }],
			['retire', { git_common_dir: '/repo/.git', repo: REPO, number: 7 }, { state: 'closed', retired_at: NOW }],
		]);
	});
});

describe('desired and observed authority discovery', () => {
	test('lists a high open-PR bound under the exact canonical upstream repository', async () => {
		const calls = [];
		const result = await gatherDesired('/repo/.git', {
			projectRoot: '/repo',
			runGh: args => {
				calls.push(args);
				if (args[0] === 'repo') return { nameWithOwner: REPO };
				return [{ number: 7, headRefName: 'topic', headRefOid: 'abc' }];
			},
			broker: { listOpenPrs: async () => [{
				repo: REPO, number: 7, issue_id: 'issue-7', worktree_id: 'tree-7', journal_ptr: 'journal-7',
			}] },
		});
		expect(result).toMatchObject({ listingOk: true, repositoryOk: true, repo: REPO });
		expect(result.openPrs).toEqual([{ ...PR, issueId: 'issue-7', worktreeId: 'tree-7', journalPtr: 'journal-7' }]);
		const list = calls.find(args => args[0] === 'pr');
		expect(Number(list[list.indexOf('--limit') + 1])).toBe(1001);
		expect(list).toEqual(expect.arrayContaining(['--repo', REPO]));
	});

	test('accepts exactly 1000 open PRs but fails closed on the 1001 sentinel', async () => {
		const listOpen = count => gatherDesired('/repo/.git', {
			repo: REPO,
			runGh: args => args[0] === 'pr'
				? Array.from({ length: count }, (_, index) => ({ number: index + 1, headRefName: `topic-${index + 1}`, headRefOid: `oid-${index + 1}` }))
				: { nameWithOwner: REPO },
		});
		const accepted = await listOpen(1000);
		expect(accepted).toMatchObject({ listingOk: true, repositoryOk: true });
		expect(accepted.openPrs).toHaveLength(1000);

		let reconcileCalled = false;
		const rejected = await convergeOnce('/repo', {
			gitCommonDir: '/repo/.git',
			gatherDesired: () => listOpen(1001),
			reconcile: () => { reconcileCalled = true; return { actions: [] }; },
		});
		expect(rejected).toMatchObject({ actions: [], listingOk: false });
		expect(reconcileCalled).toBe(false);
	});

	test('repository lookup or PR listing failure is fail-closed and performs no teardown', async () => {
		const malformed = await gatherDesired('/repo/.git', { runGh: () => ({ nameWithOwner: 'invalid' }) });
		expect(malformed).toMatchObject({ listingOk: false, repositoryOk: false, openPrs: [] });

		const unavailable = await gatherDesired('/repo/.git', {
			repo: REPO,
			runGh: () => { throw new Error('provider unavailable'); },
		});
		expect(unavailable).toMatchObject({ listingOk: false, repositoryOk: true, openPrs: [] });
	});

	test('never aliases same-number linkage from another repository', async () => {
		const result = await gatherDesired('/repo/.git', {
			repo: REPO,
			runGh: () => [{ number: 7, headRefName: 'topic', headRefOid: 'abc' }],
			broker: { listOpenPrs: async () => [{ repo: 'other/forge', number: 7, issue_id: 'wrong' }] },
		});
		expect(result.openPrs[0]).toMatchObject({ repo: REPO, number: 7, issueId: null });
	});

	test('enumerates owner rows before checking PID liveness outside SQLite', async () => {
		const order = [];
		const result = await gatherObserved('/repo/.git', null, {
			broker: { listOpenPrs: async () => [] },
			authority: {
				enumerateOwners: async () => { order.push('owners'); return { ok: true, records: [OWNER] }; },
				readMigrationGate: async () => { order.push('gate'); return { ok: true, gate: GATE }; },
			},
			isAlive: pid => { order.push(`pid:${pid}`); return true; },
			now: () => Date.parse(OWNER.heartbeatAt),
		});
		expect(order).toEqual(['owners', 'gate', 'pid:70']);
		expect(result).toMatchObject({ ownerRowsOk: true, migrationGate: GATE });
		expect(result.ownerRows[0]).toMatchObject({ watcherAlive: true });
	});

	test('treats a reused watcher PID as dead after its owner heartbeat expires', async () => {
		const heartbeatAt = Date.parse(OWNER.heartbeatAt);
		const result = await gatherObserved('/repo/.git', null, {
			broker: { listOpenPrs: async () => [] },
			authority: {
				enumerateOwners: async () => ({ ok: true, records: [OWNER] }),
				readMigrationGate: async () => ({ ok: true, gate: GATE }),
			},
			isAlive: () => true,
			now: () => heartbeatAt + 1_001,
			ownerHeartbeatStaleMs: 1_000,
		});
		expect(result.ownerRows[0]).toMatchObject({ watcherPid: 70, watcherAlive: false });
	});

	test('owner or gate enumeration failure remains unavailable instead of falling back to PID files', async () => {
		const result = await gatherObserved('/repo/.git', null, {
			broker: { listOpenPrs: async () => [] },
			authority: {
				enumerateOwners: async () => ({ ok: false, reason: 'authority_unavailable', records: [] }),
				readMigrationGate: async () => ({ ok: false, reason: 'authority_unavailable', gate: null }),
			},
		});
		expect(result).toMatchObject({ ownerRowsOk: false, ownerRows: [], migrationGate: null });
	});
});

describe('convergence and daemon retirement', () => {
	test('reports action execution failure so an empty daemon cannot retire', async () => {
		const result = await convergeOnce('/repo', {
			gitCommonDir: '/repo/.git',
			gatherDesired: async () => ({ openPrs: [], listingOk: true, repositoryOk: true }),
			gatherObserved: async () => ({ prRows: [], ownerRows: [], ownerRowsOk: true, migrationGate: GATE }),
			reconcile: () => ({ actions: [{ type: 'upsertPrRow', row: { repo: REPO, number: 7 } }] }),
			execute: async () => ({ ok: false, changed: false }),
			authority: { enumerateOwners: async () => ({ ok: true, records: [] }) },
		});
		expect(result).toMatchObject({ desiredCount: 0, authorityOk: true, activeOwnerCount: 0, executionOk: false });
	});

	test('a later pass recovers an abandoned start still owned by this live daemon', async () => {
		const starting = {
			...OWNER, phase: 'starting', controllerPid: 101, watcherPid: null,
			heartbeatAt: null, controllerAlive: true,
		};
		let actions = [];
		await convergeOnce('/repo', {
			gitCommonDir: '/repo/.git', controllerPid: 101,
			gatherDesired: async () => ({ openPrs: [PR], listingOk: true, repositoryOk: true }),
			gatherObserved: async () => ({
				prRows: [{ repo: REPO, number: 7, branch: 'topic', head_sha: 'abc' }],
				ownerRows: [starting], ownerRowsOk: true, migrationGate: GATE,
			}),
			execute: async value => { actions = value; return { ok: true, changed: true }; },
			authority: { enumerateOwners: async () => ({ ok: true, records: [starting] }) },
		});

		expect(actions).toContainEqual({ type: 'retryStarting', owner: starting, pr: PR });
	});

	test('foreign election loser exits before heartbeat, migration, or convergence', async () => {
		let touched = false;
		const result = await runDaemon('/repo', daemonOptions({
			acquire: () => ({ ok: false }),
			startHeartbeat: () => { touched = true; },
			migrateLegacyAuthority: async () => { touched = true; },
			convergeOnce: async () => { touched = true; },
		}));
		expect(result).toEqual({ ok: false, reason: 'foreign-lease' });
		expect(touched).toBe(false);
	});

	test('thrown migration failure retires the lease, heartbeat, and owned broker exactly once', async () => {
		let releases = 0;
		let heartbeats = 0;
		let closes = 0;
		const diagnostics = [];
		const failure = `migration exploded ${'x'.repeat(600)}`;
		let outcome;
		try {
			outcome = await runDaemon('/repo', daemonOptions({
				now: () => Date.parse(NOW),
				release: () => { releases += 1; },
				stopHeartbeat: () => { heartbeats += 1; },
				buildBroker: async () => ({
					broker: { close: async () => { closes += 1; } }, driver: {}, databaseConfig: {},
				}),
				migrateLegacyAuthority: async () => { throw new Error(failure); },
				writeDaemonDiagnostic: (_gitCommonDir, entry) => { diagnostics.push(entry); },
			}));
		} catch (error) {
			outcome = { threw: error.message };
		}

		expect({ outcome, releases, heartbeats, closes, diagnostics }).toEqual({
			outcome: { ok: false, reason: 'migration-failed' },
			releases: 1,
			heartbeats: 1,
			closes: 1,
			diagnostics: [{ kind: 'migration-failed', at: NOW, detail: failure.slice(0, 500) }],
		});
	});

	test('structured migration block keeps its reason and records only the blocked diagnostic', async () => {
		let releases = 0;
		const diagnostics = [];
		const result = await runDaemon('/repo', daemonOptions({
			now: () => Date.parse(NOW),
			release: () => { releases += 1; },
			migrateLegacyAuthority: async () => ({ ok: false, reason: 'legacy_owner_conflict' }),
			writeDaemonDiagnostic: (_gitCommonDir, entry) => { diagnostics.push(entry); },
		}));

		expect(result).toEqual({ ok: false, reason: 'legacy_owner_conflict' });
		expect(releases).toBe(1);
		expect(diagnostics).toEqual([{
			kind: 'migration-blocked', at: NOW, detail: 'legacy_owner_conflict',
		}]);
	});

	test('no desired PRs and no active owner rows retires the daemon lease', async () => {
		let releases = 0;
		let heartbeats = 0;
		const result = await runDaemon('/repo', daemonOptions({
			once: true,
			release: () => { releases += 1; },
			stopHeartbeat: () => { heartbeats += 1; },
			convergeOnce: async () => ({
				desiredCount: 0, authorityOk: true, activeOwnerCount: 0, executionOk: true,
			}),
		}));
		expect(result.ok).toBe(true);
		expect({ releases, heartbeats }).toEqual({ releases: 1, heartbeats: 1 });
	});

	test('active, blocked, or failed owner reconciliation retains the daemon lease', async () => {
		for (const convergence of [
			{ desiredCount: 0, authorityOk: true, activeOwnerCount: 1, executionOk: true },
			{ desiredCount: 0, authorityOk: false, activeOwnerCount: null, executionOk: true },
			{ desiredCount: 0, authorityOk: true, activeOwnerCount: 0, executionOk: false },
		]) {
			let releases = 0;
			await runDaemon('/repo', daemonOptions({
				once: true, release: () => { releases += 1; }, convergeOnce: async () => convergence,
			}));
			expect(releases).toBe(0);
		}
	});

	test('lease loss before a pass retires cooperatively without convergence', async () => {
		let passes = 0;
		let releases = 0;
		let exits = 0;
		const result = await runDaemon('/repo', daemonOptions({
			ownsLease: () => false,
			convergeOnce: async () => { passes += 1; },
			release: () => { releases += 1; },
			exit: () => { exits += 1; },
		}));
		expect(result).toMatchObject({ ok: true, retired: true });
		expect({ passes, releases, exits }).toEqual({ passes: 0, releases: 1, exits: 1 });
	});

	test('caller-owned broker is neither rebuilt nor closed during retirement', async () => {
		let builds = 0;
		let closes = 0;
		await runDaemon('/repo', daemonOptions({
			once: true,
			broker: { close: async () => { closes += 1; } },
			driver: {},
			buildBroker: async () => { builds += 1; return {}; },
			convergeOnce: async () => ({
				desiredCount: 0, authorityOk: true, activeOwnerCount: 0, executionOk: true,
			}),
		}));
		expect({ builds, closes }).toEqual({ builds: 0, closes: 0 });
	});
});

describe('daemon dispatch and diagnostics', () => {
	test('launches from the stable common root with detached hidden process options', () => {
		let spawnCall;
		let unref = false;
		const result = launchDaemon({
			projectRoot: '/repo/worktree', gitCommonDir: '/repo/.git',
			spawnProcess: (bin, args, options) => {
				spawnCall = { bin, args, options };
				return { pid: 99, on: () => {}, unref: () => { unref = true; } };
			},
		});
		expect(result).toMatchObject({ launched: true, via: 'detached', pid: 99 });
		expect(spawnCall.options).toMatchObject({ cwd: '/repo', detached: true, stdio: 'ignore', windowsHide: true });
		expect(spawnCall.args.slice(-2)).toEqual(['shepherd', 'daemon']);
		expect(unref).toBe(true);
	});

	test('uses a background-shell capability when available', () => {
		let call;
		const result = launchDaemon({
			projectRoot: '/repo/worktree', gitCommonDir: '/repo/.git',
			harness: { hasBgShell: true, runBgShell: (args, options) => { call = { args, options }; } },
		});
		expect(result).toEqual({ launched: true, via: 'bg-shell' });
		expect(call.options.cwd).toBe('/repo');
	});

	test('records bounded launch diagnostics without throwing', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-daemon-diagnostic-'));
		temporaryRoots.push(root);
		expect(writeDaemonDiagnostic(root, { kind: 'launch-failed', detail: 'boom' })).toBe(true);
		const line = fs.readFileSync(path.join(root, 'forge', 'shepherd-daemon.ndjson'), 'utf8').trim();
		expect(JSON.parse(line)).toEqual({ kind: 'launch-failed', detail: 'boom' });
	});

	test('fireAndForget is inert under containment guards and arbitrates one launch otherwise', () => {
		let acquires = 0;
		let launches = 0;
		const base = {
			projectRoot: '/repo', gitCommonDir: '/repo/.git', kernelInitialized: () => true,
			railEnabled: () => true,
			acquire: () => { acquires += 1; return { ok: true, token: 'token' }; },
			release: () => {}, launch: () => { launches += 1; },
			tick: ({ enumerate, execute: run }) => { enumerate(); run(); },
		};
		fireAndForget({ ...base, env: { CI: '1' } });
		expect({ acquires, launches }).toEqual({ acquires: 0, launches: 0 });
		fireAndForget({ ...base, env: {} });
		expect({ acquires, launches }).toEqual({ acquires: 1, launches: 1 });
	});

	test('fireAndForget launches without reclaiming legacy watcher evidence', () => {
		let releases = 0;
		let launches = 0;
		fireAndForget({
			projectRoot: '/repo', gitCommonDir: '/repo/.git', env: {},
			kernelInitialized: () => true, railEnabled: () => true,
			acquire: (_root, options) => {
				expect(options.preserveLegacy).toBe(true);
				return { ok: false, legacyMigrationPending: true };
			},
			release: () => { releases += 1; }, launch: () => { launches += 1; },
			tick: ({ enumerate, execute: run }) => { enumerate(); run(); },
		});
		expect({ releases, launches }).toEqual({ releases: 0, launches: 1 });
	});
});
