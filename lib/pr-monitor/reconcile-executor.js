'use strict';

/**
 * The IMPURE half of the autonomous shepherd reconciler (W-S4b, design §3/§4).
 *
 * W-S4a shipped the pure `reconcile(desired, observed, now)` and the `tick()`
 * debounce guard. This module is the thin, side-effecting dispatcher over them:
 * it gathers the two state sets (GitHub via `gh`, kernel via the broker), runs the
 * actions `reconcile()` emits (spawn/stop/reap watchers, upsert/retire kernel_pr
 * rows), owns the SINGLETON DAEMON lease lifecycle, and provides the approved-seam
 * `fireAndForget()` trigger used by session-start, push, and ship.
 *
 * The NON-BLOCKING / ERROR-SWALLOWING contract is paramount: `fireAndForget()`
 * MUST never throw and never affect the command that triggered it. Every spawn is modeled on
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
const { createProcessState, reduceProcessLifecycle } = require('../../packages/flow');

const shepherdLease = require('./shepherd-lease');
const journal = require('./journal');
const { reconcile: defaultReconcile } = require('./reconcile');
const { tick: defaultTick } = require('./reconcile-tick');
const { startPrWatcherDetached, forgeBin } = require('./watch-lifecycle');
const brokerMod = require('../kernel/broker');

const { STALE_MS } = shepherdLease;
const CANONICAL_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GH_COMMAND_TIMEOUT_MS = 30_000;
const LINKAGE_FIELDS = ['issue_id', 'worktree_id', 'journal_ptr'];
const MAX_ACTIONS_PER_PASS = 128;
const MAX_PROCESS_EVENTS = 8;

function normalizeRepository(value) {
	return typeof value === 'string' && CANONICAL_REPOSITORY.test(value.trim())
		? value.trim().toLowerCase()
		: null;
}

/** Resolve the GitHub identity used by merge binding, never a bare repo basename. */
function resolveCanonicalRepository(runGh) {
	try {
		const raw = runGh(['repo', 'view', '--json', 'owner,name']);
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		const owner = parsed && parsed.owner && parsed.owner.login;
		const name = parsed && parsed.name;
		if (typeof owner !== 'string' || owner.trim() === '' || typeof name !== 'string' || name.trim() === '') return null;
		return normalizeRepository(`${owner}/${name}`);
	} catch {
		return null;
	}
}

/**
 * Persist the daemon's latest lifecycle outcome beside the lease. This status
 * file is deliberately separate from `shepherd.reconcile`: that sentinel's
 * mtime is the cold-trigger debounce clock and diagnostics must never move it.
 */
function writeDaemonDiagnostic(gitCommonDir, entry, opts = {}) {
	try {
		const file = path.join(gitCommonDir, 'forge', 'shepherd.status.json');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const now = opts.now || (() => Date.now());
		const payload = {
			...entry,
			pid: opts.pid ?? process.pid,
			at: new Date(now()).toISOString(),
		};
		fs.writeFileSync(file, `${JSON.stringify(payload)}\n`);
		return true;
	} catch {
		return false;
	}
}

/** Record through an injected test seam or the separate durable status file. */
function recordDaemonDiagnostic(opts, gitCommonDir, kind, detail) {
	const entry = {
		kind,
		...(detail ? { detail: (detail && detail.message) || String(detail) } : {}),
	};
	try {
		if (typeof opts.recordDiagnostic === 'function') opts.recordDiagnostic(entry);
		else writeDaemonDiagnostic(gitCommonDir, entry, { now: opts.now });
	} catch {
		/* diagnostics must never affect a command or daemon lifecycle */
	}
}

/** Normalize a lease watcher entry to the W-S4b `{pr, repo, pid, startedAt}` shape. */
function normalizeWatcher(entry) {
	if (typeof entry === 'number') return { pr: entry, repo: null, pid: null, startedAt: null };
	return {
		pr: entry.pr,
		repo: entry.repo ?? null,
		pid: entry.pid ?? null,
		startedAt: entry.startedAt ?? null,
		...(entry.lifecycle ? { lifecycle: structuredClone(entry.lifecycle) } : {}),
	};
}

function processIdentity(entry) {
	return `watcher:${entry.repo ?? 'unknown'}:${entry.pr}:${entry.pid}`;
}

function lifecycleOptions(entry) {
	return {
		processId: processIdentity(entry),
		clock: () => 0,
		graceMs: 30_000,
		maxAttempts: 1,
		maxElapsedMs: 86_400_000,
		maxEvents: MAX_PROCESS_EVENTS,
		maxHistory: MAX_PROCESS_EVENTS,
	};
}

function replayLifecycle(entry, now) {
	const options = lifecycleOptions(entry);
	const persisted = entry.lifecycle;
	const events = persisted?.events || [{
		id: `${options.processId}:start`,
		type: 'start',
		at: Number.isFinite(Date.parse(entry.startedAt)) ? Date.parse(entry.startedAt) : now,
	}];
	if (persisted && persisted.processId !== options.processId) {
		const error = new Error('Watcher lifecycle identity conflicts with watcher identity');
		error.code = 'IDENTITY_CONFLICT';
		throw error;
	}
	if (!Array.isArray(events) || events.length < 1 || events.length > MAX_PROCESS_EVENTS) {
		const error = new Error('Watcher lifecycle checkpoint is incomplete or exceeds its bound');
		error.code = 'LIFECYCLE_INCOMPLETE';
		throw error;
	}
	let state = createProcessState(options, 0);
	for (const event of events) {
		state = reduceProcessLifecycle(state, event, { ...options, now: event.at }).state;
	}
	if (persisted?.state && JSON.stringify(persisted.state) !== JSON.stringify(state)) {
		const error = new Error('Watcher lifecycle checkpoint conflicts with replayed state');
		error.code = 'IDENTITY_CONFLICT';
		throw error;
	}
	entry.lifecycle = { processId: options.processId, events: structuredClone(events), state };
	return entry;
}

function checkpointLifecycle(entry, event, s) {
	const options = lifecycleOptions(entry);
	const transition = reduceProcessLifecycle(entry.lifecycle.state, event, { ...options, now: event.at });
	entry.lifecycle = {
		processId: options.processId,
		events: [...entry.lifecycle.events, structuredClone(event)],
		state: transition.state,
	};
	if (s.persistLifecycleCheckpoint(s.watchers) === false) {
		const error = new Error('Watcher lifecycle checkpoint persistence failed');
		error.code = 'PROVIDER_UNAVAILABLE';
		throw error;
	}
	s.onLifecycleCheckpoint(structuredClone(entry.lifecycle));
}

function lifecycleEvent(entry, type, at, extra = {}) {
	return {
		id: `${entry.lifecycle.processId}:${entry.lifecycle.events.length}:${type}`,
		type,
		at,
		...extra,
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
function writeClaimMarker(projectRoot, repo, pr, startedAt, gitCommonDir) {
	if (repo == null || pr == null || startedAt == null) return;
	try {
		const dir = journal.journalDir({ root: projectRoot, gitCommonDir, repo, pr });
		fs.writeFileSync(claimPath(dir), String(startedAt));
	} catch {
		/* best-effort — a missing marker just means the pid is treated as unverifiable (never reaped) */
	}
}

/** Read the start-time marker for `(repo, pr)`, or null when absent/unreadable. */
function readClaimMarker(projectRoot, repo, pr, gitCommonDir) {
	if (repo == null || pr == null) return null;
	try {
		const dir = journal.journalDir({ root: projectRoot, gitCommonDir, repo, pr });
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
function removeClaimMarker(projectRoot, repo, pr, gitCommonDir) {
	if (repo == null || pr == null) return;
	try {
		const dir = journal.journalDir({ root: projectRoot, gitCommonDir, repo, pr });
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
		cwd: opts.projectRoot || process.cwd(), encoding: 'utf8', timeout: GH_COMMAND_TIMEOUT_MS, windowsHide: true,
	}));
	// The broker is a live kernel handle from createLocalBroker (listOpenPrs/upsertPr/
	// retirePr are INSTANCE methods) — the daemon threads one in. Never fall back to the
	// broker MODULE namespace: those methods don't exist there and every call would
	// silently no-op behind the catch (this exact bug shipped once — keep it gone).
	const broker = opts.broker || null;
	// Explicit repo injection remains a test/programmatic seam. Production resolves the
	// owner/name pair from GitHub; a bare basename is never inferred from a failed lookup.
	const suppliedRepo = typeof opts.repo === 'string' && opts.repo.trim() ? opts.repo.trim() : null;
	const repo = suppliedRepo || resolveCanonicalRepository(runGh);

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

	if (!repo) return { openPrs: [], gitCommonDir, listingOk: false, repositoryOk: false };

	let prRows = [];
	try {
		if (broker) prRows = await broker.listOpenPrs(gitCommonDir);
	} catch {
		/* kernel unavailable → treat as no linkage; the GitHub-driven desired set still stands */
	}
	// Key by canonical (repo, number). A single bare-name row is accepted
	// only as a one-way compatibility bridge; it is rewritten under the canonical key
	// and retired by the same reconcile pass. The common-dir natural key plus an exact
	// basename/number match preserves links across force-pushes; cross-repository,
	// ambiguous, and other malformed rows never bind.
	const canonicalRepo = normalizeRepository(repo);
	const legacyRepo = canonicalRepo ? canonicalRepo.slice(canonicalRepo.lastIndexOf('/') + 1) : null;
	const validPrNumber = (value) => (Number.isSafeInteger(value) && value > 0)
		|| (typeof value === 'string' && /^[1-9][0-9]*$/.test(value));
	const rows = Array.isArray(prRows) ? prRows : [];
	if (canonicalRepo) {
		const counts = new Map();
		const conflicting = rows.some((row) => {
			if (!row || !validPrNumber(row.number)) return true;
			const rowRepo = normalizeRepository(row.repo);
			const canonical = rowRepo === canonicalRepo;
			const legacy = typeof row.repo === 'string' && row.repo.trim().toLowerCase() === legacyRepo;
			if (!canonical && !legacy) return true;
			const number = String(row.number);
			const count = counts.get(number) || { canonical: 0, legacy: 0 };
			if (canonical) count.canonical += 1;
			else count.legacy += 1;
			counts.set(number, count);
			return count.canonical > 1 || count.legacy > 1;
		});
		if (conflicting) return { openPrs: [], gitCommonDir, listingOk: false, repositoryOk: false };
	}
	const exactRows = new Map();
	const legacyRows = new Map();
	const add = (map, number, row) => {
		if (!validPrNumber(number)) return;
		const list = map.get(String(number)) || [];
		list.push(row);
		map.set(String(number), list);
	};
	for (const row of rows) {
		if (canonicalRepo && normalizeRepository(row && row.repo) === canonicalRepo) add(exactRows, row.number, row);
		else if (legacyRepo && row && typeof row.repo === 'string' && row.repo.trim().toLowerCase() === legacyRepo) add(legacyRows, row.number, row);
		else if (!canonicalRepo && row && row.repo === repo) add(exactRows, row.number, row);
	}
	const coalesceLinkage = (canonical, legacy) => {
		if (!canonical || !legacy) return canonical || legacy || null;
		const merged = { ...canonical };
		for (const field of LINKAGE_FIELDS) {
			const canonicalValue = canonical[field] ?? null;
			const legacyValue = legacy[field] ?? null;
			if (canonicalValue != null && legacyValue != null && canonicalValue !== legacyValue) return null;
			if (canonicalValue == null && legacyValue != null) merged[field] = legacyValue;
		}
		return merged;
	};
	const mergedRows = new Map();
	for (const number of new Set([...exactRows.keys(), ...legacyRows.keys()])) {
		const exact = exactRows.get(number) || [];
		const legacy = legacyRows.get(number) || [];
		const merged = coalesceLinkage(exact[0], legacy[0]);
		if (exact.length > 0 && legacy.length > 0 && !merged) {
			return { openPrs: [], gitCommonDir, listingOk: false, repositoryOk: false };
		}
		if (merged) mergedRows.set(number, merged);
	}
	const rowForPr = (p) => {
		if (canonicalRepo) return mergedRows.get(String(p.number)) || null;
		const exact = exactRows.get(String(p.number)) || [];
		return exact.length === 1 ? exact[0] : null;
	};

	const openPrs = ghPrs.map((p) => {
		const row = rowForPr(p);
		return {
			repo: canonicalRepo || repo,
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
	const readClaim = opts.readClaim
		|| ((repo, pr) => readClaimMarker(opts.projectRoot, repo, pr, gitCommonDir));
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
	const readClaim = ctx.readClaim
		|| ((e) => readClaimMarker(ctx.projectRoot, e.repo, e.pr, ctx.gitCommonDir));
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
		const startedAtMs = s.now();
		const startedAt = new Date(startedAtMs).toISOString();
		const repo = action.pr.repo ?? s.repo ?? null;
		if (s.persistLifecycleCheckpoint(s.watchers) === false) {
			const error = new Error('Watcher lifecycle checkpoint persistence failed');
			error.code = 'PROVIDER_UNAVAILABLE';
			throw error;
		}
		const res = s.spawnWatcher({
			prNumber: action.pr.number, cwd: s.projectRoot, gitCommonDir: s.gitCommonDir,
		});
		const pid = res && res.pid != null ? res.pid : null;
		// A pid-less result means the watcher is already running (ship/push/adopt started it,
		// startPrWatcherDetached → {started:false, reason:'already-running'}) or the spawn
		// failed. Do NOT record a {pid:null} entry: gatherObserved never counts it live, so
		// each interval would re-emit startWatcher and append another null entry forever.
		if (pid == null) return;
		const entry = replayLifecycle({ pr: action.pr.number, repo, pid, startedAt }, startedAtMs);
		s.watchers.push(entry);
		if (s.persistLifecycleCheckpoint(s.watchers) === false) {
			const error = new Error('Watcher lifecycle checkpoint persistence failed');
			error.code = 'PROVIDER_UNAVAILABLE';
			throw error;
		}
		s.onLifecycleCheckpoint(structuredClone(entry.lifecycle));
		s.writeClaim(entry);
	},
	stopWatcher(action, s) {
		for (const entry of s.watchers.filter((w) => w.pr === action.pr.number)) {
			const at = s.now();
			if (entry.lifecycle.state.phase === 'RUNNING') {
				checkpointLifecycle(entry, lifecycleEvent(entry, 'cancel-requested', at), s);
				verifiedKill(entry, s.ctx);
				continue;
			}
			const isAlive = s.ctx.isAlive || shepherdLease.pidAlive;
			if (isAlive(entry.pid)) continue;
			if (entry.lifecycle.state.phase !== 'CANCEL_REQUESTED') continue;
			checkpointLifecycle(entry, lifecycleEvent(entry, 'cancel-acknowledged', at), s);
			checkpointLifecycle(entry, lifecycleEvent(entry, 'reap', at, { childReaped: true }), s);
			s.removeClaim(entry); // clear the start-time marker so a reused PID can't match it later
		}
		s.watchers = s.watchers.filter((w) => w.pr !== action.pr.number || !w.lifecycle.state.terminal);
	},
	reapOrphan(action, s) {
		const entry = s.watchers.find((w) => w.pid === action.pid && w.startedAt === action.startedAt);
		if (!entry) return;
		const at = s.now();
		if (entry.lifecycle.state.phase === 'RUNNING') {
			checkpointLifecycle(entry, lifecycleEvent(entry, 'orphan-detected', at), s);
			verifiedKill(entry, s.ctx);
			return;
		}
		const isAlive = s.ctx.isAlive || shepherdLease.pidAlive;
		if (isAlive(entry.pid) || entry.lifecycle.state.phase !== 'ORPHANED') return;
		checkpointLifecycle(entry, lifecycleEvent(entry, 'termination-acknowledged', at), s);
		checkpointLifecycle(entry, lifecycleEvent(entry, 'reap', at, { childReaped: true }), s);
		s.removeClaim(entry);
		s.watchers = s.watchers.filter((w) => w !== entry);
	},
	async upsertPrRow(action, s) {
		try {
			if (!s.broker) return true;
			const result = await s.broker.upsertPr(action.row);
			return result !== false && !(result && result.ok === false);
		} catch {
			/* derived reconcile state — a failed upsert retries on the next converge */
			return false;
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
 * Dispatch a reconcile action set in order. A failed kernel upsert stops the pass so
 * dependent retire actions retry on the next converge. Returns the updated
 * watcher entry list (`{pr,repo,pid,startedAt}[]`) for the caller to publish via
 * `updateWatchers`. `ctx.watchers` seeds the current set (from observed state).
 */
async function execute(actions, ctx = {}) {
	if (!Array.isArray(actions) || actions.length > MAX_ACTIONS_PER_PASS) {
		const error = new Error(`Reconcile action set must contain at most ${MAX_ACTIONS_PER_PASS} actions`);
		error.code = 'ACTION_BOUND_EXCEEDED';
		throw error;
	}
	const now = ctx.now || (() => Date.now());
	const watchers = Array.isArray(ctx.watchers)
		? ctx.watchers.map(normalizeWatcher).map(entry => replayLifecycle(entry, now()))
		: [];
	const s = {
		broker: ctx.broker || null, // live kernel handle threaded by the daemon; never the module namespace
		spawnWatcher: ctx.spawnWatcher || startPrWatcherDetached,
		writeClaim: ctx.writeClaim
			|| ((e) => writeClaimMarker(ctx.projectRoot, e.repo, e.pr, e.startedAt, ctx.gitCommonDir)),
		removeClaim: ctx.removeClaim
			|| ((e) => removeClaimMarker(ctx.projectRoot, e.repo, e.pr, ctx.gitCommonDir)),
		now,
		onLifecycleCheckpoint: ctx.onLifecycleCheckpoint || (() => {}),
		persistLifecycleCheckpoint: ctx.persistLifecycleCheckpoint || (() => true),
		repo: ctx.repo,
		projectRoot: ctx.projectRoot,
		gitCommonDir: ctx.gitCommonDir,
		watchers,
		ctx, // verifiedKill reads isAlive/readClaim/kill/projectRoot off the original ctx
	};

	for (const action of (Array.isArray(actions) ? actions : [])) {
		const handler = ACTION_HANDLERS[action && action.type];
		if (handler && (await handler(action, s)) === false) break;
	}
	return s.watchers;
}

function checkpointWriter(opts, updateWatchers, projectRoot, gitCommonDir) {
	if (opts.persistLifecycleCheckpoint) return opts.persistLifecycleCheckpoint;
	if (!opts.token) return undefined;
	return current => updateWatchers(projectRoot, current, { gitCommonDir, token: opts.token });
}

async function executeConvergedActions(actions, seedWatchers, projectRoot, gitCommonDir, now, opts, updateWatchers) {
	try {
		const watchers = await execute(actions, {
			...opts,
			projectRoot,
			gitCommonDir,
			watchers: seedWatchers,
			now,
			persistLifecycleCheckpoint: checkpointWriter(opts, updateWatchers, projectRoot, gitCommonDir),
		});
		return { watchers, leaseLost: false };
	} catch (error) {
		if (opts.token && error?.code === 'PROVIDER_UNAVAILABLE') {
			return { watchers: seedWatchers, leaseLost: true };
		}
		throw error;
	}
}

function publishWatcherSet(watchers, projectRoot, gitCommonDir, opts, updateWatchers) {
	if (!opts.token) return false;
	try {
		return updateWatchers(projectRoot, watchers, { gitCommonDir, token: opts.token }) === false;
	} catch {
		return false;
	}
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
	const updateWatchers = opts.updateWatchers || shepherdLease.updateWatchers;
	const executed = await executeConvergedActions(
		actions, seedWatchers, projectRoot, gitCommonDir, now, opts, updateWatchers,
	);
	if (executed.leaseLost) {
		return { actions: [], watchers: seedWatchers, desiredCount: desired.openPrs.length, leaseLost: true };
	}
	const { watchers } = executed;

	const leaseLost = publishWatcherSet(watchers, projectRoot, gitCommonDir, opts, updateWatchers);
			// updateWatchers returns false when the lock is gone or owned by a DIFFERENT
			// token — i.e. THIS daemon was superseded (its stale lease reclaimed by a newer
			// one). Signal the caller to stop: a superseded daemon must not keep spawning/
			// reaping watchers behind the live owner's back.

			/* publishing the watcher set is best-effort — the next pass re-derives it */
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
	// Tests that replace acquisition own the matching ownership seam as well.
	// Production always verifies the real shared lock by exact pid+token.
	const ownsLease = opts.ownsLease
		|| (opts.acquire ? (() => true) : shepherdLease.owns);
	// Injectable exit so a lifecycle test can assert the daemon actually exits
	// (finding 4). `opts.exit === false` keeps the process alive (legacy test mode).
	const exit = typeof opts.exit === 'function'
		? opts.exit
		: (opts.exit === false ? () => {} : (code) => process.exit(code));

	const res = acquire(projectRoot, { gitCommonDir });
	if (!res.ok) {
		exit(0);
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
		if (conv.desiredCount === 0) {
			recordDaemonDiagnostic(opts, gitCommonDir, 'retired-no-open-prs');
			await retire();
		}
		return { ok: true, token, ...conv };
	}

	const intervalMs = opts.intervalMs || 60000;
	let stopped = false;
	let inFlight = false;   // finding 5: re-entrancy guard — never run two passes at once
	let lastWatchers = [];  // finding 2: thread the live watcher set across passes
	let timer = null;

	const retireForLeaseLoss = async () => {
		stopped = true;
		if (timer) clearInterval(timer);
		recordDaemonDiagnostic(opts, gitCommonDir, 'lease-lost');
		await retire();
		exit(0);
	};

	const stillOwnsLease = () => {
		try {
			return ownsLease(projectRoot, { gitCommonDir, token });
		} catch {
			return false;
		}
	};

	const runPass = async () => {
		// A tick that fires while the previous pass is still in flight (converge slower
		// than intervalMs) returns immediately, so passes never race on start/stop/reap.
		if (stopped || inFlight) return;
		if (!stillOwnsLease()) {
			await retireForLeaseLoss();
			return;
		}
		inFlight = true;
		try {
			// Thread the live watcher set + a fresh heartbeat stamp so gatherObserved
			// observes the REAL live set each pass (finding 2) — without this the daemon
			// saw lease:null every tick and re-started a watcher for every PR forever.
			const passLock = { watchers: lastWatchers, heartbeatAt: new Date(now()).toISOString() };
			const conv = await converge(projectRoot, { ...convergeArgs, lock: passLock });
			if (!stillOwnsLease()) {
				await retireForLeaseLoss();
				return;
			}
			if (conv && Array.isArray(conv.watchers)) lastWatchers = conv.watchers;
			// Superseded: a newer daemon reclaimed our stale lease. Stop and exit — retire()
			// won't touch the foreign lock (release is token-guarded), so the new owner is
			// left intact; we just stop spawning/reaping behind it.
			if (conv && conv.leaseLost) {
				await retireForLeaseLoss();
			} else if (conv && conv.desiredCount === 0) {
				stopped = true;
				if (timer) clearInterval(timer);
				recordDaemonDiagnostic(opts, gitCommonDir, 'retired-no-open-prs');
				await retire();
				exit(0);
			}
		} catch (error) {
			recordDaemonDiagnostic(opts, gitCommonDir, 'converge-failed', error);
			if (!stillOwnsLease()) await retireForLeaseLoss();
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
	const commonRoot = path.basename(ctx.gitCommonDir || '').toLowerCase() === '.git'
		? path.dirname(ctx.gitCommonDir)
		: ctx.projectRoot;
	if (harness.hasBgShell && typeof harness.runBgShell === 'function') {
		try {
			harness.runBgShell([process.execPath, forgeBin(), 'shepherd', 'daemon'], { cwd: commonRoot });
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
			{ cwd: commonRoot, detached: true, stdio: 'ignore', windowsHide: true },
		);
		if (child && typeof child.on === 'function') {
			child.on('error', (error) => {
				recordDaemonDiagnostic(ctx, ctx.gitCommonDir, 'launch-failed', error);
			});
		}
		if (child && typeof child.unref === 'function') child.unref();
		return { launched: true, via: 'detached', pid: child && child.pid != null ? child.pid : null };
	} catch (error) {
		recordDaemonDiagnostic(ctx, ctx.gitCommonDir, 'launch-failed', error);
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
		// Resolve the git-common-dir with a FAST, SUBPROCESS-FREE read — NEVER `git
		// rev-parse` (its 30s timeout would block every registry command on the dispatch
		// finally, and a git subprocess pollutes bare-repo command tests). Common checkout:
		// <root>/.git is a dir. Linked worktree: <root>/.git is a file `gitdir: …/worktrees/x`
		// whose common dir is the part before `/worktrees/`.
		const gitPath = path.join(projectRoot, '.git');
		const st = fs.statSync(gitPath); // throws if absent → not a repo → false
		let commonDir;
		if (st.isDirectory()) {
			commonDir = gitPath;
		} else {
			const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitPath, 'utf8'));
			if (!m) return false;
			const wtGitDir = path.resolve(projectRoot, m[1].trim());
			const marker = `${path.sep}worktrees${path.sep}`;
			const idx = wtGitDir.lastIndexOf(marker);
			commonDir = idx >= 0 ? wtGitDir.slice(0, idx) : wtGitDir;
		}
		return fs.existsSync(path.join(commonDir, 'forge', 'kernel.sqlite'));
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
 * The session-start / successful-push / successful-ship trigger. Runs the `tick()` debounce; the hot
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
		const env = ctx.env || process.env;
		// Operator kill-switch (agent-agnostic): a set FORGE_SHEPHERD_DISABLE turns the
		// autonomous trigger fully inert — no lease, no enumeration, no daemon spawn.
		if (
			env.FORGE_SHEPHERD_DISABLE
			|| env.NODE_ENV === 'test'
			|| env.BUN_ENV === 'test'
			|| env.CI
			|| env.GITHUB_ACTIONS
			|| env.GITLAB_CI
		) return;
		const projectRoot = ctx.projectRoot;
		if (!projectRoot) return;
		// A dry-run must have ZERO side effects, and the trigger must CREATE NOTHING in an
		// uninitialized / setup-or-init TARGET repo (no-lazy-create invariant, same as prime).
		// Both guards run BEFORE any git/lock touch so `setup --dry-run` / `init` stay
		// side-effect- AND output-clean (kernelInitialized is silent). Checked here, not the
		// caller, so every approved trigger site is covered uniformly.
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
			// RELEASE the arbitration lease BEFORE launching so the spawned daemon can
			// acquire it. Holding it during launch races the child's runDaemon().acquire():
			// the child would see a fresh foreign owner and exit, and after we then release,
			// the bumped cold-tick sentinel suppresses re-launch until the next throttle
			// window — leaving NO daemon running.
			const held = token;
			token = null;
			try { release(projectRoot, { gitCommonDir, token: held }); } catch { /* best effort */ }
			try { launch({ ...ctx, projectRoot, gitCommonDir }); } catch { /* best effort */ }
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
	writeDaemonDiagnostic,
	defaultBuildBroker,
	fireAndForget,
};
