'use strict';

/**
 * The debounce / cost guard for the autonomous shepherd (W-S4 design §2).
 *
 * `tick()` is the cheap-path-first gate that fires from an arbitrary `forge`
 * command (W-S4b wires the call site). Its whole job is to make the HOT path — a
 * live daemon already converging — cost ~one `readFileSync` and return, so a
 * per-command trigger never regresses into a `gh` call per command.
 *
 * Three gates:
 *   G1  A fresh lease (heartbeat < STALE_MS) means a live daemon is converging —
 *       do NOTHING (no stat, no enumerate, no spawn).
 *   G2  The enumeration window (RECONCILE_MIN_INTERVAL) has not elapsed since the
 *       last cold tick — skip enumeration.
 *   G3  Cold tick: bump the sentinel mtime FIRST (throttle even if gh is slow),
 *       then run the INJECTED enumerate()+reconcile()+execute().
 *
 * The sentinel file `<gitCommonDir>/forge/shepherd.reconcile` is the throttle
 * stamp — its **mtime IS `last_enumerated_at`** (no content, no parse). It is a
 * SEPARATE file from the token-guarded lease payload precisely because a tick
 * fired by an arbitrary command does NOT hold the lease token and so cannot write
 * the lease (design correction #3) — but any process may bump this sentinel.
 *
 * This module does NOT spawn — `enumerate`/`execute`/`reconcile` are injected, so
 * the guard is fully testable with a fake clock + temp dir and 0 real I/O beyond
 * the lock read and sentinel stat/bump. The daemon executor + spawn wiring are
 * W-S4b.
 *
 * @module pr-monitor/reconcile-tick
 */

const fs = require('node:fs');
const path = require('node:path');
const { STALE_MS } = require('./shepherd-lease');
const { reconcile: defaultReconcile } = require('./reconcile');

/** Default minimum interval between cold enumerations, per repo (ms). */
const RECONCILE_MIN_INTERVAL = 60000;

/** Resolve the enumeration window, honoring the env override at call time (tests). */
function resolveMinInterval() {
	const override = Number(process.env.FORGE_RECONCILE_MIN_INTERVAL);
	return Number.isFinite(override) && override > 0 ? override : RECONCILE_MIN_INTERVAL;
}

function forgeDir(gitCommonDir) {
	return path.join(gitCommonDir, 'forge');
}
function lockPath(gitCommonDir) {
	return path.join(forgeDir(gitCommonDir), 'shepherd.lock');
}
function sentinelPath(gitCommonDir) {
	return path.join(forgeDir(gitCommonDir), 'shepherd.reconcile');
}

/** Read + parse the lock payload, or null when missing/unreadable/corrupt. */
function readLock(gitCommonDir) {
	try {
		return JSON.parse(fs.readFileSync(lockPath(gitCommonDir), 'utf8'));
	} catch {
		return null;
	}
}

/** Stat the sentinel, or null when it does not exist yet. */
function statSentinel(gitCommonDir) {
	try {
		return fs.statSync(sentinelPath(gitCommonDir));
	} catch {
		return null;
	}
}

/** Bump the sentinel mtime to `t` (create it if absent). mtime IS last_enumerated_at. */
function bumpSentinel(gitCommonDir, t) {
	const file = sentinelPath(gitCommonDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
	const secs = t / 1000;
	fs.utimesSync(file, secs, secs);
}

/**
 * Run one debounce tick. Returns `{ path: 'G1'|'G2'|'G3', actions? }` describing
 * which gate fired (the `actions` are the reconcile output on the G3 cold path).
 *
 * Injected seams (all keep the guard hermetic — no gh/spawn/clock of its own):
 *   now         () => ms          — clock (default Date.now)
 *   enumerate   () => {desired, observed}   — the expensive gh∩kernel gather (G3 only)
 *   execute     (actions) => void  — the action dispatcher (G3 only)
 *   reconcile   (desired, observed, now) => {actions}  — pure core (default: the real one)
 *   minInterval ms                 — enumeration window (default: env-or-60000)
 */
function tick({
	gitCommonDir,
	now = () => Date.now(),
	enumerate,
	execute,
	reconcile = defaultReconcile,
	minInterval = resolveMinInterval(),
} = {}) {
	const t = now();

	// G1 — a fresh lease means a live daemon is converging. Do NOTHING (hot path:
	// one readFileSync + JSON.parse, then return; no stat, no enumerate, no spawn).
	const lock = readLock(gitCommonDir);
	if (lock) {
		const beat = Date.parse(lock.heartbeatAt);
		if (Number.isFinite(beat) && (t - beat) < STALE_MS) {
			return { path: 'G1' };
		}
	}

	// G2 — the enumeration window has not elapsed since the last cold tick. Trust the
	// last enumeration; skip the expensive gather. (Daemon revive on this path is W-S4b.)
	const sentinelStat = statSentinel(gitCommonDir);
	if (sentinelStat && (t - sentinelStat.mtimeMs) < minInterval) {
		return { path: 'G2' };
	}

	// G3 — cold tick: no fresh lease AND the window elapsed. Bump the sentinel mtime
	// FIRST so the throttle holds even if the enumerate() gh call is slow, THEN run the
	// injected enumerate → reconcile → execute.
	bumpSentinel(gitCommonDir, t);
	const { desired, observed } = enumerate();
	const { actions } = reconcile(desired, observed, t);
	execute(actions);
	return { path: 'G3', actions };
}

module.exports = {
	tick,
	RECONCILE_MIN_INTERVAL,
	resolveMinInterval,
	lockPath,
	sentinelPath,
};
