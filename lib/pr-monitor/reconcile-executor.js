'use strict';

/**
 * The IMPURE half of the autonomous shepherd reconciler (W-S4b, design §3/§4).
 *
 * W-S4a shipped the pure `reconcile(desired, observed, now)` and the `tick()`
 * debounce guard. This module is the thin, side-effecting dispatcher over them:
 * it gathers the two state sets (GitHub via `gh`, kernel via the broker), runs the
 * actions `reconcile()` emits (spawn/stop/reap watchers, upsert/retire kernel_pr
 * rows), owns the SINGLETON DAEMON lease lifecycle, and provides the per-command
 * `fireAndForget()` trigger wired into `bin/forge.js`.
 *
 * The NON-BLOCKING / ERROR-SWALLOWING contract is paramount: `fireAndForget()`
 * MUST never throw and never affect the command that triggered it (it is called
 * from a `finally` in the dispatch chokepoint). Every spawn is modeled on
 * `watch-lifecycle.startPrWatcherDetached` (detached, `stdio:'ignore'`,
 * `windowsHide:true`, `.unref()`, no-op `'error'` listener) so a failed launch
 * degrades to "not started" rather than crashing.
 *
 * SAFETY INVARIANTS (guarded by tests):
 *   - Orphan reaping NEVER `process.kill`s on a PID match alone. It re-verifies at
 *     kill time: the pid must be alive AND the journal start-time marker for that
 *     PR must still exist AND equal the watcher entry's `startedAt`. A null/legacy
 *     startedAt, or an absent/mismatched marker, means "do not kill" (PID reuse
 *     fail-safe) — the stale entry is dropped silently.
 *   - The singleton is arbitrated by the O_EXCL shepherd lease: a daemon that loses
 *     `acquire` exits immediately and spawns nothing.
 *   - Watcher launch classification branches on CAPABILITY presence
 *     (`ctx.harness.hasBgShell`), NEVER on harness name; uncertain → detached.
 *
 * @module pr-monitor/reconcile-executor
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const shepherdLease = require('./shepherd-lease');
const journal = require('./journal');
const { reconcile: defaultReconcile } = require('./reconcile');
const { tick: defaultTick } = require('./reconcile-tick');
const { startPrWatcherDetached, defaultResolveSlug, forgeBin } = require('./watch-lifecycle');
const brokerMod = require('../kernel/broker');

const { STALE_MS } = shepherdLease;

/** Normalize a lease watcher entry to the W-S4b `{pr, repo, pid, startedAt}` shape. */
function normalizeWatcher(entry) {
	if (typeof entry === 'number') return { pr: entry, repo: null, pid: null, startedAt: null };
	return {
		pr: entry.pr,
		repo: entry.repo ?? null,
		pid: entry.pid ?? null,
		startedAt: entry.startedAt ?? null,
	};
}

/** File that records a watcher's spawn-time ISO stamp for kill-time re-verification. */
function claimPath(dir) {
	return path.join(dir, 'watch.startedat');
}

/**
 * Write the start-time marker for `(repo, pr)` into its journal dir. This is the
 * kill-time re-verification token — orphan reaping refuses to kill a pid unless
 * this marker still equals the watcher entry's `startedAt`.
 */
function writeClaimMarker(projectRoot, repo, pr, startedAt) {
	if (repo == null || pr == null || startedAt == null) return;
	try {
		const dir = journal.journalDir({ root: projectRoot, repo, pr });
		fs.writeFileSync(claimPath(dir), String(startedAt));
	} catch {
		/* best-effort — a missing marker just means the pid is treated as unverifiable (never reaped) */
	}
}

/** Read the start-time marker for `(repo, pr)`, or null when absent/unreadable. */
function readClaimMarker(projectRoot, repo, pr) {
	if (repo == null || pr == null) return null;
	try {
		const dir = journal.journalDir({ root: projectRoot, repo, pr });
		return fs.readFileSync(claimPath(dir), 'utf8').trim();
	} catch {
		return null;
	}
}

/**
 * Gather the DESIRED open-PR set: GitHub's open PRs (`gh pr list`) enriched with
 * kernel linkage (issue/worktree/journal) where a `kernel_pr` row already exists.
 * A hand-opened PR with no kernel row is still included (issue_id/worktree_id
 * null) so the reconciler self-registers it — zero user invocation. External
 * fields (branch names) are stored raw and NEVER evaluated.
 */
async function gatherDesired(gitCommonDir, opts = {}) {
	const runGh = opts.runGh || ((args) => require('node:child_process').execFileSync('gh', args, {
		encoding: 'utf8', timeout: 30000, windowsHide: true,
	}));
	const broker = opts.broker || brokerMod;
	const repo = opts.repo || defaultResolveSlug({ cwd: opts.projectRoot || process.cwd() });

	let ghPrs = [];
	try {
		const raw = runGh(['pr', 'list', '--state', 'open', '--json', 'number,headRefName,headRefOid']);
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (Array.isArray(parsed)) ghPrs = parsed;
	} catch {
		ghPrs = [];
	}

	let prRows = [];
	try {
		prRows = await broker.listOpenPrs(gitCommonDir);
	} catch {
		/* kernel unavailable → treat as no linkage; the GitHub-driven desired set still stands */
	}
	const rowByNumber = new Map((Array.isArray(prRows) ? prRows : []).map((r) => [r.number, r]));

	const openPrs = ghPrs.map((p) => {
		const row = rowByNumber.get(p.number);
		return {
			repo,
			number: p.number,
			branch: p.headRefName ?? null,
			headSha: p.headRefOid ?? null,
			issueId: row?.issue_id ?? null,
			worktreeId: row?.worktree_id ?? null,
			journalPtr: row?.journal_ptr ?? null,
		};
	});
	return { openPrs, gitCommonDir };
}

/**
 * Gather the OBSERVED state: kernel `kernel_pr` rows, the lease watcher set, and
 * which of those watcher pids are actually alive (probed via `pidAlive`).
 */
async function gatherObserved(gitCommonDir, lock, opts = {}) {
	const broker = opts.broker || brokerMod;
	const isAlive = opts.isAlive || shepherdLease.pidAlive;
	const now = (opts.now || (() => Date.now()))();

	let prRows = [];
	try {
		prRows = await broker.listOpenPrs(gitCommonDir);
	} catch {
		/* kernel unavailable → observe an empty kernel set; reconcile still converges watchers */
	}

	const watchers = (lock && Array.isArray(lock.watchers) ? lock.watchers : []).map(normalizeWatcher);
	const liveWatcherPids = watchers
		.filter((w) => w.pid != null && isAlive(w.pid))
		.map((w) => ({ pid: w.pid, startedAt: w.startedAt ?? null }));

	const beat = lock ? Date.parse(lock.heartbeatAt) : NaN;
	const leaseFresh = Number.isFinite(beat) && (now - beat) < STALE_MS;

	return { lease: lock || null, leaseFresh, prRows: Array.isArray(prRows) ? prRows : [], liveWatcherPids };
}

/**
 * Kill a watcher pid ONLY after re-verifying start-time (design risk #4). Returns
 * true iff the kill actually happened. Never kills on a PID match alone.
 */
function verifiedKill(entry, ctx) {
	if (!entry || entry.pid == null || entry.startedAt == null) return false;
	const isAlive = ctx.isAlive || shepherdLease.pidAlive;
	if (!isAlive(entry.pid)) return false;
	const readClaim = ctx.readClaim || ((e) => readClaimMarker(ctx.projectRoot, e.repo, e.pr));
	const claim = readClaim(entry);
	if (claim == null || String(claim) !== String(entry.startedAt)) return false;
	try {
		(ctx.kill || process.kill)(entry.pid);
	} catch {
		return false;
	}
	return true;
}

/**
 * Dispatch a reconcile action set. Idempotent and order-free. Returns the updated
 * watcher entry list (`{pr,repo,pid,startedAt}[]`) for the caller to publish via
 * `updateWatchers`. `ctx.watchers` seeds the current set (from observed state).
 */
async function execute(actions, ctx = {}) {
	const broker = ctx.broker || brokerMod;
	const spawnWatcher = ctx.spawnWatcher || startPrWatcherDetached;
	const writeClaim = ctx.writeClaim || ((e) => writeClaimMarker(ctx.projectRoot, e.repo, e.pr, e.startedAt));
	const now = ctx.now || (() => Date.now());
	let watchers = Array.isArray(ctx.watchers) ? ctx.watchers.map(normalizeWatcher) : [];

	for (const action of (Array.isArray(actions) ? actions : [])) {
		if (action.type === 'startWatcher') {
			const startedAt = new Date(now()).toISOString();
			const repo = action.pr.repo ?? ctx.repo ?? null;
			const res = spawnWatcher({ prNumber: action.pr.number, cwd: ctx.projectRoot });
			const pid = res && res.pid != null ? res.pid : null;
			const entry = { pr: action.pr.number, repo, pid, startedAt };
			watchers.push(entry);
			if (pid != null) writeClaim(entry);
		} else if (action.type === 'stopWatcher') {
			for (const entry of watchers.filter((w) => w.pr === action.pr.number)) {
				verifiedKill(entry, ctx);
			}
			watchers = watchers.filter((w) => w.pr !== action.pr.number);
		} else if (action.type === 'reapOrphan') {
			const entry = watchers.find((w) => w.pid === action.pid && w.startedAt === action.startedAt);
			verifiedKill(entry, ctx);
			watchers = watchers.filter((w) => !(w.pid === action.pid && w.startedAt === action.startedAt));
		} else if (action.type === 'upsertPrRow') {
			try {
				await broker.upsertPr(action.row);
			} catch {
				/* derived reconcile state — a failed upsert retries on the next converge */
			}
		} else if (action.type === 'retire') {
			try {
				await broker.retirePr(
					{ git_common_dir: ctx.gitCommonDir, repo: action.pr.repo, number: action.pr.number },
					{ state: 'closed', retired_at: new Date(now()).toISOString() },
				);
			} catch {
				/* retried on the next converge */
			}
		}
	}
	return watchers;
}

/**
 * One converge pass: gather → reconcile → execute → publish watchers. Used by the
 * daemon loop and directly unit-testable with injected gather/reconcile/execute.
 * Returns `{ actions, watchers, desiredCount }`.
 */
async function convergeOnce(projectRoot, opts = {}) {
	const gitCommonDir = opts.gitCommonDir;
	const reconcile = opts.reconcile || defaultReconcile;
	const now = opts.now || (() => Date.now());
	const lock = opts.lock !== undefined ? opts.lock : null; // daemon threads the live lock in; default null

	const desired = opts.gatherDesired
		? await opts.gatherDesired()
		: await gatherDesired(gitCommonDir, { ...opts, projectRoot });
	const observed = opts.gatherObserved
		? await opts.gatherObserved()
		: await gatherObserved(gitCommonDir, lock, { ...opts, now });

	const { actions } = reconcile(desired, observed, now());
	const seedWatchers = observed.lease && Array.isArray(observed.lease.watchers)
		? observed.lease.watchers
		: (opts.watchers || []);
	const watchers = await execute(actions, {
		...opts,
		projectRoot,
		gitCommonDir,
		watchers: seedWatchers,
		now,
	});

	const updateWatchers = opts.updateWatchers || shepherdLease.updateWatchers;
	if (opts.token) {
		try {
			updateWatchers(projectRoot, watchers, { gitCommonDir, token: opts.token });
		} catch {
			/* publishing the watcher set is best-effort — the next pass re-derives it */
		}
	}
	return { actions, watchers, desiredCount: desired.openPrs.length };
}

/**
 * The singleton daemon: acquire the lease (exit if a live foreign owner holds it),
 * heartbeat, converge on a cadence, self-retire when no PRs remain. `opts.once`
 * runs a single converge (for tests); otherwise an interval loop + signal handlers.
 */
async function runDaemon(projectRoot, opts = {}) {
	const gitCommonDir = opts.gitCommonDir || brokerMod.resolveGitCommonDir(projectRoot);
	const acquire = opts.acquire || shepherdLease.acquire;
	const startHeartbeat = opts.startHeartbeat || shepherdLease.startHeartbeat;
	const stopHeartbeat = opts.stopHeartbeat || shepherdLease.stopHeartbeat;
	const release = opts.release || shepherdLease.release;

	const res = acquire(projectRoot, { gitCommonDir });
	if (!res.ok) {
		// A live, fresh foreign daemon owns this repo — exit immediately, spawn nothing.
		return { ok: false, reason: 'foreign-lease' };
	}
	const token = res.token;
	const heartbeat = startHeartbeat(projectRoot, { gitCommonDir, token });

	const convergeArgs = { ...opts, gitCommonDir, token };

	const retire = async () => {
		try {
			release(projectRoot, { gitCommonDir, token });
		} finally {
			stopHeartbeat(heartbeat);
		}
	};

	if (opts.once) {
		const conv = await convergeOnce(projectRoot, convergeArgs);
		if (conv.desiredCount === 0) await retire();
		return { ok: true, token, ...conv };
	}

	const intervalMs = opts.intervalMs || 60000;
	let stopped = false;
	const timer = setInterval(async () => {
		if (stopped) return;
		try {
			const conv = await convergeOnce(projectRoot, convergeArgs);
			if (conv.desiredCount === 0) {
				stopped = true;
				clearInterval(timer);
				await retire();
				if (opts.exit !== false) process.exit(0);
			}
		} catch {
			/* a bad converge pass never crashes the daemon — the next tick retries */
		}
	}, intervalMs);
	// The converge timer is intentionally left REF'd so it keeps the daemon process
	// alive between passes (the heartbeat timer is unref'd inside startHeartbeat).

	const onSignal = async () => { await retire(); if (opts.exit !== false) process.exit(0); };
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);

	return { ok: true, token, heartbeat, timer };
}

/**
 * Launch the singleton daemon. Classify the execution home by CAPABILITY presence
 * (`ctx.harness.hasBgShell`), NEVER by harness name; uncertain → detached spawn
 * modeled on `startPrWatcherDetached`. Never throws.
 */
function launchDaemon(ctx = {}) {
	const harness = ctx.harness || {};
	if (harness.hasBgShell && typeof harness.runBgShell === 'function') {
		try {
			harness.runBgShell([forgeBin(), 'shepherd', 'daemon']);
			return { launched: true, via: 'bg-shell' };
		} catch {
			/* fall through to the detached fail-safe */
		}
	}
	const spawnFn = ctx.spawnProcess || spawn;
	try {
		const child = spawnFn(
			process.execPath,
			[forgeBin(), 'shepherd', 'daemon'],
			{ cwd: ctx.projectRoot, detached: true, stdio: 'ignore', windowsHide: true },
		);
		if (child && typeof child.on === 'function') child.on('error', () => {});
		if (child && typeof child.unref === 'function') child.unref();
		return { launched: true, via: 'detached', pid: child && child.pid != null ? child.pid : null };
	} catch {
		return { launched: false };
	}
}

/** Empty enumeration for a cold-tick loser that lost the lease race (backs off). */
function emptyEnum(gitCommonDir) {
	return {
		desired: { openPrs: [], gitCommonDir },
		observed: { lease: null, leaseFresh: false, prRows: [], liveWatcherPids: [] },
	};
}

/**
 * The per-command / session-start trigger. Runs the `tick()` debounce; the hot
 * path (a fresh daemon lease) short-circuits in-process with a single lock read
 * and no spawn. Only on the cold (G3) path does it ARBITRATE via the O_EXCL lease:
 * the acquire-winner launches the singleton daemon (which does the real
 * `gh pr list` enumeration + converge), and a loser backs off — no spawn. The
 * arbitration lease is released immediately after launch so the spawned daemon can
 * take sole ownership; the daemon's own `acquire` is the final singleton authority,
 * so even a race that double-launches still yields exactly one live daemon.
 *
 * The gh enumeration deliberately lives in the DAEMON, not here, so this trigger
 * NEVER runs a blocking subprocess on the command's critical path.
 *
 * CONTRACT: never throws, never blocks (no await), never affects the command.
 */
function fireAndForget(ctx = {}) {
	try {
		// Operator kill-switch (agent-agnostic): a set FORGE_SHEPHERD_DISABLE turns the
		// autonomous trigger fully inert — no lease, no enumeration, no daemon spawn.
		if (process.env.FORGE_SHEPHERD_DISABLE) return;
		const projectRoot = ctx.projectRoot;
		if (!projectRoot) return;
		let gitCommonDir = ctx.gitCommonDir;
		if (!gitCommonDir) {
			try {
				gitCommonDir = brokerMod.resolveGitCommonDir(projectRoot);
			} catch {
				return;
			}
		}
		const acquire = ctx.acquire || shepherdLease.acquire;
		const release = ctx.release || shepherdLease.release;
		const launch = ctx.launch || launchDaemon;
		const tickFn = ctx.tick || defaultTick;

		let token = null;
		const enumerate = () => {
			// COLD path only: arbitrate the singleton. The O_EXCL acquire is the atomic
			// arbiter — exactly one concurrent trigger wins; the rest get {ok:false}.
			const res = acquire(projectRoot, { gitCommonDir });
			if (res.ok) token = res.token;
			return emptyEnum(gitCommonDir);
		};
		const execute = () => {
			if (token == null) return; // loser: no daemon launch
			try {
				launch({ ...ctx, projectRoot, gitCommonDir });
			} finally {
				// Hand the lease off to the spawned daemon by releasing our arbitration hold.
				try { release(projectRoot, { gitCommonDir, token }); } catch { /* best effort */ }
			}
		};

		tickFn({ gitCommonDir, now: ctx.now, enumerate, execute, minInterval: ctx.minInterval });
	} catch {
		/* NEVER affect the command result or exit code */
	}
}

module.exports = {
	normalizeWatcher,
	writeClaimMarker,
	readClaimMarker,
	gatherDesired,
	gatherObserved,
	verifiedKill,
	execute,
	convergeOnce,
	runDaemon,
	launchDaemon,
	fireAndForget,
};
