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
 * Remove the start-time marker for `(repo, pr)` when its watcher is stopped/reaped, so
 * a future PID reuse can't match a STALE marker and get treated as the live watcher.
 * Best-effort; a missing marker is fine (an unverifiable pid is never reaped anyway).
 */
function removeClaimMarker(projectRoot, repo, pr) {
	if (repo == null || pr == null) return;
	try {
		const dir = journal.journalDir({ root: projectRoot, repo, pr });
		fs.rmSync(claimPath(dir), { force: true });
	} catch {
		/* best-effort marker cleanup */
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
	// The broker is a live kernel handle from createLocalBroker (listOpenPrs/upsertPr/
	// retirePr are INSTANCE methods) — the daemon threads one in. Never fall back to the
	// broker MODULE namespace: those methods don't exist there and every call would
	// silently no-op behind the catch (this exact bug shipped once — keep it gone).
	const broker = opts.broker || null;
	const repo = opts.repo || defaultResolveSlug({ cwd: opts.projectRoot || process.cwd() });

	let ghPrs = [];
	// `listingOk` distinguishes "GitHub says zero open PRs" from "the gh call failed"
	// (network/auth/rate-limit). A FAILED listing must be a no-op upstream, never a
	// teardown of every watcher+row — the caller skips the reconcile pass when false.
	let listingOk = true;
	try {
		// `--limit 1000` overrides gh's default 30-result cap so a repo with >30 open
		// PRs is fully enumerated (otherwise the tail would go unwatched or get retired).
		const raw = runGh(['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,headRefName,headRefOid']);
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (Array.isArray(parsed)) ghPrs = parsed;
	} catch {
		ghPrs = [];
		listingOk = false;
	}

	let prRows = [];
	try {
		if (broker) prRows = await broker.listOpenPrs(gitCommonDir);
	} catch {
		/* kernel unavailable → treat as no linkage; the GitHub-driven desired set still stands */
	}
	// Key by (repo, number) — matches reconcile.js `keyOf` — so a repo rename that
	// leaves a same-number row under one git_common_dir can't attach the wrong repo's
	// linkage to the desired PR.
	const keyOf = (r, n) => `${r} ${n}`;
	const rowByKey = new Map((Array.isArray(prRows) ? prRows : []).map((r) => [keyOf(r.repo, r.number), r]));

	const openPrs = ghPrs.map((p) => {
		const row = rowByKey.get(keyOf(repo, p.number));
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
	return { openPrs, gitCommonDir, listingOk };
}

/**
 * Gather the OBSERVED state: kernel `kernel_pr` rows, the lease watcher set, and
 * which of those watcher pids are actually alive (probed via `pidAlive`).
 */
async function gatherObserved(gitCommonDir, lock, opts = {}) {
	const broker = opts.broker || null; // live kernel handle threaded by the daemon; never the module namespace
	const isAlive = opts.isAlive || shepherdLease.pidAlive;
	const readClaim = opts.readClaim || ((repo, pr) => readClaimMarker(opts.projectRoot, repo, pr));
	const now = (opts.now || (() => Date.now()))();

	let prRows = [];
	try {
		if (broker) prRows = await broker.listOpenPrs(gitCommonDir);
	} catch {
		/* kernel unavailable → observe an empty kernel set; reconcile still converges watchers */
	}

	const watchers = (lock && Array.isArray(lock.watchers) ? lock.watchers : []).map(normalizeWatcher);
	// A pid is "live" ONLY when it is alive AND its journal start-time marker still
	// equals the entry's startedAt — the SAME check verifiedKill makes at kill time.
	// A reused PID (alive, but a mismatched/absent marker) must NOT be reported live,
	// or reconcile would suppress the startWatcher and leave the PR unmonitored.
	const liveWatcherPids = watchers
		.filter((w) => {
			if (w.pid == null || !isAlive(w.pid)) return false;
			const marker = readClaim(w.repo, w.pr);
			return marker != null && String(marker) === String(w.startedAt);
		})
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
 * Per-action-type handlers, keyed by `action.type`. Extracted from `execute` so
 * each is small and independently testable and the dispatcher stays a flat loop
 * (keeps `execute`'s cognitive complexity under the SonarCloud gate). Each handler
 * mutates the shared `s` state (`s.watchers` is reassigned by stop/reap) and the
 * behavior is identical to the former if/else-if chain.
 */
const ACTION_HANDLERS = {
	startWatcher(action, s) {
		const startedAt = new Date(s.now()).toISOString();
		const repo = action.pr.repo ?? s.repo ?? null;
		const res = s.spawnWatcher({ prNumber: action.pr.number, cwd: s.projectRoot });
		const pid = res && res.pid != null ? res.pid : null;
		const entry = { pr: action.pr.number, repo, pid, startedAt };
		s.watchers.push(entry);
		if (pid != null) s.writeClaim(entry);
	},
	stopWatcher(action, s) {
		for (const entry of s.watchers.filter((w) => w.pr === action.pr.number)) {
			verifiedKill(entry, s.ctx);
			s.removeClaim(entry); // clear the start-time marker so a reused PID can't match it later
		}
		s.watchers = s.watchers.filter((w) => w.pr !== action.pr.number);
	},
	reapOrphan(action, s) {
		const entry = s.watchers.find((w) => w.pid === action.pid && w.startedAt === action.startedAt);
		verifiedKill(entry, s.ctx);
		if (entry) s.removeClaim(entry);
		s.watchers = s.watchers.filter((w) => !(w.pid === action.pid && w.startedAt === action.startedAt));
	},
	async upsertPrRow(action, s) {
		try {
			if (s.broker) await s.broker.upsertPr(action.row);
		} catch {
			/* derived reconcile state — a failed upsert retries on the next converge */
		}
	},
	async retire(action, s) {
		try {
			if (s.broker) await s.broker.retirePr(
				{ git_common_dir: s.gitCommonDir, repo: action.pr.repo, number: action.pr.number },
				{ state: 'closed', retired_at: new Date(s.now()).toISOString() },
			);
		} catch {
			/* retried on the next converge */
		}
	},
};

/**
 * Dispatch a reconcile action set. Idempotent and order-free. Returns the updated
 * watcher entry list (`{pr,repo,pid,startedAt}[]`) for the caller to publish via
 * `updateWatchers`. `ctx.watchers` seeds the current set (from observed state).
 */
async function execute(actions, ctx = {}) {
	const s = {
		broker: ctx.broker || null, // live kernel handle threaded by the daemon; never the module namespace
		spawnWatcher: ctx.spawnWatcher || startPrWatcherDetached,
		writeClaim: ctx.writeClaim || ((e) => writeClaimMarker(ctx.projectRoot, e.repo, e.pr, e.startedAt)),
		removeClaim: ctx.removeClaim || ((e) => removeClaimMarker(ctx.projectRoot, e.repo, e.pr)),
		now: ctx.now || (() => Date.now()),
		repo: ctx.repo,
		projectRoot: ctx.projectRoot,
		gitCommonDir: ctx.gitCommonDir,
		watchers: Array.isArray(ctx.watchers) ? ctx.watchers.map(normalizeWatcher) : [],
		ctx, // verifiedKill reads isAlive/readClaim/kill/projectRoot off the original ctx
	};

	for (const action of (Array.isArray(actions) ? actions : [])) {
		const handler = ACTION_HANDLERS[action && action.type];
		if (handler) await handler(action, s);
	}
	return s.watchers;
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

	// A FAILED gh listing (listingOk === false) is a transient outage, not "zero open
	// PRs". Skipping the reconcile+execute pass entirely makes it a true no-op — no
	// observe, no retire/stopWatcher teardown of every row+watcher. desiredCount is
	// left non-zero (null) so the daemon does NOT read it as "no PRs → self-retire".
	if (desired && desired.listingOk === false) {
		const keep = (lock && Array.isArray(lock.watchers)) ? lock.watchers : (opts.watchers || []);
		return { actions: [], watchers: keep, desiredCount: null, listingOk: false };
	}

	const observed = opts.gatherObserved
		? await opts.gatherObserved()
		: await gatherObserved(gitCommonDir, lock, { ...opts, now, projectRoot });

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

	let leaseLost = false;
	const updateWatchers = opts.updateWatchers || shepherdLease.updateWatchers;
	if (opts.token) {
		try {
			// updateWatchers returns false when the lock is gone or owned by a DIFFERENT
			// token — i.e. THIS daemon was superseded (its stale lease reclaimed by a newer
			// one). Signal the caller to stop: a superseded daemon must not keep spawning/
			// reaping watchers behind the live owner's back.
			const published = updateWatchers(projectRoot, watchers, { gitCommonDir, token: opts.token });
			if (published === false) leaseLost = true;
		} catch {
			/* publishing the watcher set is best-effort — the next pass re-derives it */
		}
	}
	return { actions, watchers, desiredCount: desired.openPrs.length, leaseLost };
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
	const converge = opts.convergeOnce || convergeOnce;
	const now = opts.now || (() => Date.now());
	// Injectable exit so a lifecycle test can assert the daemon actually exits
	// (finding 4). `opts.exit === false` keeps the process alive (legacy test mode).
	const exit = typeof opts.exit === 'function'
		? opts.exit
		: (opts.exit === false ? () => {} : (code) => process.exit(code));

	const res = acquire(projectRoot, { gitCommonDir });
	if (!res.ok) {
		// A live, fresh foreign daemon owns this repo — exit immediately, spawn nothing.
		return { ok: false, reason: 'foreign-lease' };
	}
	const token = res.token;
	const heartbeat = startHeartbeat(projectRoot, { gitCommonDir, token });

	// Build ONE real kernel broker for the daemon's lifetime — createLocalBroker-backed,
	// because listOpenPrs/upsertPr/retirePr are INSTANCE methods (the module namespace has
	// none). Injectable for tests via opts.broker/opts.buildBroker. `ownedDriver` is closed
	// on retire ONLY when we created it (Windows EBUSY guard — a leaked handle wedges the
	// sqlite file). A genuine build failure degrades to the watcher half (broker stays null).
	let broker = opts.broker || null;
	let ownedDriver = null;
	if (!broker) {
		try {
			const built = await (opts.buildBroker || defaultBuildBroker)({ projectRoot, gitCommonDir });
			broker = built.broker;
			ownedDriver = built.driver;
		} catch {
			/* kernel genuinely unavailable → run degraded (watcher convergence only) */
		}
	}

	const convergeArgs = { ...opts, gitCommonDir, token, broker };

	// retire() must NEVER throw: a release / stopHeartbeat / driver.close error must
	// not leave the daemon un-exited (finding 4). Each teardown step swallows its own
	// error so the caller's exit(0) always runs — no un-retired zombie.
	const retire = async () => {
		try { release(projectRoot, { gitCommonDir, token }); } catch { /* best effort */ }
		try { stopHeartbeat(heartbeat); } catch { /* best effort */ }
		if (ownedDriver && typeof ownedDriver.close === 'function') {
			try { ownedDriver.close(); } catch { /* best effort */ }
		}
	};

	if (opts.once) {
		const conv = await converge(projectRoot, convergeArgs);
		if (conv.desiredCount === 0) await retire();
		return { ok: true, token, ...conv };
	}

	const intervalMs = opts.intervalMs || 60000;
	let stopped = false;
	let inFlight = false;   // finding 5: re-entrancy guard — never run two passes at once
	let lastWatchers = [];  // finding 2: thread the live watcher set across passes
	let timer = null;

	const runPass = async () => {
		// A tick that fires while the previous pass is still in flight (converge slower
		// than intervalMs) returns immediately, so passes never race on start/stop/reap.
		if (stopped || inFlight) return;
		inFlight = true;
		try {
			// Thread the live watcher set + a fresh heartbeat stamp so gatherObserved
			// observes the REAL live set each pass (finding 2) — without this the daemon
			// saw lease:null every tick and re-started a watcher for every PR forever.
			const passLock = { watchers: lastWatchers, heartbeatAt: new Date(now()).toISOString() };
			const conv = await converge(projectRoot, { ...convergeArgs, lock: passLock });
			if (conv && Array.isArray(conv.watchers)) lastWatchers = conv.watchers;
			// Superseded: a newer daemon reclaimed our stale lease. Stop and exit — retire()
			// won't touch the foreign lock (release is token-guarded), so the new owner is
			// left intact; we just stop spawning/reaping behind it.
			if (conv && conv.leaseLost) {
				stopped = true;
				if (timer) clearInterval(timer);
				await retire();
				exit(0);
			} else if (conv && conv.desiredCount === 0) {
				stopped = true;
				if (timer) clearInterval(timer);
				await retire();
				exit(0);
			}
		} catch {
			/* a bad converge pass never crashes the daemon — the next tick retries */
		} finally {
			inFlight = false;
		}
	};

	// finding 3: converge IMMEDIATELY on cold start — don't idle for up to intervalMs.
	await runPass();
	if (stopped) return { ok: true, token, retired: true };

	timer = setInterval(runPass, intervalMs);
	// The converge timer is intentionally left REF'd so it keeps the daemon process
	// alive between passes (the heartbeat timer is unref'd inside startHeartbeat).

	const onSignal = async () => { await retire(); exit(0); };
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

/**
 * Build a live, migrated kernel broker (+ its owned driver) for the daemon. Uses the
 * same createLocalBroker-backed factory the CLI uses, so listOpenPrs/upsertPr/retirePr
 * are the real instance methods. The caller closes `driver` on retire.
 */
async function defaultBuildBroker({ projectRoot, gitCommonDir }) {
	const { buildMigratedKernelIssueDeps } = require('../kernel/cli-broker-factory');
	const deps = await buildMigratedKernelIssueDeps({ projectRoot, gitCommonDir });
	return { broker: deps.kernelBroker, driver: deps.kernelDriver };
}

/**
 * Whether the default-ON `rail.auto_shepherd` gate permits the autonomous trigger.
 * Reuses ship.js's `autoShepherdRailEnabled` — the SAME resolver `forge push`,
 * `forge ship`, and `forge shepherd adopt` honor — so one `forge gate disable
 * rail.auto_shepherd` turns the whole autonomous surface off. Lazy-required to keep
 * the per-command trigger cheap and avoid an eager/circular load; FAIL-OPEN (returns
 * enabled) if the resolver can't be read, and never throws.
 */
function railAutoShepherdEnabled(projectRoot) {
	try {
		return require('../commands/ship').autoShepherdRailEnabled(projectRoot);
	} catch {
		return true; // config unreadable → fail open (default-ON), never block the trigger's own path
	}
}

/**
 * True iff a kernel DB already exists for `projectRoot` — the SAME no-lazy-create
 * invariant `forge prime` honors (orientation.hasExistingKernelDb). The trigger must
 * CREATE NOTHING in an uninitialized or setup/init TARGET repo (else `setup --dry-run`
 * and `init` would sprout a shepherd.lock and pollute output). SILENT: a no-op `warn`
 * suppresses resolveGitCommonDir's fallback message on a non-git dir. Never throws.
 */
function kernelInitialized(projectRoot) {
	try {
		const { resolveKernelDatabasePath } = require('../kernel/cli-broker-factory');
		const dbPath = resolveKernelDatabasePath({ projectRoot, warn: () => {} });
		return !!dbPath && fs.existsSync(dbPath);
	} catch {
		return false;
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
		// A dry-run must have ZERO side effects, and the trigger must CREATE NOTHING in an
		// uninitialized / setup-or-init TARGET repo (no-lazy-create invariant, same as prime).
		// Both guards run BEFORE any git/lock touch so `setup --dry-run` / `init` stay
		// side-effect- AND output-clean (kernelInitialized is silent). Checked here, not the
		// caller, so every trigger site (dispatch, session-start) is covered uniformly.
		if (ctx.dryRun) return;
		if (!(ctx.kernelInitialized || kernelInitialized)(projectRoot)) return;
		// Config kill-switch (same gate ship/push/adopt honor): a maintainer who ran
		// `forge gate disable rail.auto_shepherd` gets a fully inert trigger — no lease,
		// no enumeration, no daemon spawn. Cheap + fail-open, inside the dispatch try.
		const railEnabled = ctx.railEnabled || railAutoShepherdEnabled;
		if (!railEnabled(projectRoot)) return;
		let gitCommonDir = ctx.gitCommonDir;
		if (!gitCommonDir) {
			try {
				gitCommonDir = brokerMod.resolveGitCommonDir(projectRoot, { warn: () => {} });
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
	defaultBuildBroker,
	fireAndForget,
};
